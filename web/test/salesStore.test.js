// Unit tests for src/lib/salesStore.js — the locally-imported MAO sales archive.
//
// Polyfills a small in-memory IndexedDB plus fake File System Access handles so
// the store's logic runs without a browser. As with cache.test.js the goal is
// not IDB fidelity; it is to pin the behaviours that would silently corrupt an
// appraiser's source of truth:
//
//   * Re-import must SKIP files whose mtime is unchanged. This is what makes the
//     weekly auto-refresh cheap — a refresh that touched three municipalities
//     must re-read three files, not 186. Break it and every visit re-parses
//     ~150 MB.
//   * Re-import must RE-READ a file whose mtime moved, and replace the shard.
//     Break it and the app quietly serves last month's sales forever.
//   * getSalesFor must return ONLY the municipalities asked for. Comparable
//     selection is a few munis at a time; leaking extras would silently widen
//     the comp set.
//   * clearSales must wipe shards AND meta together, or a stale manifest claims
//     data that is no longer there.
//
// Run: cd web && node test/salesStore.test.js

import assert from 'node:assert/strict';

// ---------- In-memory IndexedDB shim ----------
class Req {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
  _resolve(r) { this.result = r; queueMicrotask(() => this.onsuccess && this.onsuccess({ target: this })); }
}
class Store {
  constructor(map) { this._m = map; }
  get(k) { const r = new Req(); r._resolve(this._m.has(k) ? this._m.get(k) : undefined); return r; }
  put(v, k) { const r = new Req(); this._m.set(k, v); r._resolve(undefined); return r; }
  getAllKeys() { const r = new Req(); r._resolve([...this._m.keys()]); return r; }
  clear() { const r = new Req(); this._m.clear(); r._resolve(undefined); return r; }
}
class Tx {
  constructor(db, names) {
    this._db = db; this._names = Array.isArray(names) ? names : [names];
    this.oncomplete = null; this.onerror = null; this.onabort = null; this.error = null;
    // Complete after the caller's microtasks settle, mirroring real IDB.
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() =>
      this.oncomplete && this.oncomplete())));
  }
  objectStore(name) {
    if (!this._db._stores.has(name)) throw new Error('no such store: ' + name);
    return new Store(this._db._stores.get(name));
  }
}
class Db {
  constructor() { this._stores = new Map(); this.objectStoreNames = { contains: (n) => this._stores.has(n) }; }
  createObjectStore(n) { this._stores.set(n, new Map()); return new Store(this._stores.get(n)); }
  transaction(names) { return new Tx(this, names); }
}
const dbs = new Map();
globalThis.indexedDB = {
  open(name) {
    const req = new Req();
    let db = dbs.get(name);
    const fresh = !db;
    if (fresh) { db = new Db(); dbs.set(name, db); }
    queueMicrotask(() => {
      if (fresh && req.onupgradeneeded) req.onupgradeneeded({ target: { result: db } });
      req._resolve(db);
    });
    return req;
  },
};

// ---------- Fake File System Access ----------
function fakeFile(name, text, lastModified) {
  return { name, size: text.length, lastModified, text: async () => text };
}
function fakeFileHandle(name, text, lastModified) {
  return { kind: 'file', name, getFile: async () => fakeFile(name, text, lastModified) };
}
function fakeDir(entries) {
  return {
    kind: 'directory',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async *entries() { for (const [n, h] of Object.entries(entries)) yield [n, h]; },
  };
}

const CSV_400 = 'muni_no,municipality,sale_date,consideration\n400,ALTONA,"Jul 21, 2026","$510,000"\n400,ALTONA,"Jul 16, 2026","$330,000"\n';
const CSV_500 = 'muni_no,municipality,sale_date,consideration\n500,BRANDON,"Jul 20, 2026","$275,000"\n';
const MANIFEST = JSON.stringify({
  generated_at: '2026-08-10T09:00:00-0500', newest_sale: '2026-07-21',
  munis: [{ muni_no: '400', municipality: 'TOWN OF ALTONA' }, { muni_no: '500', municipality: 'CITY OF BRANDON' }],
});

