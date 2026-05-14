// Pure logic for the assessment-index. Same role as
// legalIndex.core.js — the worker imports these functions to run
// heavy work off the main thread, and the main-thread fallback in
// assessmentIndex.js imports them when Workers aren't available.

const FIELD = {
  muni_no:     0,
  roll_no_txt: 1,
  year:        2,
  land:        3,
  buildings:   4,
  total:       5,
  class:       6,
  tax_status:  7,
};

export const VACANT_BUILDING_PCT = 0.02;

/** Parse the assessment-index JSON payload, build the lookup Map,
 *  and return `{ map, metadata }`. Rows are kept in packed-array
 *  form to minimise resident memory; conversion to friendly records
 *  happens only at the per-row lookup boundary (rowToRecord). */
export function parseAssessmentIndex(json) {
  if (!json || !Array.isArray(json.rows)) {
    throw new Error('Assessment-index is malformed: expected a rows array.');
  }
  const map = new Map();
  for (const row of json.rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const muni = Number(row[FIELD.muni_no]);
    const roll = String(row[FIELD.roll_no_txt] || '').trim();
    if (!Number.isFinite(muni) || !roll) continue;
    map.set(`${muni}|${roll}`, row);
  }
  return { map, metadata: json.metadata || null };
}

/** Look up a single (muni_no, roll_no_txt) tuple. Returns the
 *  friendly record object or null when the key isn't in the
 *  parsed Map. Defensive against null / undefined input — the
 *  `= {}` default param only catches undefined, so explicit null
 *  has to be checked too. */
export function lookupAssessment(parsed, lookup) {
  if (!lookup || typeof lookup !== 'object') return null;
  const { muni_no, roll_no_txt } = lookup;
  if (muni_no == null || !roll_no_txt) return null;
  const key = `${Number(muni_no)}|${String(roll_no_txt).trim()}`;
  const row = parsed?.map?.get(key);
  if (!row) return null;
  return rowToRecord(row);
}

/** Vacancy predicate. Strict — every condition must hold:
 *    total > 0 AND land > 0 AND buildings/total < VACANT_BUILDING_PCT */
export function isVacantLand(rec) {
  if (!rec) return false;
  const { land, buildings, total } = rec;
  if (!Number.isFinite(total) || total <= 0) return false;
  if (!Number.isFinite(land)  || land  <= 0) return false;
  if (!Number.isFinite(buildings) || buildings < 0) return false;
  return (buildings / total) < VACANT_BUILDING_PCT;
}

function rowToRecord(row) {
  if (!Array.isArray(row)) return null;
  const total = Number(row[FIELD.total]);
  const buildings = Number(row[FIELD.buildings]);
  return {
    muni_no:     Number(row[FIELD.muni_no]),
    roll_no_txt: String(row[FIELD.roll_no_txt] || ''),
    year:        Number(row[FIELD.year]),
    land:        Number(row[FIELD.land]),
    buildings,
    total,
    pctBuildings: total > 0 && Number.isFinite(buildings) ? (buildings / total) : NaN,
    class:       String(row[FIELD.class] || ''),
    tax_status:  String(row[FIELD.tax_status] || ''),
  };
}
