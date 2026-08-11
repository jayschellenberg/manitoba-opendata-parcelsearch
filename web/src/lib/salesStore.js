// salesStore.js — the imported MAO sales database, held locally in the browser.
//
// WHAT THIS IS. The Sales Analysis tab can use a full scraped MAO sales archive
// as a source instead of pasting a comp set each time. That archive is paid
// subscriber data, so it is NEVER hosted: the site ships none of it, the server
// never sees it, and nothing is uploaded. The user nominates a folder on their
// own disk once; we read it locally and keep it in IndexedDB. A visitor without
// that folder simply has no sales source — the gate is absence, not a password.
//
// WHY A SEPARATE DATABASE from cache.js. That module owns 'mb-parcel-search' and
// exists to cache regenerable things, with a TTL and a clearAll() that is meant
// to wipe them. An imported archive is USER DATA — losing it means re-importing
// ~150 MB — so it lives in its own database with no TTL and no participation in
// cache clearing.
//
// WHY RAW TEXT PER MUNICIPALITY, PARSED ON DEMAND. Import is then I/O-bound and
// quick, and selecting three municipalities parses ~3 MB rather than scanning
// 150. It also reuses parseSalesCsv unchanged — the same path the paste flow
// already takes — so there is one parser, not two.
//
// WHY A DIRECTORY HANDLE. With the File System Access API the browser can keep a
// handle to the nominated folder. When the weekly scrape rewrites those files in
// Dropbox, we notice on the next visit and re-import without the user doing
// anything. Chrome and Edge support it; Firefox and Safari fall back to a manual
// file picker, which still works, just without the auto-refresh.

import { countDataRows } from './delimitedRows.js';

const DB_NAME = 'mb-parcel-sales';
const DB_VERSION = 1;
const SHARDS = 'shards';   // key: muni_no  -> { muni_no, municipality, csv, meta }
const META   = 'meta';     // key: 'manifest' | 'dirHandle' | 'importState'

let dbPromise = null;

export function salesDbAvailable() {
  return typeof indexedDB !== 'undefined';
}

function openDb() {
  if (!salesDbAvailable()) return Promise.reject(new Error('IndexedDB not available'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(SHARDS)) db.createObjectStore(SHARDS);
      if (!db.objectStoreNames.contains(META))   db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error || new Error('sales DB open failed'));
    req.onblocked = () => reject(new Error('sales DB open blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(storeName, mode, op) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let out;
    Promise.resolve(op(store)).then((r) => { out = r; }).catch(reject);
    t.oncomplete = () => resolve(out);
    t.onerror    = () => reject(t.error || new Error('sales tx error'));
    t.onabort    = () => reject(t.error || new Error('sales tx aborted'));
  }));
}

const req2promise = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror   = () => rej(r.error);
});

// ---------------------------------------------------------------------------
// Primitive accessors
// ---------------------------------------------------------------------------
export const getMeta = (k)    => tx(META, 'readonly',  (s) => req2promise(s.get(k)));
export const putMeta = (k, v) => tx(META, 'readwrite', (s) => req2promise(s.put(v, k)));

export const getShard  = (muniNo) => tx(SHARDS, 'readonly',  (s) => req2promise(s.get(String(muniNo))));
export const putShard  = (rec)    => tx(SHARDS, 'readwrite', (s) => req2promise(s.put(rec, String(rec.muni_no))));
export const listShardKeys = ()   => tx(SHARDS, 'readonly',  (s) => req2promise(s.getAllKeys()));

export function clearSales() {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction([SHARDS, META], 'readwrite');
    t.objectStore(SHARDS).clear();
    t.objectStore(META).clear();
    t.oncomplete = () => resolve(true);
    t.onerror    = () => reject(t.error);
  }));
}

/** Manifest describing what is imported, without touching a single shard. */
export const getManifest = () => getMeta('manifest');

/**
 * Sales for one or more municipalities, as raw CSV text.
 * Returns [{ muni_no, municipality, csv }] — callers pass `csv` to
 * parseSalesCsv, exactly as the paste/upload path does.
 */
export async function getSalesFor(muniNos) {
  const wanted = (Array.isArray(muniNos) ? muniNos : [muniNos]).map(String);
  const out = [];
  for (const m of wanted) {
    const rec = await getShard(m);
    if (rec && rec.csv) out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Durable storage
// ---------------------------------------------------------------------------
// Without this the browser may evict a ~150 MB archive under disk pressure and
// the user silently loses their source. Requesting persistence makes eviction a
// last resort. Chrome usually grants it silently for a site the user has
// engaged with; a refusal is not fatal, just worth surfacing.
export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return { supported: false };
    const already = await navigator.storage.persisted();
    if (already) return { supported: true, persisted: true };
    const granted = await navigator.storage.persist();
    return { supported: true, persisted: granted };
  } catch { return { supported: false }; }
}

