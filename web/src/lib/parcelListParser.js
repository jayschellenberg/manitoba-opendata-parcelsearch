/*
 * Parser for parcel-list imports. Accepts a tab / comma / space
 * separated paste or CSV/TSV upload of columns drawn from:
 *   - Roll #
 *   - Muni #  (numeric assessment code)
 *   - Municipality (name)  (e.g. "RM OF SPRINGFIELD" — sales-export shape)
 *   - Legal description (grid or lot-block-plan form)
 *   - Title # (certificate of title)
 *
 * Multi-parcel sales (one row whose Municipality / Roll / Legal cells
 * hold several newline- or pipe-separated values) are reconstructed and
 * expanded into one row per parcel, tagged with a shared group id.
 *
 * Field types are auto-detected from header text + per-cell content
 * shape. Callers (the import modal) confirm the mapping before the
 * resolver consumes it, so every guess can be overridden.
 *
 * Pipeline:
 *   parseParcelList(text)
 *     → { headers, columns, guesses, rawLines, delimiter }
 *   applyMapping(parsed, mapping, { canonicalRoll })
 *     → { rows: [{ lineNo, roll, muniNo, legal, title, raw }], issues }
 *
 * The resolver in main.js consumes `rows` and emits parcelKeys for
 * searchParcels({ parcelKeys }) — the same Roll Entry path runSearch
 * already uses when the legal-index search produces hits.
 */

import { tokenizeRows, tokenizeRowsFixedWidth } from './delimitedRows.js';

// ---- regexes ------------------------------------------------------

/** Manitoba township grid: e.g. "NW26-2-13E", "SW25-13-2W". */
const GRID_RE = /^([NS][EW])(\d{1,2})-(\d{1,3})-(\d{1,3})([EW])$/i;

/** Lot-block-plan: e.g. "5-2-31654". All numeric, three dashes-apart. */
const LBP_RE = /^(\d{1,5})-(\d{1,5})-(\d{1,7})$/;

/** Title with explicit prefix/suffix shape ("CT 123456", "123456/1"). */
const TITLE_DECORATED_RE = /^(CT\s*\d+(\/\d+)?|\d+\/\d+)$/i;

/**
 * Header text variants per field type.
 *
 * Deliberately generous about the no-space / plural / underscore forms a
 * script-generated export produces ("Rolls", "MuniNum", "Roll_No_Txt"),
 * because with a header row present the guesser trusts these patterns and
 * nothing else — see guessColumns().
 *
 * `muniName` is checked before `muni` so "Municipality Name" doesn't fall
 * into the code bucket; a bare "Municipality" still lands on `muni`, where
 * cell content decides between a numeric code and a name.
 */
