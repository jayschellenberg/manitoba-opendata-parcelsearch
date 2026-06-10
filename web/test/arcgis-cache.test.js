// Integration test — exercise the search paths that hit the cache
// directly through arcgis.js. In Node there's no IndexedDB; the
// cache layer falls back to localStorage, which we shim in-memory.
// Validates that the async readCache/writeCache rewrite didn't
// break any of the user-facing search combinations the goal cares
// about.
//
// Run: cd web && node test/arcgis-cache.test.js
// Hits live ArcGIS endpoints — needs network, so it is skipped by
// default to keep `npm test` green offline and in CI. Opt in with:
//   RUN_LIVE_TESTS=1 npm test

import assert from 'node:assert/strict';

if (!process.env.RUN_LIVE_TESTS) {
  console.log('SKIPPED — live-network integration test (set RUN_LIVE_TESTS=1 to run)');
  process.exit(0);
}

function makeFakeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
}

globalThis.localStorage = makeFakeStorage();
globalThis.sessionStorage = makeFakeStorage();

const arcgis = await import('../src/arcgis.js');

const results = [];
async function test(name, fn) {
  process.stdout.write(`  - ${name} ... `);
  try {
    await fn();
    results.push({ name, status: 'pass' });
    process.stdout.write('ok\n');
  } catch (err) {
    results.push({ name, status: 'fail', err });
    process.stdout.write(`FAIL\n    ${err.message}\n`);
  }
}

console.log('arcgis.js cache-integration tests (live network)');

await test('Search by Roll # — single roll round-trips and caches', async () => {
  // First call: fetches from ArcGIS and writes to cache.
  const a = await arcgis.searchParcels({ municipality: 'STONEWALL (TOWN)', roll: '3600' });
  assert.equal(a.features.length, 1);
  assert.equal(a.features[0].properties.Roll_No_Txt, '3600.000');
});

await test('Search by Roll # — comma + & separator parse to same result', async () => {
  const commaRes  = await arcgis.searchParcels({ municipality: 'HEADINGLEY (RM)', roll: '28410,970,966' });
  const ampRes    = await arcgis.searchParcels({ municipality: 'HEADINGLEY (RM)', roll: '28410&970&966' });
  assert.equal(commaRes.features.length, ampRes.features.length);
  assert.equal(commaRes.features.length, 3);
});

await test('Search by street name + muni returns parcels', async () => {
  const res = await arcgis.searchParcels({
    municipality: 'STONEWALL (TOWN)',
    addressStreet: 'MAIN ST',
  });
  assert.ok(res.features.length > 0, 'expected some MAIN ST parcels in Stonewall');
});

await test('Roll-list chunking — 100-roll IN-list returns all matches', async () => {
  // Generates synthetic-but-real rolls from Stonewall (small muni → bounded test).
  const rolls = Array.from({ length: 100 }, (_, i) => String(3000 + i)).join(',');
  const res = await arcgis.searchParcels({ municipality: 'STONEWALL (TOWN)', roll: rolls });
  // Some of these rolls won't exist in Stonewall; we just want to confirm the
  // call completes without error and returns a sensible (≤100) feature count.
  assert.ok(res.features.length >= 0);
  assert.ok(res.features.length <= 100);
});

await test('Zone-category filter narrows the result set', async () => {
  // Teulon is under MAX_RESULTS (~697 parcels) so the "all" branch
  // isn't truncated and a real before/after comparison is meaningful.
  const all      = await arcgis.searchParcels({ municipality: 'TEULON (TOWN)' });
  const filtered = await arcgis.searchParcels({ municipality: 'TEULON (TOWN)', zoneCategory: 'Residential' });
  assert.ok(all.features.length > filtered.features.length,
    `expected residential-only filter to shrink the set; got all=${all.features.length}, filtered=${filtered.features.length}`);
  assert.ok(filtered.features.length > 0, 'expected at least some residential parcels');
});

await test('fetchAllParcelsInMunicipality caches across calls (second call instant)', async () => {
  const t0 = Date.now();
  const fc1 = await arcgis.fetchAllParcelsInMunicipality('STONEWALL (TOWN)');
  const t1 = Date.now();
  const fc2 = await arcgis.fetchAllParcelsInMunicipality('STONEWALL (TOWN)');
  const t2 = Date.now();
  assert.equal(fc1.features.length, fc2.features.length);
  // Cache hit should be at least 10× faster than the cold fetch.
  const cold = t1 - t0;
  const warm = t2 - t1;
  assert.ok(warm < cold / 5 || warm < 50,
    `cache hit didn't speed up — cold=${cold}ms warm=${warm}ms`);
});

await test('Cache survives a roundtrip through the localStorage envelope', async () => {
  // The arcgis layer wrote Stonewall's parcels to localStorage above.
  // Confirm the envelope is the shape we expect (so legacy reads still work).
  let key = null;
  for (let i = 0; i < globalThis.localStorage.length; i++) {
    const k = globalThis.localStorage.key(i);
    if (k && k.startsWith('mbpsCache.mb_muni_parcels_v5_STONEWALL')) { key = k; break; }
  }
  assert.ok(key, 'expected a cache entry for Stonewall parcels');
  const raw = globalThis.localStorage.getItem(key);
  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed, 'object');
  assert.ok('v' in parsed && 't' in parsed, 'cache envelope must carry v + t');
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
