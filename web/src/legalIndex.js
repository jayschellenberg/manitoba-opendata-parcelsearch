// Public API for the legal-index. In a browser environment with
// Worker support, fetch + JSON.parse + search/lookup all run inside
// a dedicated worker (legalIndex.worker.js); the main thread only
// pays the postMessage round-trip + structured-clone for the result
// set, which is bounded at MAX_LEGAL_MATCHES=1000 records. In node
// (tests) and in any environment without Worker support, the same
// functions run synchronously on the main thread via direct calls
// into legalIndex.core.js — the existing single-threaded behavior.
//
// All search/match semantics are defined in legalIndex.core.js so
// both transports share identical behavior.

import { versionedDatasetUrl } from './manifest.js';
import {
  hasLegalCriteria,
  legalRecordKey,
  parcelLegalKey,
  parseLegalIndex,
  searchLegalIndex as searchCore,
  lookupLegalRecordsByParcelKeys as lookupCore,
  lookupLegalRecordsByRollSet as lookupRollsCore,
  lookupLegalRecordsByStrSet as lookupStrCore,
  nearestRollRecords as nearestRollsCore,
  listParishOptions as parishOptionsCore,
  PARISH_LOT_TYPES,
} from './legalIndex.core.js';

// See legalIndex.worker.js for the production hosting story (GitHub
// Release asset served through a Vercel Edge Function in prod, vite
// in-tree copy in dev). The URLs below are passed to the worker —
// keeping them here so they're easy to bump alongside other client
// config.
const LEGAL_INDEX_LOCAL_URL = `${import.meta.env?.BASE_URL || '/'}data/legal-index.json`;
// Production copy on R2 (gzip at rest, ~17 MB on the wire): see MAINTENANCE.md
// §1b. The edge-function proxy stays as the fallback only — it streams the
// 130 MB file from GitHub on every cold browser and can never be edge-cached.
const LEGAL_INDEX_R2_URL = 'https://pub-091058079bf6458da1681945177e1682.r2.dev/legal-index.json';
const LEGAL_INDEX_PROXY_URL = '/api/legal-index';

// Re-export pure helpers so existing call sites in main.js don't break.
export { hasLegalCriteria, legalRecordKey, parcelLegalKey, PARISH_LOT_TYPES };

// Worker singleton + request-id counter. Set lazily so node tests
// (which don't have `Worker` in their global scope) can fall through
// to the in-process implementation without paying for setup.
let worker = null;
let pending = new Map();
let nextId = 0;
// Direct-call cache (used when the worker isn't available). Keeps
// the parsed index in main-thread memory so repeated lookups don't
// re-fetch.
let directIndexPromise = null;
// The single worker 'load' request. Every public call funnels through
// requestWorkerLoad() so the page posts one load and awaits it, rather
// than each caller posting its own (the worker also de-duplicates, but
// one promise here keeps the pending map and the message traffic small).
let workerLoadPromise = null;
const INDEX_URLS = { localUrl: LEGAL_INDEX_LOCAL_URL, r2Url: LEGAL_INDEX_R2_URL, proxyUrl: LEGAL_INDEX_PROXY_URL };

function workerSupported() {
  return typeof Worker !== 'undefined' && typeof import.meta.url === 'string';
}

