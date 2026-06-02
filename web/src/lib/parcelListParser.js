/*
 * Parser for parcel-list imports. Accepts a tab / comma / space
 * separated paste or CSV/TSV upload of 2–4 columns drawn from:
 *   - Roll #
 *   - Muni #
 *   - Legal description (grid or lot-block-plan form)
 *   - Title # (certificate of title)
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

// ---- regexes ------------------------------------------------------

/** Manitoba township grid: e.g. "NW26-2-13E", "SW25-13-2W". */
const GRID_RE = /^([NS][EW])(\d{1,2})-(\d{1,3})-(\d{1,3})([EW])$/i;

/** Lot-block-plan: e.g. "5-2-31654". All numeric, three dashes-apart. */
const LBP_RE = /^(\d{1,5})-(\d{1,5})-(\d{1,7})$/;

/** Title with explicit prefix/suffix shape ("CT 123456", "123456/1"). */
const TITLE_DECORATED_RE = /^(CT\s*\d+(\/\d+)?|\d+\/\d+)$/i;

/** Header text variants per field type. */
const HEADER_PATTERNS = {
  roll:  /^(roll|roll\s*#|roll\s*no\.?|roll\s*number)$/i,
  muni:  /^(muni|muni\s*#|muni\s*no\.?|municipality|municipality\s*#|municipality\s*no\.?)$/i,
  legal: /^(legal|legal\s*desc|legal\s*description|description|leg\s*desc|qq|qs)$/i,
  title: /^(title|title\s*#|title\s*no\.?|c\.?\s*o\.?\s*f?\s*t\.?|cert(ificate)?\s*of\s*title|ct)$/i,
};

export const FIELD_TYPES = Object.freeze(['roll', 'muni', 'legal', 'title', 'ignore']);

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

// ---- delimited tokenizer (quote-aware, delimiter-flexible) -------

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
 * Quote-aware row tokenizer parameterized on delimiter. Mirrors the
 * comma-only parseCsvRows in main.js, generalized so TSV pastes (the
 * Excel-copy workflow) get the same quote handling — particularly
 * for the '"\t45000"' style cells that show up in real data.
 *
 * The `delimiter` argument is either a literal character ('\t' or ',')
 * or a RegExp (for whitespace splitting, used when no delim is found).
 * Whitespace mode bypasses the quote handling — pasted single-line
 * input never embeds delimiters in quoted cells.
 */
function tokenizeRows(text, delimiter) {
  const src = String(text || '');
  // Whitespace-only delimiter: simple split per line.
  if (delimiter instanceof RegExp) {
    return src
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.split(delimiter).map((c) => c.trim()).filter((c) => c !== ''));
  }
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow   = () => {
    // Drop completely empty rows. A row with one empty cell still
    // counts as a row of one cell — callers filter further.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += c; i++; }
    } else if (c === '"') {
      inQuotes = true; i++;
    } else if (c === delimiter) {
      pushField(); i++;
    } else if (c === '\r' || c === '\n') {
      pushField(); pushRow();
      if (c === '\r' && src[i + 1] === '\n') i += 2; else i++;
    } else {
      field += c; i++;
    }
  }
  if (field !== '' || row.length > 0) { pushField(); pushRow(); }
  return rows;
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
  if (hdrHint) return hdrHint;

  const tally = { empty: 0, legal: 0, title: 0, numSmall: 0, numMed: 0, numOther: 0, other: 0 };
  for (const c of columnCells) {
    const k = cellShape(c);
    tally[k] = (tally[k] || 0) + 1;
  }
  const nonEmpty = columnCells.length - tally.empty;
  if (nonEmpty === 0) return 'ignore';

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
  const rows = tokenizeRows(text, delim).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (rows.length === 0) {
    return { headers: null, columns: [], guesses: [], rawLines: [], delimiter: String(delim) };
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

  const body = rows.slice(bodyStart);
  const columns = Array.from({ length: widest }, (_, c) => body.map((r) => cleanCell(r[c] || '')));
  const guesses = columns.map((cells, c) => guessColumnType(cells, headers?.[c] || ''));

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
    const legalRaw = get('legal');
    const titleRaw = get('title');

    const cleanRoll = cleanCell(rollRaw);
    const roll = cleanRoll && canonicalRoll ? canonicalRoll(cleanRoll) : cleanRoll;
    const muniDigits = cleanCell(muniRaw).replace(/[^\d]/g, '');
    const muniNo = muniDigits ? Number(muniDigits) : null;
    const legal = legalRaw ? parseLegalToken(legalRaw) : null;
    const title = cleanCell(titleRaw);

    rows.push({
      lineNo: r + 1 + headerOffset,
      roll,
      muniNo: Number.isFinite(muniNo) ? muniNo : null,
      legal,
      title,
      raw: { roll: rollRaw, muni: muniRaw, legal: legalRaw, title: titleRaw },
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
  const hasIdentifier = types.has('muni') || types.has('legal') || types.has('title');
  if (!hasIdentifier) {
    return 'Map at least one of Muni #, Legal Desc, or Title # so each row can be resolved to a parcel.';
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
