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
    real(criteria.title)
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

  const matches = [];
  let truncated = false;
  for (const row of rows) {
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