function ensureWorker() {
  if (worker) return worker;
  if (!workerSupported()) return null;
  try {
    worker = new Worker(new URL('./workers/legalIndex.worker.js', import.meta.url), {
      type: 'module',
    });
  } catch (err) {
    // Some bundler/host combos don't support module workers — fall
    // back to direct execution rather than failing the page load.
    console.warn('Legal-index worker unavailable, falling back to main thread:', err.message);
    worker = null;
    return null;
  }
  worker.addEventListener('message', (ev) => {
    const { id, ok, result, error } = ev.data || {};
    const slot = pending.get(id);
    if (!slot) return;
    pending.delete(id);
    if (ok) slot.resolve(result);
    else slot.reject(new Error(error || 'Legal-index worker failed'));
  });
  worker.addEventListener('error', (err) => {
    // Reject every in-flight request; worker is dead.
    for (const slot of pending.values()) {
      slot.reject(new Error(err?.message || 'Legal-index worker errored'));
    }
    pending.clear();
    worker = null;
    // A replacement worker starts empty, so the next call must post a
    // fresh 'load' rather than reuse the dead worker's resolved one.
    workerLoadPromise = null;
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

// Returns the shared load promise, or null when no worker is available
// (callers then use loadDirect). A failed load clears the slot so the
// next call retries instead of replaying the same rejection forever.
function requestWorkerLoad() {
  if (workerLoadPromise) return workerLoadPromise;
  const p = postMessage('load', INDEX_URLS);
  if (!p) return null;
  const wrapped = p.catch((err) => {
    if (workerLoadPromise === wrapped) workerLoadPromise = null;
    throw err;
  });
  workerLoadPromise = wrapped;
  return wrapped;
}

// ---------- Direct (main-thread) fallback ----------
// Only reached when there is no worker at all (node tests, or a host
// that cannot construct module workers). It never runs alongside a
// pending worker load: requestWorkerLoad() returns that promise first.

async function loadDirect() {
  if (directIndexPromise) return directIndexPromise;
  directIndexPromise = (async () => {
    let json = null;
    try {
      const res = await fetch(LEGAL_INDEX_LOCAL_URL);
      if (res.ok) json = await res.json();
    } catch { /* fall through to R2 */ }
    if (!json) {
      try {
        const res = await fetch(await versionedDatasetUrl(LEGAL_INDEX_R2_URL, 'legal_index'));
        if (res.ok) json = await res.json();
      } catch { /* fall through to proxy */ }
    }
    if (!json) {
      const res = await fetch(await versionedDatasetUrl(LEGAL_INDEX_PROXY_URL, 'legal_index'));
      if (!res.ok) {
        throw new Error(
          `Legal index not available locally (${LEGAL_INDEX_LOCAL_URL}) and the proxy at ${LEGAL_INDEX_PROXY_URL} returned ${res.status}.`
        );
      }
      json = await res.json();
    }
    return parseLegalIndex(json);
  })();
  return directIndexPromise;
}

// ---------- Public API ----------

export function warmLegalIndex() {
  const promise = requestWorkerLoad();
  if (promise) {
    promise.catch((err) => console.warn('Legal-index pre-warm failed:', err.message));
    return;
  }
  loadDirect().catch((err) => console.warn('Legal-index pre-warm failed:', err.message));
}

export async function searchLegalIndex(criteria = {}) {
  if (!hasLegalCriteria(criteria)) {
    return { matches: [], truncated: false, metadata: null };
  }
  const viaWorker = requestWorkerLoad();
  if (viaWorker) {
    await viaWorker; // ensure loaded
    return postMessage('search', criteria);
  }
  const index = await loadDirect();
  return searchCore(index, criteria);
}

export async function lookupLegalRecordsByParcelKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const viaWorker = requestWorkerLoad();
  if (viaWorker) {
    await viaWorker;
    return postMessage('lookup', { keys });
  }
  const index = await loadDirect();
  return lookupCore(index, keys);
}

/**
 * Bulk-lookup records across all munis matching the given set of
 * canonical roll strings. Returns a Map<rollString, Record[]>. Used
 * by the parcel-list import resolver — one scan covers an entire
 * imported list regardless of how many rows there are.
 *
 * The worker transports the map as an array-of-pairs and we
 * rehydrate it here, so callers always get a real Map.
 */
export async function lookupLegalRecordsByRollSet(rolls) {
  const rollList = rolls instanceof Set ? [...rolls] : Array.from(rolls || []);
  if (rollList.length === 0) return new Map();
  const viaWorker = requestWorkerLoad();
  if (viaWorker) {
    await viaWorker;
    const pairs = await postMessage('lookupRolls', { rolls: rollList });
    return new Map(pairs || []);
  }
  const index = await loadDirect();
  return lookupRollsCore(index, rollList);
}

/**
 * Bulk-lookup records by canonical section-township-range token
 * ("NE|27|7|4|E"). Used by the parcel-list resolver for rows that
 * carry only a grid legal description. Returns Map<token, Record[]>.
 */
export async function lookupLegalRecordsByStrSet(tokens) {
  const tokenList = tokens instanceof Set ? [...tokens] : Array.from(tokens || []);
  if (tokenList.length === 0) return new Map();
  const viaWorker = requestWorkerLoad();
  if (viaWorker) {
    await viaWorker;
    const pairs = await postMessage('lookupStr', { tokens: tokenList });
    return new Map(pairs || []);
  }
  const index = await loadDirect();
  return lookupStrCore(index, tokenList);
}

/**
 * Nearest-numbered rolls in one municipality, below and above each wanted
 * roll. See legalIndex.core.js nearestRollRecords. Returns
 * Map<roll, { below: Record[], above: Record[] }>.
 */
export async function lookupNearestRolls(muniNo, rolls, opts = {}) {
  const rollList = Array.from(rolls || []);
  if (rollList.length === 0) return new Map();
  const viaWorker = requestWorkerLoad();
  if (viaWorker) {
    await viaWorker;
    const pairs = await postMessage('nearestRolls', { muniNo, rolls: rollList, opts });
    return new Map(pairs || []);
  }
  const index = await loadDirect();
  return nearestRollsCore(index, muniNo, rollList, opts);
}

/**
 * Parish codes present in the index — `[{ code, name, count }]` sorted
 * by name. Feeds the data-derived Parish dropdown in the Advanced
 * searches group. The first call pays the index's derived-token pass
 * (a one-time full scan); repeats are cheap.
 */
export async function getParishOptions() {
  const viaWorker = requestWorkerLoad();
  if (viaWorker) {
    await viaWorker;
    return postMessage('parishOptions');
  }
  const index = await loadDirect();
  return parishOptionsCore(index);
}

export async function getLegalIndexMetadata() {
  const viaWorker = requestWorkerLoad();
  if (viaWorker) {
    return postMessage('metadata');
  }
  try {
    const index = await loadDirect();
    return index?.metadata || null;
  } catch {
    return null;
  }
}

// Test-only reset (clears worker + direct cache so tests can re-init).
export function _resetLegalIndex() {
  if (worker) { try { worker.terminate(); } catch {} }
  worker = null;
  pending = new Map();
  nextId = 0;
  directIndexPromise = null;
  workerLoadPromise = null;
}
