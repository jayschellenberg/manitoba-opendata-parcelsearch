// Pure logic for the legal-index. No I/O, no caching, no module-level
// state — every function takes the parsed index as an argument so the
// SAME implementation runs both in the Worker (when available) and on
// the main thread fallback (node tests, browsers without Worker
// support). legalIndex.js wraps these calls with the appropriate
// transport; legalIndex.worker.js posts/receives them as messages.

const FIELD = {
  muni_no: 0,
  roll_no_txt: 1,
  extrct_prop_id: 2,
  municipality: 3,
  civic_address: 4,
  legal_description: 5,
  legal_detail: 6,
  lot: 7,
  block: 8,
  plan: 9,
  certificates_of_title: 10,
  source_url: 11,
};

const MAX_LEGAL_MATCHES = 1000;

export function hasLegalCriteria(criteria = {}) {
  return Boolean(
    real(criteria.legalText) ||
    real(criteria.lot) ||
    real(criteria.block) ||
    real(criteria.plan) ||
    real(criteria.title) ||
    real(criteria.condoPlan) ||
    real(criteria.condoUnit) ||
    real(criteria.parish) ||
    real(criteria.parishLotType) ||
    real(criteria.parishLot) ||
    real(criteria.parishPlan) ||
    real(criteria.strSection) ||
    real(criteria.strTownship) ||
    real(criteria.strRange) ||
    real(criteria.strQuarter)
  );
}

export function legalRecordKey(rec) {
  const muni = Number(rec?.muni_no);
  const roll = String(rec?.roll_no_txt || '').trim();
  if (!Number.isFinite(muni) || !roll) return null;
  return `${Math.trunc(muni)}|${roll}`;
}

export function parcelLegalKey(props = {}) {
  const muni = String(props.Municipality || '').match(/^\s*(\d+)\s*-/)?.[1];
  const roll = String(props.Roll_No_Txt || '').trim();
  if (!muni || !roll) return null;
  return `${Number(muni)}|${roll}`;
}

/** Parse the legal-index payload after fetch. Returns the validated
 *  shape `{ rows, metadata }` or throws on malformed input. */
export function parseLegalIndex(json) {
  if (!json || !Array.isArray(json.rows)) {
    throw new Error('Legal index is malformed: expected a rows array.');
  }
  return { rows: json.rows, metadata: json.metadata || null };
}

/** Search by free-text criteria. Returns `{ matches, truncated }`.
 *  Same matching rules as the previous in-line implementation —
 *  preserved verbatim so the public API behaves identically. */
export function searchLegalIndex(index, criteria = {}) {
  if (!hasLegalCriteria(criteria)) {
    return { matches: [], truncated: false, metadata: index?.metadata || null };
  }
  const rows = index?.rows || [];
  const legalNeedle = normalizeLegalText(criteria.legalText);
  const lotNeedle   = normalizeLegalPart(criteria.lot, 'lot');
  const blockNeedle = normalizeLegalPart(criteria.block, 'block');
  const planNeedle  = normalizeLegalPart(criteria.plan, 'plan');
  const titleNeedle = normalizeTitle(criteria.title);
  const muniNeedle  = normalizeMunicipality(criteria.municipality);
  const condoNeedle  = condoSearchNeedle(criteria);
  const parishNeedle = parishSearchNeedle(criteria);
  const strNeedle    = strSearchNeedle(criteria);
  // The derived-token pass over the whole index is only paid when a
  // criterion that needs it is actually set — a plain legal-text or
  // title search skips it entirely.
  const drv = (condoNeedle || parishNeedle || strNeedle) ? ensureDerived(index) : null;

  const matches = [];
  let truncated = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (condoNeedle && !condoNeedle.test(drv.condo[i])) continue;
    if (parishNeedle && !parishNeedle.test(drv.parish[i])) continue;
    if (strNeedle && !strNeedle.test(drv.str[i])) continue;
    const rec = rowToRecord(row);
    const legalHaystack = normalizeLegalText(`${rec.legal_description} ${rec.legal_detail}`);
    if (muniNeedle && normalizeMunicipality(rec.municipality) !== muniNeedle) continue;
    if (legalNeedle && !legalHaystack.includes(legalNeedle)) continue;
    if (lotNeedle && normalizeLegalPart(rec.lot, 'lot') !== lotNeedle) continue;
    if (blockNeedle && normalizeLegalPart(rec.block, 'block') !== blockNeedle) continue;
    if (planNeedle) {
      const parsedPlanMatch = normalizeLegalPart(rec.plan, 'plan') === planNeedle;
      const stripAllHaystack = normalizeContains(`${rec.legal_description} ${rec.legal_detail}`);
      const rawPlanMatch = planNeedle.length >= 3 && stripAllHaystack.includes(planNeedle);
      if (!parsedPlanMatch && !rawPlanMatch) continue;
    }
    if (titleNeedle && !normalizeContains(rec.certificates_of_title).includes(titleNeedle)) continue;
    matches.push(rec);
    if (matches.length >= MAX_LEGAL_MATCHES) { truncated = true; break; }
  }
  return { matches, truncated, metadata: index?.metadata || null };
}