const store = await import('../src/lib/salesStore.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('salesStore');

await test('imports muni shards and the manifest', async () => {
  await store.clearSales();
  const dir = fakeDir({
    'manifest.json': fakeFileHandle('manifest.json', MANIFEST, 1000),
    'muni_400.csv': fakeFileHandle('muni_400.csv', CSV_400, 1000),
    'muni_500.csv': fakeFileHandle('muni_500.csv', CSV_500, 1000),
  });
  const s = await store.importFromDirectory(dir);
  assert.equal(s.municipalities, 2);
  assert.equal(s.imported, 2);
  assert.equal(s.rows, 3, 'two Altona sales + one Brandon, header excluded');
  assert.equal(s.newest_sale, '2026-07-21');
});

await test('municipality names come from the manifest', async () => {
  const rec = await store.getShard('400');
  assert.equal(rec.municipality, 'TOWN OF ALTONA');
});

await test('re-import SKIPS files whose mtime is unchanged', async () => {
  const dir = fakeDir({
    'manifest.json': fakeFileHandle('manifest.json', MANIFEST, 1000),
    'muni_400.csv': fakeFileHandle('muni_400.csv', CSV_400, 1000),
    'muni_500.csv': fakeFileHandle('muni_500.csv', CSV_500, 1000),
  });
  const s = await store.importFromDirectory(dir);
  assert.equal(s.imported, 0, 'nothing changed, so nothing re-read');
  assert.equal(s.skipped, 2);
});

await test('re-import RE-READS a file whose mtime moved', async () => {
  const updated = CSV_400 + '400,ALTONA,"Jul 22, 2026","$999,000"\n';
  const dir = fakeDir({
    'manifest.json': fakeFileHandle('manifest.json', MANIFEST, 1000),
    'muni_400.csv': fakeFileHandle('muni_400.csv', updated, 2000),   // newer
    'muni_500.csv': fakeFileHandle('muni_500.csv', CSV_500, 1000),
  });
  const s = await store.importFromDirectory(dir);
  assert.equal(s.imported, 1, 'only the changed municipality is re-read');
  assert.equal(s.skipped, 1);
  const rec = await store.getShard('400');
  assert.ok(rec.csv.includes('$999,000'), 'shard replaced with the new content');
  assert.equal(rec.meta.rows, 3);
});

await test('force re-reads everything', async () => {
  const dir = fakeDir({
    'muni_400.csv': fakeFileHandle('muni_400.csv', CSV_400, 2000),
    'muni_500.csv': fakeFileHandle('muni_500.csv', CSV_500, 1000),
  });
  const s = await store.importFromDirectory(dir, { force: true });
  assert.equal(s.imported, 2);
});

await test('getSalesFor returns ONLY the requested municipalities', async () => {
  const got = await store.getSalesFor(['400']);
  assert.equal(got.length, 1);
  assert.equal(got[0].muni_no, '400');
  const both = await store.getSalesFor(['400', '500']);
  assert.equal(both.length, 2);
  const none = await store.getSalesFor(['999']);
  assert.equal(none.length, 0, 'a municipality not imported yields nothing, not everything');
});

await test('checkForUpdates spots a changed file without reading it', async () => {
  const dir = fakeDir({
    'muni_400.csv': fakeFileHandle('muni_400.csv', CSV_400, 5000),   // moved again
    'muni_500.csv': fakeFileHandle('muni_500.csv', CSV_500, 1000),
  });
  const upd = await store.checkForUpdates(dir);
  assert.equal(upd.count, 1);
  assert.deepEqual(upd.changed, ['400']);
});

await test('rejects a folder with no muni_*.csv', async () => {
  const dir = fakeDir({ 'notes.txt': fakeFileHandle('notes.txt', 'hi', 1) });
  await assert.rejects(() => store.importFromDirectory(dir), /No muni_\*\.csv/);
});

await test('describeImport reports coverage without parsing shards', async () => {
  const d = await store.describeImport();
  assert.equal(d.present, true);
  assert.equal(d.municipalities, 2);
  assert.ok(d.imported_at, 'records when it was imported');
});

await test('file-list fallback imports without a directory handle', async () => {
  await store.clearSales();
  const files = [
    Object.assign(fakeFile('manifest.json', MANIFEST, 1), { name: 'manifest.json' }),
    Object.assign(fakeFile('muni_400.csv', CSV_400, 1), { name: 'muni_400.csv' }),
  ];
  const s = await store.importFromFileList(files);
  assert.equal(s.imported, 1);
  assert.equal(s.no_handle, true, 'flagged so the UI does not promise auto-refresh');
  const d = await store.describeImport();
  assert.equal(d.auto_refresh, false);
});

await test('buildCsvFor merges shards with exactly ONE header row', async () => {
  await store.clearSales();
  const dir = fakeDir({
    'manifest.json': fakeFileHandle('manifest.json', MANIFEST, 1),
    'muni_400.csv': fakeFileHandle('muni_400.csv', CSV_400, 1),
    'muni_500.csv': fakeFileHandle('muni_500.csv', CSV_500, 1),
  });
  await store.importFromDirectory(dir);

  const out = await store.buildCsvFor(['400', '500']);
  const lines = out.text.trim().split('\n');
  assert.equal(lines.length, 4, '1 header + 2 Altona + 1 Brandon');
  assert.equal(lines[0], 'muni_no,municipality,sale_date,consideration');
  const headerRows = lines.filter((l) => l.startsWith('muni_no,'));
  assert.equal(headerRows.length, 1, 'a second header would parse as a bogus sale');
  assert.ok(lines.some((l) => l.startsWith('400,')));
  assert.ok(lines.some((l) => l.startsWith('500,')));
});

await test('buildCsvFor names the selection for the uploads list', async () => {
  const one = await store.buildCsvFor(['400']);
  assert.match(one.name, /TOWN OF ALTONA/);
  const both = await store.buildCsvFor(['400', '500']);
  assert.match(both.name, /ALTONA/);
  assert.match(both.name, /BRANDON/);
});

await test('buildCsvFor returns null when nothing matches', async () => {
  assert.equal(await store.buildCsvFor(['999']), null);
});

await test('buildCsvFor refuses to merge shards with different columns', async () => {
  await store.putShard({
    muni_no: '600', municipality: 'ODD ONE',
    csv: 'muni_no,sale_date,extra_col\n600,"Jan 01, 2020",x\n', meta: { rows: 1 },
  });
  await assert.rejects(() => store.buildCsvFor(['400', '600']), /different columns/);
});

await test('a manifest adjacency field survives every shape jsonlite emits', async () => {
  // Regression: the export unboxed a single neighbour to a bare string and
  // rendered "no neighbours" as {}. Both hit `.map is not a function` in the
  // panel and failed the ENTIRE import — one odd municipality took the whole
  // archive down. Mirrors normalizeAdjacent() in salesDbPanel.js.
  const normalize = (v) => {
    if (Array.isArray(v)) return v.map(String);
    if (v == null) return [];
    if (typeof v === 'object') return Object.values(v).map(String);
    return [String(v)];
  };
  assert.deepEqual(normalize(['135', '138']), ['135', '138']);
  assert.deepEqual(normalize('175'), ['175'], 'single neighbour unboxed to a string');
  assert.deepEqual(normalize({}), [], 'no neighbours rendered as an empty object');
  assert.deepEqual(normalize(undefined), [], 'key absent entirely');
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize(175), ['175'], 'numeric muni_no');
});