export async function storageEstimate() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// File System Access — the auto-refresh path
// ---------------------------------------------------------------------------
export function fsAccessSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Ask the user to nominate the export folder. Requires a user gesture. */
export async function pickSalesDirectory() {
  if (!fsAccessSupported()) throw new Error('File System Access not supported in this browser');
  const handle = await window.showDirectoryPicker({ id: 'mao-sales', mode: 'read' });
  await putMeta('dirHandle', handle);   // handles are structured-cloneable
  return handle;
}

export const getSavedDirectory = () => getMeta('dirHandle');

/**
 * Permission state for a saved handle: 'granted' | 'prompt' | 'denied' | 'none'.
 * Chrome deliberately drops a handle back to 'prompt' between sessions, so the
 * caller re-grants with one click — the user never re-picks the folder.
 */
export async function directoryPermission(handle, { request = false } = {}) {
  if (!handle) return 'none';
  try {
    const opts = { mode: 'read' };
    let state = await handle.queryPermission(opts);
    if (state === 'prompt' && request) state = await handle.requestPermission(opts);
    return state;
  } catch { return 'denied'; }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
const MUNI_FILE_RE = /^muni_(\d+)\.csv$/i;

// Bump when the row COUNT changes meaning, so already-imported shards get
// recounted on the next import (see `recount` below).
//   1 -> naive physical-line count (inflated by stacked multi-parcel cells)
//   2 -> quote-aware countDataRows()
const ROW_COUNT_VERSION = 2;

/**
 * Read an export folder into IndexedDB.
 *
 * Skips shards whose source file has not changed since last import, so a weekly
 * refresh that touched three municipalities re-reads three files, not 186.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {(p:{done:number,total:number,label:string})=>void} [onProgress]
 * @param {boolean} [force] re-read every file regardless of mtime
 */
export async function importFromDirectory(dirHandle, { onProgress, force = false } = {}) {
  const files = [];
  let manifest = null;

  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue;
    if (/^manifest\.json$/i.test(name)) { manifest = handle; continue; }
    const m = name.match(MUNI_FILE_RE);
    if (m) files.push({ muniNo: m[1], name, handle });
  }
  if (!files.length) {
    throw new Error('No muni_*.csv files found in that folder. Pick the MAOSales export folder.');
  }

  // The manifest is advisory — municipality names and counts for display. A
  // folder without one still imports; we just derive less.
  let manifestData = null;
  if (manifest) {
    try { manifestData = JSON.parse(await (await manifest.getFile()).text()); } catch { /* optional */ }
  }
  const nameByMuni = new Map(
    (manifestData?.munis || []).map((x) => [String(x.muni_no), x.municipality]));

  const prev = (await getMeta('importState')) || { mtimes: {} };
  const mtimes = { ...prev.mtimes };
  // A shard's cached meta.rows was produced by whatever counter shipped at
  // import time, and the mtime skip below means a corrected counter would
  // otherwise never be applied to already-imported shards — the wrong total
  // would persist until the source file happened to change. Bumping
  // ROW_COUNT_VERSION re-reads everything once, so a counting fix heals
  // itself on the next import instead of needing a manual force.
  const recount = prev.rowCountVersion !== ROW_COUNT_VERSION;
  let imported = 0, skipped = 0, rows = 0;

  for (let i = 0; i < files.length; i++) {
    const { muniNo, name, handle } = files[i];
    const file = await handle.getFile();
    onProgress?.({ done: i, total: files.length, label: nameByMuni.get(muniNo) || name });

    if (!force && !recount && mtimes[muniNo] === file.lastModified) {
      const existing = await getShard(muniNo);
      if (existing) { skipped++; rows += existing.meta?.rows || 0; continue; }
    }

    const csv = await file.text();
    // Quote-aware: a multi-parcel sale stacks its parcels on newlines INSIDE
    // quoted cells, so splitting the raw text counts each parcel as a sale.
    const nRows = countDataRows(csv);
    await putShard({
      muni_no: muniNo,
      municipality: nameByMuni.get(muniNo) || null,
      csv,
      meta: { rows: nRows, bytes: file.size, source_mtime: file.lastModified,
              imported_at: Date.now(), file: name },
    });
    mtimes[muniNo] = file.lastModified;
    imported++; rows += nRows;
  }

  onProgress?.({ done: files.length, total: files.length, label: 'done' });

  const summary = {
    municipalities: files.length,
    imported, skipped, rows,
    generated_at: manifestData?.generated_at || null,
    newest_sale: manifestData?.newest_sale || null,
    imported_at: new Date().toISOString(),
  };
  await putMeta('manifest', { ...(manifestData || {}), ...summary, munis: manifestData?.munis || null });
  await putMeta('importState', { mtimes, rowCountVersion: ROW_COUNT_VERSION });
  return summary;
}

/**
 * Has the source folder changed since we last imported? Cheap — stats files,
 * reads none. Returns null when we cannot tell (no handle, permission not
 * granted) so the caller can stay quiet rather than nag.
 */