/**
 * Parish codes present in the index, as `[{ code, name, count }]`
 * sorted by name. Drives the data-derived Parish dropdown — only
 * parishes that can actually return a parcel are offered, rather than
 * MAO's full historical list.
 */
export function listParishOptions(index) {
  const drv = ensureDerived(index);
  const counts = new Map();
  for (const s of drv.parish) {
    if (!s) continue;
    // Tokens are `;TYPE|LOT|PARISH|PLAN;` — pull each parish code once
    // per row so counts mean "parcels", not "lot references".
    const seen = new Set();
    for (const m of s.matchAll(/\|([A-Z]{2})\|[^;]*;/g)) seen.add(m[1]);
    for (const code of seen) counts.set(code, (counts.get(code) || 0) + 1);
  }
  const out = [];
  for (const [code, count] of counts) {
    out.push({ code, name: PARISH_NAMES[code] || code, count });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Resolve a list of (muni_no, roll_no_txt) keys to legal-index
 *  records. Returns an array. */
export function lookupLegalRecordsByParcelKeys(index, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const wanted = new Set(keys);
  const out = [];
  for (const row of index?.rows || []) {
    const rec = rowToRecord(row);
    const k = legalRecordKey(rec);
    if (k && wanted.has(k)) out.push(rec);
  }
  return out;
}

/**
 * Bulk-lookup variant for parcel-list imports. Takes a set of roll
 * strings (canonical form, e.g. "218600.000") and returns every
 * legal-index record whose roll_no_txt matches — across all munis,
 * since the caller doesn't yet know which muni each roll belongs to.
 *
 * One scan of the index regardless of input size; the resolver
 * filters the per-roll candidate list client-side by title or legal
 * description to pick the right muni. Returns a Map keyed on the
 * canonical roll string.
 */
export function lookupLegalRecordsByRollSet(index, rollSet) {
  const want = rollSet instanceof Set ? rollSet : new Set(rollSet || []);
  const out = new Map();
  if (want.size === 0) return out;
  for (const row of index?.rows || []) {
    const rec = rowToRecord(row);
    const k = String(rec.roll_no_txt || '').trim();
    if (!k || !want.has(k)) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(rec);
  }
  return out;
}

/**
 * Bulk-lookup records by canonical section-township-range token
 * ("NE|27|7|4|E", the deriveStrTokens encoding). Used by the parcel-
 * list resolver for rows that carry ONLY a grid legal description —
 * no roll # to intersect on, so the derived STR tokens are the
 * identifier. One scan of the index regardless of how many tokens are
 * wanted. Returns Map<token, Record[]>; a parcel spanning several
 * quarters lands in every matching token's list.
 */
export function lookupLegalRecordsByStrSet(index, tokens) {
  const want = tokens instanceof Set ? tokens : new Set(tokens || []);
  const out = new Map();
  if (want.size === 0) return out;
  const drv = ensureDerived(index);
  const rows = index?.rows || [];
  for (let i = 0; i < rows.length; i++) {
    const s = drv.str[i];
    if (!s) continue;
    let rec = null;
    for (const tok of s.split(';')) {
      if (!tok || !want.has(tok)) continue;
      if (!rec) rec = rowToRecord(rows[i]);
      if (!out.has(tok)) out.set(tok, []);
      out.get(tok).push(rec);
    }
  }
  return out;
}

// ---------- derived legal-token layer ----------
//
// MAO's structured searches (condo unit, parish lot, section-township-
// range) have no dedicated columns in the scrape — the information
// lives inside legal_description / legal_detail in canonical text
// forms. Rather than rebuilding and republishing the index with new
// columns, each row is parsed ONCE (lazily, on the first search that
// needs it) into compact delimiter-encoded token strings:
//
//   condo:  ";PLAN|UNIT;…"          from the detail's leading
//           `plan-unit` pairs (`38239-1 TOGETHER WITH …`). The
//           reversed single-dash pair is the condo signature — parcel
//           references use a double dash in the SAME order as the
//           description (`1--1116` = Parcel 1 Plan 1116) and never
//           match. Unit ranges in the description (`DESC 1/8-39000`)
//           expand to one token per unit.
//   parish: ";TYPE|LOT|PARISH|PLAN;…" from codes like `RL-65-FX-5066`
//           (River Lot 65, Parish of St François Xavier, Plan 5066) in
//           both text fields; description-side ranges (`RL45/51-BP-626`)
//           expand to one token per lot.
//   str:    ";QTR|SEC|TWP|RGE|DIR;…" from canonical detail tokens
//           (`NE-01-13-28-W`) plus the description's compact form
//           (`NE1-13-28W`). QTR is NE/NW/SE/SW or RL for township
//           river lots (`RL-7E-23-04-E`), matching MAO's own Quarter
//           Section dropdown.
//
// All numbers are zero-stripped so `04` and `4` compare equal. The
// strings are searched with per-query RegExps built by the needle
// helpers below; empty criteria slots become wildcards, so any subset
// of the fields works as an AND filter.

// Parish code → display name. Labels verified against the "PARISH OF
// …" / "SETTLEMENT OF …" prose accompanying each code in the archive
// (2026-08-22). A code missing here still works — it just shows as the
// bare two-letter code in the dropdown.
export const PARISH_NAMES = {
  AD: 'ST ANDREWS',
  AG: 'STE AGATHE',
  AN: 'STE ANNE',
  BE: 'BIG EDDY',
  BP: 'BAIE ST PAUL',
  CH: 'ST CHARLES',
  CL: 'ST CLEMENTS',
  CR: 'CROSS LAKE',
  DN: 'DYNEVOR',
  FB: 'FISHER BAY',
  FD: 'FAIRFORD',
  FX: 'ST FRANCOIS XAVIER',
  GP: 'GRANDE POINTE',
  GR: 'GRAND RAPIDS',
  HB: 'HIGH BLUFF',
  HD: 'HEADINGLEY',
  JA: 'ST JAMES',
  LA: 'ST LAURENT',
  LO: 'LORETTE',
  MA: 'ST MALO',
  MH: 'MANITOBA HOUSE',
  MR: 'MANIGOTAGAN RIVER',
  NO: 'ST NORBERT',
  OI: 'OAK ISLAND',
  OP: 'OAK POINT',
  PA: 'ST PAUL',
  PC: 'PINE CREEK',
  PE: 'ST PETER',
  PO: 'POPLAR POINT',
  PP: 'PORTAGE LA PRAIRIE',
  PQ: 'PASQUIA',
  PS: 'THE PAS',
  RC: 'ST BONIFACE (RC MISSION)',
  RR: 'RAT RIVER',
  UV: 'UMFREVILLE',
  WE: 'WESTBOURNE',
};

// Lot-type prefix → label, in MAO's Lot type dropdown order. Note the
// archive codes settlement and inner-two-mile lots inconsistently
// (St Malo settlement lots ride as RL; `DESC IT65-…` rows carry RL in
// the detail), so a lot-type filter is a best-effort narrowing — the
// tooltip says as much.
export const PARISH_LOT_TYPES = [
  { code: 'RL', name: 'River Lot' },
  { code: 'PL', name: 'Parish Lot' },
  { code: 'SL', name: 'Settlement Lot' },
  { code: 'IT', name: 'Inner Two Miles' },
  { code: 'OT', name: 'Outer Two Miles' },
  { code: 'PK', name: 'Park Lot' },
  { code: 'WL', name: 'Wood Lot' },
];

// Cap on `/`-range expansion (lot ranges, condo unit ranges) so a
// typo'd `1/98765` row can't balloon the derived strings.
const MAX_RANGE_EXPANSION = 200;

function stripZeros(v) {
  return String(v || '').toUpperCase().replace(/^0+(?=[0-9A-Z])/, '');
}

function expandNumericRange(a, b) {
  const lo = Number(a), hi = Number(b);
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo
      || hi - lo + 1 > MAX_RANGE_EXPANSION) {
    return [String(a), String(b)];
  }
  const out = [];
  for (let n = lo; n <= hi; n++) out.push(String(n));
  return out;
}

/** Condo tokens for one row: `;PLAN|UNIT;…` or ''. Exported for tests. */
export function deriveCondoTokens(description, detail) {
  const det = String(detail || '').toUpperCase();
  const des = String(description || '').toUpperCase();
  const pairs = [];
  // Leading `plan-unit` pairs only — the same shape mid-text is
  // ambiguous (`RL-6-GP-3909 6-3909 …` carries a lot-plan pair).
  let rest = det;
  let plan = null;
  for (;;) {
    const m = rest.match(/^(\d+)-(\d+)(?:\/(\d+))?(?=\s|$)/);
    if (!m) break;
    if (plan === null) plan = stripZeros(m[1]);
    else if (stripZeros(m[1]) !== plan) break;
    const units = m[3] ? expandNumericRange(m[2], m[3]) : [m[2]];
    for (const u of units) pairs.push(`${plan}|${stripZeros(u)}`);
    rest = rest.slice(m[0].length).replace(/^\s+/, '');
  }
  if (plan === null) return '';
  // The description restates the same pair reversed (`DESC 1/8-39000`
  // ↔ `39000-1 …`) and often carries the full unit list/range the
  // truncated detail lost. Only trusted when its plan agrees with the
  // detail's — `DESC 1-1116` over `1--1116` is Parcel 1 Plan 1116, and
  // the double dash already kept it out of the loop above.
  const dm = des.match(/^(?:DESC\s+)?(\d+(?:[&/]\d+)*)-(\d+)$/);
  if (dm && stripZeros(dm[2]) === plan) {
    for (const part of dm[1].split('&')) {
      const [a, b] = part.split('/');
      const units = b ? expandNumericRange(a, b) : [a];
      for (const u of units) {
        const tok = `${plan}|${stripZeros(u)}`;
        if (!pairs.includes(tok)) pairs.push(tok);
      }
    }
  }
  return pairs.length ? `;${pairs.join(';')};` : '';
}

/** Parish-lot tokens for one row: `;TYPE|LOT|PARISH|PLAN;…` or ''.
 *  Exported for tests. */
export function deriveParishTokens(description, detail) {
  const tokens = [];
  const push = (type, lot, parish, plan) => {
    const tok = `${type}|${stripZeros(lot)}|${parish}|${stripZeros(plan)}`;
    if (!tokens.includes(tok)) tokens.push(tok);
  };
  // Canonical codes in either field: TYPE-LOT-PARISH[-PLAN], the dash
  // after TYPE sometimes omitted (`IT65-FX-5066`) and the plan
  // sometimes absent (`ORG RL-4-AG`). The two-alpha parish group is
  // what separates these from township river lots (`RL-7E-23-04-E`,
  // numeric third part), which belong to the STR family below.
  const reCode = /\b(RL|OT|IT|PL|WL|PK|SL)-?(\d+[A-Z]?)(?:\/(\d+[A-Z]?))?-([A-Z]{2})(?:-(\d*))?/g;
  for (const src of [detail, description]) {
    const text = String(src || '').toUpperCase();
    for (const m of text.matchAll(reCode)) {
      const [, type, lotA, lotB, parish, plan] = m;
      if (lotB) {
        // `RL45/51-BP-626` is a RANGE of lots. Letter-suffixed bounds
        // don't expand — both endpoints are kept as-is.
        const lots = (/^\d+$/.test(lotA) && /^\d+$/.test(lotB))
          ? expandNumericRange(lotA, lotB)
          : [lotA, lotB];
        for (const lot of lots) push(type, lot, parish, plan || '');
      } else {
        push(type, lotA, parish, plan || '');
      }
    }
  }
  return tokens.length ? `;${tokens.join(';')};` : '';
}

/** Section-township-range tokens for one row: `;QTR|SEC|TWP|RGE|DIR;…`
 *  or ''. Exported for tests. */
export function deriveStrTokens(description, detail) {
  const tokens = [];
  const push = (q, sec, twp, rge, dir) => {
    const tok = `${q}|${stripZeros(sec)}|${stripZeros(twp)}|${stripZeros(rge)}|${dir}`;
    if (!tokens.includes(tok)) tokens.push(tok);
  };
  // Canonical detail form: NE-01-13-28-W (87% of the archive).
  const det = String(detail || '').toUpperCase();
  for (const m of det.matchAll(/\b(NE|NW|SE|SW|RL)-(\d+[A-Z]?)-(\d+)-(\d+)-([EW])\b/g)) {
    push(m[1], m[2], m[3], m[4], m[5]);
  }
  // Compact description form: NE1-13-28W, RL7E0&8E0-23-4E. The lot/
  // section slot can be an &-list; each entry gets its own token.
  const des = String(description || '').toUpperCase();
  for (const m of des.matchAll(/\b(NE|NW|SE|SW|RL)(\d+[A-Z]?\d*(?:&\d+[A-Z]?\d*)*)-(\d+)-(\d+)([EW])\b/g)) {
    for (const sec of m[2].split('&')) push(m[1], sec, m[3], m[4], m[5]);
  }
  return tokens.length ? `;${tokens.join(';')};` : '';
}

/** One-time derived-token arrays for the whole index, cached on the
 *  index object itself so worker and direct transports both reuse it. */
function ensureDerived(index) {
  if (index._derived) return index._derived;
  const rows = index?.rows || [];
  const condo = new Array(rows.length);
  const parish = new Array(rows.length);
  const str = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const des = rows[i][FIELD.legal_description];
    const det = rows[i][FIELD.legal_detail];
    condo[i]  = deriveCondoTokens(des, det);
    parish[i] = deriveParishTokens(des, det);
    str[i]    = deriveStrTokens(des, det);
  }
  index._derived = { condo, parish, str };
  return index._derived;
}

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Criteria → RegExp over the condo token string, or null when no
 *  condo criterion is set. */
