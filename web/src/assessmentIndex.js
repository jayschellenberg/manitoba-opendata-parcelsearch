// Client-side lookup over the per-roll latest-year assessment shard
// (web/public/data/assessment-index.json, built by r/build_assessment_index.R
// from the MAO scrape's tax_history.parquet).
//
// Today this powers the sales-CSV "Vacant land only" filter; future
// affordances (table columns, "Max building %" slider, class/status
// filters) all read off the same shard so they don't need their own
// data pipeline.
//
// Production hosting: same pattern as legalIndex.js — local file in
// dev, GitHub Release asset via Edge Function in prod. The shard is
// ~17 MiB raw / ~3.5 MiB gzipped, well under GitHub's 100 MiB single-
// file limit, but kept off Vercel's static-asset path because shipping
// it inline would balloon the build artefact.
//
// Memory shape: Map<key, rowArray>. Storing each row as the raw 6-cell
// array (no per-row object) keeps the resident-set roughly 3-4x smaller
// than {muni_no, roll_no_txt, year, land, buildings, total} objects
// would, at the cost of one indexed access per field on the lookup
// path. For 430k rows that's a meaningful saving — and the array is
// converted to an object only at the lookup boundary.

const ASSESSMENT_INDEX_LOCAL_URL = `${import.meta.env?.BASE_URL || '/'}data/assessment-index.json`;
const ASSESSMENT_INDEX_PROXY_URL = '/api/assessment-index';

// Field positions in the packed-array rows. Matches the `fields` array
// emitted by r/build_assessment_index.R — DO NOT REORDER without
// updating the R script in lockstep.
const FIELD = {
  muni_no:      0,
  roll_no_txt:  1,
  year:         2,
  land:         3,
  buildings:    4,
  total:        5,
};

// Threshold for the "vacant" predicate. A parcel where buildings make
// up < this fraction of total assessed value is flagged as nominally
// vacant. 2% is the working number for now (see plan / FUTURE_WORK.md
// for "Max building %" slider that would replace this constant).
export const VACANT_BUILDING_PCT = 0.02;

let indexPromise = null;

/**
 * Pre-fetch the assessment index in the background. Safe to call
 * multiple times — `loadAssessmentIndex` caches the parsed Map on
 * the module-level `indexPromise` after the first call. Mirrors the
 * legalIndex.js warm pattern so the first sales-CSV upload doesn't
 * pay the ~3.5 MB cold fetch latency on the critical path.
 */
export function warmAssessmentIndex() {
  loadAssessmentIndex().catch((err) => {
    // Non-fatal — the lookup helper surfaces the failure separately.
    console.warn('Assessment-index pre-warm failed:', err.message);
  });
}

/**
 * Lookup helper. Pass a `(muni_no, roll_no_txt)` tuple — same shape
 * legalIndex's `parcelLegalKey` produces — and get back a record
 * `{land, buildings, total, year, pctBuildings}` or null when the
 * parcel isn't in the shard. The Map stays in packed-row form;
 * conversion happens only at the lookup boundary so callers always
 * see the friendly object shape.
 */
export async function lookupAssessment({ muni_no, roll_no_txt } = {}) {
  if (muni_no == null || !roll_no_txt) return null;
  let map;
  try {
    map = await loadAssessmentIndex();
  } catch (err) {
    console.warn('Assessment-index lookup failed:', err.message);
    return null;
  }
  const key = `${Number(muni_no)}|${String(roll_no_txt).trim()}`;
  const row = map.get(key);
  if (!row) return null;
  return rowToRecord(row);
}

/**
 * Encapsulates the vacancy predicate so callers don't duplicate it.
 * Strict semantics — every condition must hold:
 *   - total > 0           (have a real assessment)
 *   - land > 0            (excludes pipeline / building-only / institutional
 *                          rolls where land=0 isn't a vacancy signal)
 *   - buildings/total < VACANT_BUILDING_PCT  (nominal vacancy)
 *
 * Returns false defensively when any input is missing — callers
 * treat undefined as 'not known to be vacant', which is the safe
 * default for an inclusive filter ('Vacant land only').
 */
export function isVacantLand(rec) {
  if (!rec) return false;
  const { land, buildings, total } = rec;
  if (!Number.isFinite(total) || total <= 0) return false;
  if (!Number.isFinite(land)  || land  <= 0) return false;
  if (!Number.isFinite(buildings) || buildings < 0) return false;
  return (buildings / total) < VACANT_BUILDING_PCT;
}

// ---------- internals ----------

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
    // Pre-computed building share — most downstream consumers want
    // this rather than re-deriving it. NaN-safe fallback so callers
    // can still trust `Number.isFinite()` checks at the boundary.
    pctBuildings: total > 0 && Number.isFinite(buildings) ? (buildings / total) : NaN,
  };
}

function loadAssessmentIndex() {
  if (!indexPromise) {
    indexPromise = fetchAndIndex();
  }
  return indexPromise;
}

async function fetchAndIndex() {
  // Local-first to keep dev fast — vite serves any in-tree copy at
  // /data/assessment-index.json directly. In production the local
  // file isn't in the build output, so the fetch 404s and we fall
  // through to the Edge Function.
  let json;
  try {
    const localRes = await fetch(ASSESSMENT_INDEX_LOCAL_URL);
    if (localRes.ok) {
      json = await localRes.json();
    }
  } catch { /* network/parse failure on local — fall through */ }

  if (!json) {
    let proxyRes;
    try {
      proxyRes = await fetch(ASSESSMENT_INDEX_PROXY_URL);
    } catch (err) {
      throw new Error(`Assessment-index proxy fetch failed: ${err.message}`);
    }
    if (!proxyRes.ok) {
      throw new Error(
        `Assessment-index not available locally (${ASSESSMENT_INDEX_LOCAL_URL}) and the proxy at ${ASSESSMENT_INDEX_PROXY_URL} returned ${proxyRes.status}. ` +
        `For local dev, run \`npm run assessment:index\` (or \`Rscript r/build_assessment_index.R\`) to populate web/public/data/assessment-index.json. ` +
        `For production, confirm the GitHub Release asset exists and that api/assessment-index.js's RELEASE_URL points at it.`
      );
    }
    json = await proxyRes.json();
  }

  if (!json || !Array.isArray(json.rows)) {
    throw new Error('Assessment-index is malformed: expected a rows array.');
  }

  // Build the Map. Keep rows as their raw arrays — conversion to the
  // friendly object happens at the lookup boundary only, so the
  // resident-set stays small.
  const map = new Map();
  for (const row of json.rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const muni = Number(row[FIELD.muni_no]);
    const roll = String(row[FIELD.roll_no_txt] || '').trim();
    if (!Number.isFinite(muni) || !roll) continue;
    map.set(`${muni}|${roll}`, row);
  }
  // Stash metadata for debugging from the console (window.__assessmentIndexMeta).
  if (typeof window !== 'undefined') {
    window.__assessmentIndexMeta = json.metadata || null;
  }
  return map;
}
