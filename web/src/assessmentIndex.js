// Public API for the assessment-index. Mirrors legalIndex.js — when
// Worker is available, JSON.parse + Map building happen off the
// main thread; otherwise everything runs synchronously via the
// shared core module.

import {
  parseAssessmentIndex,
  lookupAssessment as lookupCore,
  isVacantLand,
  VACANT_BUILDING_PCT,
} from './assessmentIndex.core.js';
import {
  lookupInShards,
  prefetchShards,
  getShardIndex,
} from './assessmentShards.js';

// Re-export shard prefetch so handleSalesUpload can warm per-muni
// shards once the matched-muni list is known.
export { prefetchShards as prefetchAssessmentShards };

const ASSESSMENT_INDEX_LOCAL_URL = `${import.meta.env?.BASE_URL || '/'}data/assessment-index.json`;
const ASSESSMENT_INDEX_PROXY_URL = '/api/assessment-index';

// Re-export pure helpers / constants so existing call sites work.
export { isVacantLand, VACANT_BUILDING_PCT };

let worker = null;
let pending = new Map();
let nextId = 0;
let directIndexPromise = null;

function workerSupported() {
  return typeof Worker !== 'undefined' && typeof import.meta.url === 'string';
}

function ensureWorker() {
  if (worker) return worker;
  if (!workerSupported()) return null;
  try {
    worker = new Worker(new URL('./workers/assessmentIndex.worker.js', import.meta.url), {
      type: 'module',
    });
  } catch (err) {
    console.warn('Assessment-index worker unavailable, falling back to main thread:', err.message);
    worker = null;
    return null;
  }
  worker.addEventListener('message', (ev) => {
    const { id, ok, result, error } = ev.data || {};
    const slot = pending.get(id);
    if (!slot) return;
    pending.delete(id);
    if (ok) slot.resolve(result);
    else slot.reject(new Error(error || 'Assessment-index worker failed'));
  });
  worker.addEventListener('error', (err) => {
    for (const slot of pending.values()) {
      slot.reject(new Error(err?.message || 'Assessment-index worker errored'));
    }
    pending.clear();
    worker = null;
  });
  return worker;
}

function postMessage(type, payload) {
  const w = ensureWorker();
  if (!w) return null;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, payload });
  });
}

async function loadDirect() {
  if (directIndexPromise) return directIndexPromise;
  directIndexPromise = (async () => {
    let json = null;
    try {
      const res = await fetch(ASSESSMENT_INDEX_LOCAL_URL);
      if (res.ok) json = await res.json();
    } catch { /* fall through */ }
    if (!json) {
      const res = await fetch(ASSESSMENT_INDEX_PROXY_URL);
      if (!res.ok) {
        throw new Error(
          `Assessment-index not available locally (${ASSESSMENT_INDEX_LOCAL_URL}) and the proxy at ${ASSESSMENT_INDEX_PROXY_URL} returned ${res.status}.`
        );
      }
      json = await res.json();
    }
    return parseAssessmentIndex(json);
  })();
  return directIndexPromise;
}

// ---------- Public API ----------

export function warmAssessmentIndex() {
  const p = postMessage('load', {
    localUrl: ASSESSMENT_INDEX_LOCAL_URL,
    proxyUrl: ASSESSMENT_INDEX_PROXY_URL,
  });
  if (p) {
    p.catch((err) => console.warn('Assessment-index pre-warm failed:', err.message));
    return;
  }
  loadDirect().catch((err) => console.warn('Assessment-index pre-warm failed:', err.message));
}

export async function lookupAssessment(key) {
  if (!key || key.muni_no == null || !key.roll_no_txt) return null;
  // Shard fast path: ~5-50 row file per muni, no 30 MB index load.
  // Returns:
  //   undefined → shard mode unavailable (no shards built / 404)
  //   null      → shard mode active, no row for this muni|roll
  //   array     → packed row to return as a friendly record
  try {
    const shardRow = await lookupInShards(key);
    if (shardRow !== undefined) {
      if (!shardRow) return null;
      return packedRowToRecord(shardRow);
    }
  } catch { /* fall through to full-index path */ }

  const viaWorker = postMessage('load', {
    localUrl: ASSESSMENT_INDEX_LOCAL_URL,
    proxyUrl: ASSESSMENT_INDEX_PROXY_URL,
  });
  if (viaWorker) {
    try {
      await viaWorker;
      return await postMessage('lookup', key);
    } catch (err) {
      console.warn('Assessment-index lookup failed:', err.message);
      return null;
    }
  }
  try {
    const parsed = await loadDirect();
    return lookupCore(parsed, key);
  } catch (err) {
    console.warn('Assessment-index lookup failed:', err.message);
    return null;
  }
}

export async function getAssessmentIndexMetadata() {
  const viaWorker = postMessage('load', {
    localUrl: ASSESSMENT_INDEX_LOCAL_URL,
    proxyUrl: ASSESSMENT_INDEX_PROXY_URL,
  });
  if (viaWorker) {
    try { return await postMessage('metadata'); }
    catch { return null; }
  }
  try {
    const parsed = await loadDirect();
    return parsed?.metadata || null;
  } catch {
    return null;
  }
}

/** Walk a parcel FeatureCollection that's already been stamped with
 *  _asmtClass / _asmtStatus values (via the handleSalesUpload loop
 *  in main.js) and return sorted unique lists of each. */
export function uniqueClassesAndStatuses(parcelFc) {
  const classes = new Set();
  const statuses = new Set();
  for (const f of parcelFc?.features || []) {
    const c = String(f.properties?._asmtClass || '').trim();
    const s = String(f.properties?._asmtStatus || '').trim();
    if (c) classes.add(c);
    if (s) statuses.add(s);
  }
  return {
    classes:  [...classes].sort(),
    statuses: [...statuses].sort(),
  };
}

// Convert the packed shard row into the same friendly record shape
// the core module's lookupAssessment returns. Field order matches
// FIELD in assessmentIndex.core.js — DO NOT REORDER without updating
// the core module in lockstep.
function packedRowToRecord(row) {
  if (!Array.isArray(row)) return null;
  const total = Number(row[5]);
  const buildings = Number(row[4]);
  return {
    muni_no:     Number(row[0]),
    roll_no_txt: String(row[1] || ''),
    year:        Number(row[2]),
    land:        Number(row[3]),
    buildings,
    total,
    pctBuildings: total > 0 && Number.isFinite(buildings) ? (buildings / total) : NaN,
    class:       String(row[6] || ''),
    tax_status:  String(row[7] || ''),
  };
}

// Test-only reset.
export function _resetAssessmentIndex() {
  if (worker) { try { worker.terminate(); } catch {} }
  worker = null;
  pending = new Map();
  nextId = 0;
  directIndexPromise = null;
}
