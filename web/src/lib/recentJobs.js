/*
 * Recent job files (2026-10-07): the last few jobs saved or opened in this
 * browser, so reopening yesterday's assignment is one pick instead of a hunt
 * through Downloads.
 *
 * IndexedDB, not localStorage: a job embeds its sales CSV and can run to a
 * few MB, and localStorage's ~5 MB budget is already shared with the recent
 * sales uploads and the muni shard cache. Its own database, so it can never
 * collide with the sales archive's (lib/salesStore.js).
 *
 * Every call degrades to "no recent jobs" when IndexedDB is unavailable
 * (private windows, blocked storage) — the list is a convenience, the job
 * files themselves are the record.
 */

const DB_NAME = 'mbps_recent_jobs';
const DB_VERSION = 1;
const STORE = 'jobs';
/** How many jobs are kept; the least recently used drop off. */
export const RECENT_JOBS_CAP = 8;

/**
 * Newest-used first, capped. Pure, for test/recentJobs.test.js. Returns
 * `{ keep, drop }` so the caller can delete what falls off the end.
 */
export function orderAndCap(records, cap = RECENT_JOBS_CAP) {
  const sorted = [...(records || [])]
    .filter((r) => r && r.id)
    .sort((a, b) => String(b.usedAt || '').localeCompare(String(a.usedAt || '')));
  return { keep: sorted.slice(0, cap), drop: sorted.slice(cap) };
}

/** A job's identity: the same saved job reopened replaces its entry. */
export function recentJobId(job) {
  return `${job?.savedAt || ''}|${job?.name || ''}`;
}

export function recentJobsAvailable() {
  return typeof indexedDB !== 'undefined';
}

let dbPromise = null;
function openDb() {
  if (!recentJobsAvailable()) return Promise.reject(new Error('IndexedDB unavailable'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => { dbPromise = null; throw err; });
  }
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/**
 * Remember a job (its full text, so it reopens without the file) and drop
 * whatever falls past the cap. Never throws: a full disk or a blocked store
 * just means the list does not update.
 */
export async function addRecentJob(job, text) {
  try {
    const rec = {
      id: recentJobId(job),
      name: job?.name || 'Job',
      savedAt: job?.savedAt || '',
      usedAt: new Date().toISOString(),
      size: String(text || '').length,
      text: String(text || ''),
    };
    await run('readwrite', (s) => s.put(rec));
    const all = await run('readonly', (s) => s.getAll());
    const { drop } = orderAndCap(all);
    if (drop.length) await run('readwrite', (s) => { for (const r of drop) s.delete(r.id); });
  } catch (err) {
    console.warn('Recent jobs: could not remember this job', err);
  }
}

/** The list, newest-used first, without the job text. */
export async function listRecentJobs() {
  try {
    const all = await run('readonly', (s) => s.getAll());
    return orderAndCap(all).keep.map(({ text, ...meta }) => { void text; return meta; });
  } catch {
    return [];
  }
}

/** One job's full record (with its text), or null. */
export async function getRecentJob(id) {
  try { return (await run('readonly', (s) => s.get(id))) || null; } catch { return null; }
}

export async function clearRecentJobs() {
  try { await run('readwrite', (s) => s.clear()); } catch { /* nothing to clear */ }
}