export function condoSearchNeedle(criteria = {}) {
  const plan = real(criteria.condoPlan) ? stripZeros(String(criteria.condoPlan).replace(/[^0-9]/g, '')) : '';
  const unit = real(criteria.condoUnit) ? stripZeros(String(criteria.condoUnit).replace(/[^0-9]/g, '')) : '';
  if (!plan && !unit) return null;
  return new RegExp(`;${plan ? escRe(plan) : '\\d+'}\\|${unit ? escRe(unit) : '\\d+'};`);
}

/** Criteria → RegExp over the parish token string, or null. */
export function parishSearchNeedle(criteria = {}) {
  const parish = real(criteria.parish) ? String(criteria.parish).toUpperCase().trim() : '';
  const type   = real(criteria.parishLotType) ? String(criteria.parishLotType).toUpperCase().trim() : '';
  const lot    = real(criteria.parishLot) ? stripZeros(String(criteria.parishLot).toUpperCase().replace(/[^0-9A-Z]/g, '')) : '';
  const plan   = real(criteria.parishPlan) ? stripZeros(String(criteria.parishPlan).replace(/[^0-9]/g, '')) : '';
  if (!parish && !type && !lot && !plan) return null;
  return new RegExp(
    `;${type ? escRe(type) : '[A-Z]{2}'}` +
    `\\|${lot ? escRe(lot) : '[^|;]*'}` +
    `\\|${parish ? escRe(parish) : '[A-Z]{2}'}` +
    `\\|${plan ? escRe(plan) : '[^|;]*'};`
  );
}