export async function checkForUpdates(dirHandle) {
  if (!dirHandle) return null;
  if ((await directoryPermission(dirHandle)) !== 'granted') return null;
  const prev = (await getMeta('importState')) || { mtimes: {} };
  const changed = [];
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== 'file') continue;
      const m = name.match(MUNI_FILE_RE);
      if (!m) continue;
      const file = await handle.getFile();
      if (prev.mtimes[m[1]] !== file.lastModified) changed.push(m[1]);
    }
  } catch { return null; }
  return { changed, count: changed.length };
}

/**
 * Fallback for browsers without File System Access: import from File objects
 * (an <input webkitdirectory> pick or a drag-drop). No handle is retained, so
 * there is no auto-refresh — the user re-imports when they want fresher data.
 */
export async function importFromFileList(fileList, { onProgress } = {}) {
  const files = Array.from(fileList || []);
  const manifestFile = files.find((f) => /manifest\.json$/i.test(f.name));
  const shardFiles = files.filter((f) => MUNI_FILE_RE.test(f.name.split('/').pop()));
  if (!shardFiles.length) throw new Error('No muni_*.csv files in that selection.');

  let manifestData = null;
  if (manifestFile) { try { manifestData = JSON.parse(await manifestFile.text()); } catch { /* optional */ } }
  const nameByMuni = new Map((manifestData?.munis || []).map((x) => [String(x.muni_no), x.municipality]));

  let rows = 0;
  for (let i = 0; i < shardFiles.length; i++) {
    const f = shardFiles[i];
    const muniNo = f.name.split('/').pop().match(MUNI_FILE_RE)[1];
    onProgress?.({ done: i, total: shardFiles.length, label: nameByMuni.get(muniNo) || f.name });
    const csv = await f.text();
    const nRows = countDataRows(csv);   // quote-aware, as above
    await putShard({
      muni_no: muniNo, municipality: nameByMuni.get(muniNo) || null, csv,
      meta: { rows: nRows, bytes: f.size, source_mtime: f.lastModified,
              imported_at: Date.now(), file: f.name },
    });
    rows += nRows;
  }
  onProgress?.({ done: shardFiles.length, total: shardFiles.length, label: 'done' });

  const summary = {
    municipalities: shardFiles.length, imported: shardFiles.length, skipped: 0, rows,
    generated_at: manifestData?.generated_at || null,
    newest_sale: manifestData?.newest_sale || null,
    imported_at: new Date().toISOString(),
    no_handle: true,
  };
  await putMeta('manifest', { ...(manifestData || {}), ...summary, munis: manifestData?.munis || null });
  return summary;
}

/**
 * Build one CSV covering the selected municipalities, in the exact
 * `{ name, text }` shape handleSalesUpload() already accepts from the Recent
 * uploads picker. That is the whole integration: the database becomes another
 * way to hand the existing pipeline a CSV, so parsing, roll lookup, enrichment
 * and charting are untouched.
 *
 * Each shard carries its own header row, so every header after the first must
 * be dropped — concatenating them raw would inject header text as data rows,
 * which parseSalesCsv would happily accept as a sale with a date of "sale_date".
 * Headers are also compared: a mismatch means shards from different export
 * versions got mixed, and silently interleaving those would misalign columns.
 */
export async function buildCsvFor(muniNos, { manifest } = {}) {
  const recs = await getSalesFor(muniNos);
  if (!recs.length) return null;

  let header = null;
  const bodies = [];
  for (const r of recs) {
    const nl = r.csv.indexOf('\n');
    const h = (nl === -1 ? r.csv : r.csv.slice(0, nl)).replace(/\r$/, '');
    const body = nl === -1 ? '' : r.csv.slice(nl + 1);
    if (header === null) header = h;
    else if (h !== header) {
      throw new Error(
        `Sales shards have different columns (municipality ${r.muni_no} differs). ` +
        'Re-import the whole export folder so every shard is the same version.');
    }
    const trimmed = body.replace(/\s+$/, '');
    if (trimmed) bodies.push(trimmed);
  }
  if (header === null) return null;

  const names = recs.map((r) => r.municipality || `Muni ${r.muni_no}`);
  const label = names.length <= 3
    ? names.join(', ')
    : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;

  return {
    name: `MAO database — ${label}`,
    text: [header, ...bodies].join('\n') + '\n',
    municipalities: recs.map((r) => r.muni_no),
    generated_at: manifest?.generated_at || null,
  };
}

/** Everything the UI needs to describe the imported database. */
export async function describeImport() {
  const manifest = await getManifest();
  if (!manifest) return { present: false };
  const keys = await listShardKeys();
  return {
    present: keys.length > 0,
    municipalities: keys.length,
    sales: manifest.rows || manifest.sales || 0,
    newest_sale: manifest.newest_sale || null,
    generated_at: manifest.generated_at || null,
    imported_at: manifest.imported_at || null,
    auto_refresh: !manifest.no_handle && fsAccessSupported(),
    munis: manifest.munis || null,
  };
}