await test('buildCsvFor windows by date, relying on newest-first ordering', async () => {
  await store.clearSales();
  // Newest-first, exactly as export_sales_for_web.R writes a shard.
  const csv = 'muni_no,municipality,Sale Date,sale_date_parsed,consideration\n'
    + '400,ALTONA,"Jul 21, 2026",2026-07-21,"$510,000"\n'
    + '400,ALTONA,"Mar 02, 2026",2026-03-02,"$330,000"\n'
    + '400,ALTONA,"Sep 15, 2024",2024-09-15,"$275,000"\n'
    + '400,ALTONA,"Feb 01, 1991",1991-02-01,"$60,000"\n';
  await store.putShard({ muni_no: '400', municipality: 'TOWN OF ALTONA', csv, meta: { rows: 4 } });

  const win = await store.buildCsvFor(['400'], { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(win.sales, 2, 'only the two 2026 sales');
  assert.equal(win.salesAvailable, 4);
  assert.deepEqual(win.window, { from: '2026-01-01', to: '2026-12-31' });
  assert.ok(win.text.includes('2026-07-21') && win.text.includes('2026-03-02'));
  assert.ok(!win.text.includes('1991-02-01'), 'older rows never read');
  assert.equal(win.text.split('\n').filter((l) => l.trim()).length, 3, 'header + 2 rows');

  // No window -> full history, and the payload says so.
  const all = await store.buildCsvFor(['400'], {});
  assert.equal(all.window, null);
  assert.ok(all.text.includes('1991-02-01'));

  // A window that excludes everything returns null rather than a header-only CSV.
  assert.equal(await store.buildCsvFor(['400'], { from: '2030-01-01' }), null);
});

await test('date window keeps undated rows and tolerates an export without the ISO column', async () => {
  await store.clearSales();
  const csv = 'muni_no,municipality,Sale Date,sale_date_parsed\n'
    + '400,ALTONA,"Jul 21, 2026",2026-07-21\n'
    + '400,ALTONA,"",\n'                            // undated: keep, must not stop the walk
    + '400,ALTONA,"Jun 01, 2026",2026-06-01\n'
    + '400,ALTONA,"Feb 01, 1991",1991-02-01\n';
  await store.putShard({ muni_no: '400', municipality: 'TOWN OF ALTONA', csv, meta: { rows: 4 } });
  const win = await store.buildCsvFor(['400'], { from: '2026-01-01' });
  assert.equal(win.sales, 3, 'two dated 2026 sales + the undated one');
  assert.ok(!win.text.includes('1991-02-01'));

  // An older export with no sale_date_parsed column: window is ignored, not
  // silently applied against the wrong column.
  await store.clearSales();
  const legacy = 'muni_no,municipality,Sale Date\n400,ALTONA,"Feb 01, 1991"\n';
  await store.putShard({ muni_no: '400', municipality: 'TOWN OF ALTONA', csv: legacy, meta: { rows: 1 } });
  const out = await store.buildCsvFor(['400'], { from: '2026-01-01' });
  assert.ok(out.text.includes('Feb 01, 1991'), 'no ISO column -> no window');
});

// These two rebuild the store from scratch, so they run LAST — the tests above
// share one store and expect the fixture set imported at the top of the file.
await test('a multi-parcel sale counts as ONE row, not one per stacked parcel', async () => {
  // The import count used to split the raw CSV on newlines, so the parcels
  // stacked inside these quoted cells each read as another sale (the export
  // reported 292,039 against a true 228,957). One sale here, two parcels.
  await store.clearSales();
  const stacked = 'muni_no,municipality,sale_date,consideration,roll\n'
                + '463,WINKLER,"Apr 14, 2026","$305,000","330015.000\n330065.000"\n';
  const dir = fakeDir({
    'manifest.json': fakeFileHandle('manifest.json', MANIFEST, 1000),
    'muni_463.csv': fakeFileHandle('muni_463.csv', stacked, 1000),
  });
  const s = await store.importFromDirectory(dir);
  assert.equal(s.rows, 1, 'one sale, not two');
  assert.equal((await store.getShard('463')).meta.rows, 1);
});

await test('a corrected row counter recounts already-imported shards', async () => {
  // Shards imported by an older counter keep their cached meta.rows, and the
  // mtime skip means an unchanged file would never be re-read — so a counting
  // fix must invalidate on its own via ROW_COUNT_VERSION.
  await store.clearSales();
  const dir = fakeDir({
    'manifest.json': fakeFileHandle('manifest.json', MANIFEST, 1000),
    'muni_400.csv': fakeFileHandle('muni_400.csv', CSV_400, 1000),
  });
  await store.importFromDirectory(dir);
  // Simulate state written by the previous version: stale count, old version.
  const rec = await store.getShard('400');
  await store.putShard({ ...rec, meta: { ...rec.meta, rows: 999 } });
  await store.putMeta('importState', { mtimes: { 400: 1000 }, rowCountVersion: 1 });

  const s = await store.importFromDirectory(dir);   // same mtime, no force
  assert.equal(s.imported, 1, 'version bump forces the re-read');
  assert.equal(s.skipped, 0);
  assert.equal((await store.getShard('400')).meta.rows, 2, 'recounted, not 999');

  const again = await store.importFromDirectory(dir);
  assert.equal(again.skipped, 1, 'and the skip resumes once versions agree');
});

await test('clearSales wipes shards AND meta together', async () => {
  await store.clearSales();
  assert.deepEqual(await store.listShardKeys(), []);
  assert.equal(await store.getManifest(), undefined, 'no manifest claiming data that is gone');
  assert.equal((await store.describeImport()).present, false);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