/** Criteria → RegExp over the STR token string, or null. The range
 *  box accepts `4`, `4E` or `4W` — a bare number matches either side
 *  of the principal meridian. */
export function strSearchNeedle(criteria = {}) {
  const q   = real(criteria.strQuarter) ? String(criteria.strQuarter).toUpperCase().trim() : '';
  const sec = real(criteria.strSection) ? stripZeros(String(criteria.strSection).toUpperCase().replace(/[^0-9A-Z]/g, '')) : '';
  const twp = real(criteria.strTownship) ? stripZeros(String(criteria.strTownship).replace(/[^0-9]/g, '')) : '';
  let rge = '', dir = '';
  if (real(criteria.strRange)) {
    const m = String(criteria.strRange).toUpperCase().trim().match(/^(\d+)\s*([EW])?$/);
    if (m) { rge = stripZeros(m[1]); dir = m[2] || ''; }
    else return NEVER_MATCH;  // garbage in the range box matches nothing
  }
  if (!q && !sec && !twp && !rge) return null;
  return new RegExp(
    `;${q ? escRe(q) : '[A-Z]{2}'}` +
    `\\|${sec ? escRe(sec) : '[^|;]*'}` +
    `\\|${twp ? escRe(twp) : '\\d+'}` +
    `\\|${rge ? escRe(rge) : '\\d+'}` +
    `\\|${dir || '[EW]'};`
  );
}