const HEADER_PATTERNS = {
  roll:  /^(rolls?|roll\s*#s?|roll\s*nos?\.?|roll\s*num(ber)?s?|roll_no(_txt)?)$/i,
  muniName: /^(muni(cipality)?\s*name)$/i,
  muni:  /^(munis?|muni\s*#|muni\s*nos?\.?|muni\s*num(ber)?|muni\s*code|muni_no|municipality|municipality\s*#|municipality\s*nos?\.?|municipality\s*num(ber)?|municipality\s*code)$/i,
  legal: /^(legal|legal_?\s*desc|legal_?\s*description|description|leg\s*desc|qq|qs)$/i,
  title: /^(title|title\s*#|title\s*no\.?|c\.?\s*o\.?\s*f?\s*t\.?|cert(ificate)?\s*of\s*title|ct)$/i,
  // Site / Parcel / Comp #: a caller-supplied label used as the map/grid
  // number instead of the auto 1..N sequence. "N1 ID" is the comp number
  // an R-side comparable-sales export carries. Appraiser-built lists head
  // this column "Parcel", "Site" or a bare "#", with or without the hash,
  // so all of those forms land here.
  site:  /^(#|site|parcel|(site|parcel)\s*#|(site|parcel)\s*nos?\.?|(site|parcel)\s*num(ber)?|comp|comp\s*#|comp\s*nos?\.?|n1\s*id)$/i,
};

export const FIELD_TYPES = Object.freeze(['roll', 'muni', 'muniName', 'legal', 'title', 'site', 'ignore']);

/**
 * True when a cell reads like a municipality NAME (the sales-export
 * shape), e.g. "RM OF SPRINGFIELD" or "SPRINGFIELD (RM)". Used to tell
 * a name column apart from a numeric Muni # code so the resolver can
 * reconcile it via Roll Entry's Muni_Name_With_Typ instead of a code.
 */
export function looksLikeMuniName(cell) {
  const s = String(cell ?? '').toUpperCase();
  if (!s.trim()) return false;
  // "... (RM)" / "... (TOWN)" / "... (NORTHERN COMMUNITY)" etc.
  if (/\((RM|RURAL MUNICIPALITY|MUNICIPALITY|TOWN|CITY|VILLAGE|LGD|NORTHERN [A-Z]+)\)\s*$/.test(s)) return true;
  // "RM OF ..." / "TOWN OF ..." / "CITY OF ..." etc.
  if (/\b(RM|RURAL MUNICIPALITY|MUNICIPALITY|TOWN|CITY|VILLAGE|LGD|LOCAL GOVERNMENT DISTRICT|NORTHERN COMMUNITY)\s+OF\b/.test(s)) return true;
  return false;
}

// ---- cell helpers -------------------------------------------------

/**
 * Strip wrapping quotes (left over from CSV double-quoting), collapse
 * internal whitespace, trim. The user's source data contains cells
 * like '"\t45000"' that decode to '\t45000' through the quote-aware
 * tokenizer below; this final pass produces the bare '45000'.
 */
export function cleanCell(s) {
  if (s == null) return '';
  let t = String(s);
  // Drop NBSPs that occasionally come along with spreadsheet pastes.
  t = t.replace(/ /g, ' ');
  t = t.trim();
  if (t.length >= 2 &&
      ((t.startsWith('"') && t.endsWith('"')) ||
       (t.startsWith("'") && t.endsWith("'")))) {
    t = t.slice(1, -1).trim();
  }
  return t.replace(/\s+/g, ' ');
}

// ---- legal-token parser ------------------------------------------

/**
 * Classify a single legal-description cell.
 * @returns {{kind:'grid'|'lbp'|'unparseable', raw:string, ...}}
 *
 * Grid form preserves the parsed parts so the resolver can build the
 * normalized needle ("NW26213E") that legalIndex.searchLegalIndex's
 * normalizeLegalText() expects.
 * LBP form routes through the index's dedicated lot/block/plan fields
 * instead of the free-text search.
 */
export function parseLegalToken(raw) {
  const original = String(raw ?? '');
  const s = cleanCell(original).replace(/\s+/g, '').toUpperCase();
  if (!s) return { kind: 'unparseable', raw: original };
  const g = s.match(GRID_RE);
  if (g) {
    return {
      kind: 'grid',
      qq: g[1].toUpperCase(),
      sec: parseInt(g[2], 10),
      twp: parseInt(g[3], 10),
      rng: parseInt(g[4], 10),
      dir: g[5].toUpperCase(),
      raw: original,
    };
  }
  const p = s.match(LBP_RE);
  if (p) {
    return {
      kind: 'lbp',
      lot: parseInt(p[1], 10),
      block: parseInt(p[2], 10),
      plan: parseInt(p[3], 10),
      raw: original,
    };
  }
  return { kind: 'unparseable', raw: original };
}

/**
 * Build the normalized legal-text needle for a grid token, matching
 * normalizeLegalText() in legalIndex.core.js: uppercase, dashes
 * stripped, leading zeros dropped. "NW26-2-13E" → "NW26213E".
 * Returns "" for non-grid tokens — LBP cells go through lot/block/plan
 * fields instead.
 */
export function gridNeedle(token) {
  if (!token || token.kind !== 'grid') return '';
  return `${token.qq}${token.sec}${token.twp}${token.rng}${token.dir}`;
}

// ---- delimiter detection + cell splitting ------------------------
// (the tokenizers themselves live in lib/delimitedRows.js, shared with
//  the sales-import parser)

/**
 * Detect the row delimiter for a paste. Tab beats comma beats
 * whitespace. We sniff the first non-empty line that has a delimiter
 * candidate — short single-column pastes fall through to whitespace.
 */
function detectDelimiter(text) {
  const lines = String(text || '').split(/\r\n|\r|\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.includes('\t')) return '\t';
    if (line.includes(',')) return ',';
  }
  return /\s/;
}

/**
 * Split one cell into the values it carries.
 *
 * Two in-cell separators are recognized:
 *   - newlines, the stacked-spreadsheet-copy shape (a multi-parcel sale
 *     whose Roll / Legal cells wrap across several physical lines);
 *   - pipes, the script-generated shape ("83100 | 83200 | 85200"), which
 *     an R/CMS comparable-sales export writes when one comp spans several
 *     rolls.
 *
 * A pipe only counts as a separator when it actually sits between two
 * non-empty values, so a stray "|" inside a legal description or an
 * address never fractures the cell.
 */
export function splitCellValues(cell) {
  const out = [];
  for (const line of String(cell ?? '').split(/\r\n|\r|\n/)) {
    if (/[^\s|]\s*\|\s*[^\s|]/.test(line)) out.push(...line.split(/\s*\|\s*/));
    else out.push(line);
  }
  return out;
}

/**
 * Expand any row whose cells carry several values into one row per value
 * — a row listing several rolls becomes N single-parcel rows. `K` = the max
 * value count across the row's cells; single-value cells repeat their value,
 * multi-value cells take their k-th value (missing values blank-fill).
 *
 * The members are not tagged as belonging to one another. Property Search
 * shows every parcel on its own — its own row, its own map badge, its own
 * snapshot — so "one input row" is a fact about the paste, not about the
 * parcels. (Sale-level grouping, where a combined $/acre is the number that
 * matters, is the Sales tab's job and comes from the sales CSV.)
 *
 * Runs before cleanCell so the embedded separators are still present.
 */
function expandMultiValueRows(bodyRows) {
  const outRows = [];
  for (const row of bodyRows) {
    const split = row.map((cell) => splitCellValues(cell));
    const K = split.reduce((m, parts) => Math.max(m, parts.length), 1);
    if (K <= 1) {
      outRows.push(row);
      continue;
    }
    for (let k = 0; k < K; k++) {
      const subRow = split.map((parts) => (parts.length === 1 ? parts[0] : (parts[k] ?? '')));
      if (subRow.every((c) => String(c).trim() === '')) continue;
      outRows.push(subRow);
    }
  }
  return outRows;
}

// ---- header + column-shape detection -----------------------------

function headerToFieldType(cell) {
  const c = cleanCell(cell);
  if (!c) return null;
  for (const [type, re] of Object.entries(HEADER_PATTERNS)) {
    if (re.test(c)) return type;
  }
  return null;
}

function isHeaderRow(tokens) {
  // Treat as header if any token maps to a known field type AND no
  // token in the row parses as a grid/LBP legal. (A row that contains
  // a real legal can't also be a header row.)
  let anyHeader = false;
  let anyLegal = false;
  for (const t of tokens) {
    if (headerToFieldType(t)) anyHeader = true;
    const tok = parseLegalToken(t);
    if (tok.kind !== 'unparseable') anyLegal = true;
  }
  return anyHeader && !anyLegal;
}

/** One-cell shape tag, used by the column-type voter below. */
function cellShape(cell) {
  const c = cleanCell(cell);
  if (!c) return 'empty';
  // Legal first — its regex is the most specific.
  const tok = parseLegalToken(c);
  if (tok.kind === 'grid' || tok.kind === 'lbp') return 'legal';
  // Municipality name ("RM OF X" / "X (RM)") — a strong, specific shape
  // that never collides with the numeric/legal/title buckets below.
  if (looksLikeMuniName(c)) return 'muniName';
  // Decorated title (has CT prefix or /N suffix).
  if (TITLE_DECORATED_RE.test(c)) return 'title';
  // Pure integer — bucket by digit count.
  if (/^\d+$/.test(c)) {
    if (c.length <= 4) return 'numSmall'; // muni candidate
    if (c.length <= 8) return 'numMed';   // roll OR title candidate
    return 'numOther';
  }
  return 'other';
}

/**
 * Vote a column's cells into a field-type guess. Header hint (when
 * present) is authoritative; otherwise the strongest content tally
 * wins. Numeric columns are the genuinely ambiguous case — we lean
 * 'muni' when distinct values are few and digit count is small,
 * 'roll' otherwise. The user can always override in the mapping UI.
 */
function guessColumnType(columnCells, headerCell) {
  const hdrHint = headerToFieldType(headerCell);

  const tally = { empty: 0, legal: 0, title: 0, muniName: 0, numSmall: 0, numMed: 0, numOther: 0, other: 0 };
  for (const c of columnCells) {
    const k = cellShape(c);
    tally[k] = (tally[k] || 0) + 1;
  }
  const nonEmpty = columnCells.length - tally.empty;

  // A "Municipality" header is ambiguous — it can front a numeric muni
  // CODE or a muni NAME (the sales-export shape). Decide from content:
  // any name-shaped cells mean it's a name column, else a code column.
  if (hdrHint === 'muni') {
    if (tally.muniName > 0) return 'muniName';
    // Bare names — "ARBORG", "BIFROST-RIVERTON", the shape a hand-built
    // list uses — carry no "RM OF" / "(RM)" decoration, so they never
    // trip looksLikeMuniName above and used to fall through to the
    // numeric-code bucket, where applyMapping stripped them to nothing.
    // Under a Municipality header, anything that isn't mostly digits is
    // a name; the resolver reconciles it against the muni list.
    const numeric = tally.numSmall + tally.numMed + tally.numOther;
    if (nonEmpty > 0 && numeric < nonEmpty / 2) return 'muniName';
    return 'muni';
  }
  if (hdrHint) return hdrHint;

  if (nonEmpty === 0) return 'ignore';

  if (tally.muniName / nonEmpty >= 0.6) return 'muniName';
  if (tally.legal / nonEmpty >= 0.6) return 'legal';
  if (tally.title / nonEmpty >= 0.6) return 'title';

  if ((tally.numSmall + tally.numMed) / nonEmpty >= 0.6) {
    const distinct = new Set(columnCells.filter(Boolean)).size;
    // Heuristic: small ints with few distinct values look like munis;
    // medium ints with many distinct values look like rolls. Genuine
    // ties default to 'roll' — the common-case identifier.
    if (tally.numSmall > tally.numMed && distinct < Math.max(2, columnCells.length / 2)) {
      return 'muni';
    }
    return 'roll';
  }

  return 'ignore';
}

/**
 * Content shapes specific enough to trust under an unrecognized header.
 * A municipality NAME ("RM OF X" / "X (RM)") and a legal description have
 * regexes no price, acreage or distance column can imitate. The ambiguity
 * that forces header-strict guessing below is entirely among the NUMERIC
 * fields — roll, muni code, title #, site # — which are indistinguishable
 * from any other integer column by content alone.
 */
const SHAPE_SPECIFIC_TYPES = new Set(['muniName', 'legal']);

/**
 * Field-type guess for every column.
 *
 * With a header row present, numeric fields come from the HEADERS ALONE: a
 * column whose header isn't a recognized field name stays Ignore even when
 * its contents look like a roll or a muni code. A wide analytical export —
 * the R/CMS comparable-sales shape, 70+ columns of prices, acreages, IDs
 * and distances — otherwise collects two dozen content-based guesses, and
 * every duplicate among them blocks the modal's Resolve button until the
 * user clears it by hand. Header text is the one signal that actually
 * distinguishes a Roll # column from a Sale Price column.
 *
 * Recognized headers claim their field first, so a shape-specific column
 * can never steal a field from the header that names it (a "DateSold" cell
 * like "11-28-2025" parses as a lot-block-plan legal, but a real
 * "LegalDesc" column has already taken `legal` by then).
 *
 * The full content voter still runs for headerless input (a bare paste),
 * and as a fallback when nothing names a Roll # — without a roll nothing
 * resolves, so a set of guesses beats a screen of Ignores.
 */
function guessColumns(columns, headers) {
  if (!headers) return columns.map((cells) => guessColumnType(cells, ''));
  const claimed = new Set();
  const guesses = columns.map(() => 'ignore');

  // Pass 1 — recognized headers. First column to claim a field keeps it,
  // so an export carrying both "Rolls" and "Roll #" can't trip the
  // duplicate-field validator.
  columns.forEach((cells, c) => {
    if (!headerToFieldType(headers[c])) return;
    const t = guessColumnType(cells, headers[c]);
    if (t === 'ignore' || claimed.has(t)) return;
    claimed.add(t);
    guesses[c] = t;
  });

  // Pass 2 — a column under an unrecognized header may still claim a
  // shape-specific field it obviously holds (a "Place" column full of
  // "RM OF SPRINGFIELD").
  columns.forEach((cells, c) => {
    if (guesses[c] !== 'ignore' || headerToFieldType(headers[c])) return;
    const t = guessColumnType(cells, '');
    if (!SHAPE_SPECIFIC_TYPES.has(t) || claimed.has(t)) return;
    claimed.add(t);
    guesses[c] = t;
  });

  if (claimed.has('roll')) return guesses;
  return columns.map((cells, c) => guessColumnType(cells, headers[c] || ''));
}

// ---- top-level parse + mapping ----------------------------------

/**
 * Tokenize a paste/upload and produce per-column data + auto-detected
 * field-type guesses. Caller (the modal) shows the user the guesses
 * in a preview table and asks them to confirm before resolving.
 *
 * @returns {{
 *   headers: (string[]|null),
 *   columns: string[][],
 *   guesses: ('roll'|'muni'|'legal'|'title'|'ignore')[],
 *   rawLines: string[],
 *   delimiter: string,
 * }}
 */
export function parseParcelList(text) {
  const delim = detectDelimiter(text);
  let rows = tokenizeRows(text, delim).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (rows.length === 0) {
    return { headers: null, columns: [], guesses: [], rawLines: [], delimiter: String(delim) };
  }

  // Multi-line-cell reconstruction. When the input uses a literal
  // delimiter and the naive tokenization came out ragged — some rows
  // narrower than the header row, the signature of unquoted multi-line
  // cells wrapping across physical lines (a stacked multi-parcel sale) —
  // re-tokenize with the column-count-aware pass so those cells stay
  // whole. Clean input (every row already header-width) is left as-is.
  if (!(delim instanceof RegExp)) {
    const N = rows[0].length;
    if (N >= 2 && rows.some((r) => r.length < N)) {
      const reassembled = tokenizeRowsFixedWidth(text, delim, N)
        .filter((r) => r.some((c) => String(c).trim() !== ''));
      if (reassembled.length > 0) rows = reassembled;
    }
  }

  // Pad short rows so column arrays align.
  const widest = rows.reduce((m, r) => Math.max(m, r.length), 0);
  for (const r of rows) while (r.length < widest) r.push('');

  let headers = null;
  let bodyStart = 0;
  if (isHeaderRow(rows[0])) {
    headers = rows[0].map((c) => cleanCell(c));
    bodyStart = 1;
  }

  // Expand multi-value cells (from either the quoted-CSV path or the
  // column-count-aware reassembly) into one parcel-row per value, before
  // cleanCell collapses the embedded newlines.
  const body = expandMultiValueRows(rows.slice(bodyStart));

  const columns = Array.from({ length: widest }, (_, c) => body.map((r) => cleanCell(r[c] || '')));
  const guesses = guessColumns(columns, headers);

  // Reconstruct rawLines for the body — used by the unresolved drawer
  // so the user sees what they actually pasted, not the post-cleanCell
  // version.
  const rawLines = body.map((r) => r.join(delim instanceof RegExp ? '  ' : String(delim)));

  return { headers, columns, guesses, rawLines, delimiter: String(delim) };
}

/**
 * Apply a user-confirmed mapping to a parseParcelList() result. Each
 * column has a field type (roll | muni | legal | title | ignore).
 *
 * Returns:
 *   rows: per-body-line records the resolver can consume.
 *   issues: parser-level problems the modal surfaces before resolve
 *           (e.g. the same field mapped to two columns).
 *
 * Roll is canonicalized via the injected canonicalRoll helper (kept
 * as an injection point so this module stays free of arcgis.js
 * imports — easier to unit-test).
 */
export function applyMapping(parsed, mapping, { canonicalRoll } = {}) {
  const issues = [];
  const colByType = {};
  for (let i = 0; i < mapping.length; i++) {
    const t = mapping[i];
    if (!t || t === 'ignore') continue;
    if (colByType[t] != null) {
      issues.push({ kind: 'duplicateField', message: `${t} mapped to more than one column` });
      continue;
    }
    colByType[t] = i;
  }

  const headerOffset = parsed.headers ? 1 : 0;
  const rowCount = parsed.columns[0]?.length || 0;
  const rows = [];

  for (let r = 0; r < rowCount; r++) {
    const get = (type) => {
      const col = colByType[type];
      if (col == null) return '';
      return parsed.columns[col][r] || '';
    };
    const rollRaw = get('roll');
    const muniRaw = get('muni');
    const muniNameRaw = get('muniName');
    const legalRaw = get('legal');
    const titleRaw = get('title');
    const siteRaw = get('site');

    const cleanRoll = cleanCell(rollRaw);
    const roll = cleanRoll && canonicalRoll ? canonicalRoll(cleanRoll) : cleanRoll;
    const muniDigits = cleanCell(muniRaw).replace(/[^\d]/g, '');
    const muniNo = muniDigits ? Number(muniDigits) : null;
    const muniName = cleanCell(muniNameRaw) || null;
    const legal = legalRaw ? parseLegalToken(legalRaw) : null;
    const title = cleanCell(titleRaw);
    const site = cleanCell(siteRaw) || null;

    rows.push({
      lineNo: r + 1 + headerOffset,
      roll,
      muniNo: Number.isFinite(muniNo) ? muniNo : null,
      muniName,
      legal,
      title,
      site,
      raw: { roll: rollRaw, muni: muniRaw, muniName: muniNameRaw, legal: legalRaw, title: titleRaw, site: siteRaw },
    });
  }

  return { rows, issues };
}

/**
 * Validation helper for the modal's "Resolve" button. Returns
 * null when the mapping is acceptable, or a short reason string
 * describing what's missing.
 */
export function validateMapping(mapping) {
  const types = new Set(mapping.filter((t) => t && t !== 'ignore'));
  const hasIdentifier = types.has('muni') || types.has('muniName') || types.has('legal') || types.has('title');
  if (!hasIdentifier) {
    return 'Map at least one of Muni #, Municipality (name), Legal Desc, or Title # so each row can be resolved to a parcel.';
  }
  if (!types.has('roll') && !types.has('muni')) {
    // Without Roll # we can't intersect candidates; without Muni # we
    // can't even guarantee one parcel per row. Either is fine, both is
    // better. Surface this as a soft warning the modal can show but
    // not block on.
    return null;
  }
  return null;
}
