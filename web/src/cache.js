// Persistent cache used by arcgis.js for muni-scoped feature
// collections (Roll Layer parcels, survey grid, MASC ratings, ...)
// and the various distinct-values dropdowns.
//
// Storage strategy:
//
//   1. IndexedDB (primary). Survives across tabs/sessions, no
//      practical quota (browsers grant 50%+ of disk to a single
//      origin), and never falls into the localStorage 5-10 MB cliff
//      that the Roll Layer's 6-10 MB muni FCs were already brushing
//      against.
//   2. localStorage (fallback). Triggered when IDB is unavailable
//      (private-browsing in some browsers blocks IDB, plus the
//      first-load race where the DB hasn't opened yet) or when an
//      IDB write fails for an unexpected reason. Same envelope
//      shape as the legacy cache so older entries written by the
//      previous localStorage-only implementation read transparently
//      after the swap.
//
// Envelope: { v: <value>, t: <unix-ms> }. Reads pass a TTL; entries
// older than TTL are treated as missing. Same semantics as the old
// in-line readCache/writeCache that lived in arcgis.js — this file
// is a drop-in replacement, just async.

const DB_NAME = 'mb-parcel-search';
const DB_VERSION = 1;
const STORE_NAME = 'cache';
// Namespace prefix on every key so a single clearAll() in main.js can
// recognise our entries and leave unrelated localStorage data alone
// (user-facing favourites, recent uploads, etc. use their own keys).
const CACHE_NS_PREFIX = 'mbpsCache.';

let dbPromise = null;
let idbAvailable = typeof indexedDB !== 'undefined';

function openDb() {
  if (!idbAvailable) return Promise.reject(new Error('IndexedDB not available'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
  // Mark IDB as unavailable on permanent failure so we stop trying.
  dbPromise.catch(() => { idbAvailable = false; dbPromise = null; });
  return dbPromise;
}

// Run an IDB operation inside a fresh transaction. Returns a Promise.
function idbOp(mode, op) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let result;
    Promise.resolve(op(store))
      .then((r) => { result = r; })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB tx error'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB tx aborted'));
  }));
}

function idbGet(key) {
  return idbOp('readonly', (store) => new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbPut(key, value) {
  return idbOp('readwrite', (store) => new Promise((resolve, reject) => {
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}

function idbDelete(key) {
  return idbOp('readwrite', (store) => new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}

function idbKeys() {
  return idbOp('readonly', (store) => new Promise((resolve, reject) => {
    const req = store.getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

// localStorage fallback: same envelope, same namespacing.
function lsGet(key) {
  try {
    const namespaced = `${CACHE_NS_PREFIX}${key}`;
    const raw = (typeof localStorage !== 'undefined' && localStorage.getItem(namespaced))
      || (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(key));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function lsPut(key, envelope) {
  if (typeof localStorage === 'undefined') return false;
  const namespaced = `${CACHE_NS_PREFIX}${key}`;
  const serialized = JSON.stringify(envelope);
  try {
    localStorage.setItem(namespaced, serialized);
    return true;
  } catch {
    // Quota exceeded — evict any of our older namespaced entries and retry.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CACHE_NS_PREFIX) && k !== namespaced) {
          localStorage.removeItem(k);
        }
      }
      localStorage.setItem(namespaced, serialized);
      return true;
    } catch {
      return false;
    }
  }
}

function lsDelete(key) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`${CACHE_NS_PREFIX}${key}`);
    }
  } catch { /* ignore */ }
}

// Validate the parsed envelope and return { value, ageMs }, or null if
// it's expired or malformed. Wraps the legacy unwrapped-array shape
// that some sessionStorage-era entries carried so we still accept
// those without breaking (they carry no timestamp, so they read as
// age 0 — the same "valid forever" treatment they always had).
function unwrapEntry(parsed, ttlMs) {
  if (parsed == null) return null;
  if (typeof parsed === 'object' && !Array.isArray(parsed) && 't' in parsed && 'v' in parsed) {
    const ageMs = Date.now() - parsed.t;
    if (ageMs > ttlMs) return null;
    const v = parsed.v;
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return { value: v, ageMs };
    return null;
  }
  // Legacy unwrapped value (older code wrote the value directly).
  if (Array.isArray(parsed)) return { value: parsed, ageMs: 0 };
  if (typeof parsed === 'object') return { value: parsed, ageMs: 0 };
  return null;
}

function unwrapEnvelope(parsed, ttlMs) {
  const entry = unwrapEntry(parsed, ttlMs);
  return entry ? entry.value : null;
}

function normalizeTtl(ttlMs) {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return 7 * 24 * 60 * 60 * 1000;
  }
  return ttlMs;
}

/**
 * Like readCache, but returns `{ value, ageMs }` so a caller can serve a
 * cached value it considers stale while it refreshes behind the scenes
 * (stale-while-revalidate). `ttlMs` is the HARD limit — older entries
 * are treated as missing exactly as in readCache; freshness beyond that
 * is the caller's decision, made from `ageMs`.
 */
export async function readCacheEntry(key, ttlMs) {
  ttlMs = normalizeTtl(ttlMs);
  if (idbAvailable) {
    try {
      const entry = unwrapEntry(await idbGet(key), ttlMs);
      if (entry !== null) return entry;
    } catch { /* fall through to localStorage */ }
  }
  return unwrapEntry(lsGet(key), ttlMs);
}

/**
 * Read a cached value by key. Returns null on miss, expiry, or any
 * underlying error. Prefers IndexedDB; falls back to localStorage so
 * the swap doesn't blow away entries written by the legacy
 * implementation.
 */
export async function readCache(key, ttlMs) {
  const entry = await readCacheEntry(key, ttlMs);
  return entry ? entry.value : null;
}

/**
 * Write a value to cache under `key`. Wraps in the timestamp envelope
 * automatically. Tries IndexedDB first; falls back to localStorage
 * when IDB is unavailable OR an IDB write fails. Returns true if
 * either storage accepted the write, false if both failed.
 */
export async function writeCache(key, value) {
  const envelope = { v: value, t: Date.now() };
  if (idbAvailable) {
    try {
      await idbPut(key, envelope);
      return true;
    } catch { /* fall through to localStorage */ }
  }
  return lsPut(key, envelope);
}

/**
 * Wipe every namespaced cache entry from both IDB and localStorage.
 * Called by main.js's clearAll() so a hard reset returns the user to
 * a fresh state across both backends.
 */
export async function clearAllCache() {
  if (idbAvailable) {
    try {
      const keys = await idbKeys();
      for (const k of keys) {
        try { await idbDelete(k); } catch { /* ignore per-key errors */ }
      }
    } catch { /* IDB unavailable, fall through */ }
  }
  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CACHE_NS_PREFIX)) localStorage.removeItem(k);
      }
    }
  } catch { /* ignore */ }
}

/**
 * Delete a single cache entry from both backends. Used when a stale
 * version is detected during read (e.g. a manifest swap).
 */
export async function deleteCache(key) {
  if (idbAvailable) {
    try { await idbDelete(key); } catch { /* ignore */ }
  }
  lsDelete(key);
}

// Internal helpers exposed for unit tests; not part of the public
// surface. Treat as @internal.
export const _internal = { unwrapEnvelope, CACHE_NS_PREFIX };