// A RegExp that can never match a derived-token string (they contain
// no lowercase characters).
const NEVER_MATCH = /a^/;

// ---------- internals ----------

function rowToRecord(row) {
  return {
    muni_no: row[FIELD.muni_no],
    roll_no_txt: row[FIELD.roll_no_txt] || '',
    extrct_prop_id: row[FIELD.extrct_prop_id] || '',
    municipality: row[FIELD.municipality] || '',
    civic_address: row[FIELD.civic_address] || '',
    legal_description: row[FIELD.legal_description] || '',
    legal_detail: row[FIELD.legal_detail] || '',
    lot: row[FIELD.lot] || '',
    block: row[FIELD.block] || '',
    plan: row[FIELD.plan] || '',
    certificates_of_title: row[FIELD.certificates_of_title] || '',
    source_url: row[FIELD.source_url] || '',
  };
}

function real(v) { return v != null && String(v).trim() !== ''; }

function normalizeContains(v) {
  if (!real(v)) return '';
  return String(v).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function normalizeLegalText(v) {
  if (!real(v)) return '';
  let s = String(v).toUpperCase().replace(/\s+/g, ' ').trim();
  s = s.replace(/\b0+(\d)/g, '$1');
  s = s.replace(/-+/g, '');
  return s;
}

function normalizeLegalPart(v, kind) {
  if (!real(v)) return '';
  let s = String(v).toUpperCase().trim();
  if (kind === 'lot') s = s.replace(/^(LOT|L)\s*[:#-]?\s*/, '');
  if (kind === 'block') s = s.replace(/^(BLOCK|BLK|B)\s*[:#-]?\s*/, '');
  if (kind === 'plan') s = s.replace(/^(PLAN|PL)\s*[:#-]?\s*/, '');
  return s.replace(/[^A-Z0-9]+/g, '');
}

function normalizeTitle(v) {
  if (!real(v)) return '';
  return String(v)
    .toUpperCase()
    .replace(/^(CERTIFICATE\s+OF\s+TITLE|CERTIFICATE|TITLE|CT|C\/T)\s*[:#-]?\s*/, '')
    .replace(/[^A-Z0-9]+/g, '');
}

function normalizeMunicipality(v) {
  if (!real(v)) return '';
  let s = String(v)
    .toUpperCase()
    .replace(/^\s*\d+\s*-\s*/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\bRURAL\s+MUNICIPALITY\s+OF\b/g, '')
    .replace(/\bRM\s+OF\b/g, '')
    .replace(/\bTOWN\s+OF\b/g, '')
    .replace(/\bCITY\s+OF\b/g, '')
    .replace(/\bVILLAGE\s+OF\b/g, '')
    .replace(/\bMUNICIPALITY\s+OF\b/g, '')
    .replace(/\bMUNICIPALITY\b/g, '')
    .replace(/\bTOWN\b/g, '')
    .replace(/\bCITY\b/g, '')
    .replace(/\bVILLAGE\b/g, '');
  return s.replace(/[^A-Z0-9]+/g, '');
}
