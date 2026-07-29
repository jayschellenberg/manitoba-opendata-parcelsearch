// Regression tests for the snapshot-mode parcelKeys path in arcgis.js.
//
// searchParcelsFromSnapshot's imported-list branch matched rolls against
// the shard and returned them as-is, never calling filterSnapshotFeatures.
// The live path ANDs buildParcelClauses' output onto the key clause
// (fetchRollEntryByKeyChunks), so address and dwelling-units narrow an
// imported list against the live service — but silently did nothing while
// the app was in snapshot mode. main.js documents those filters as
// applying "on top" of parcelKeys, so the two modes disagreed.
//
// Roll is deliberately NOT applied on this path, matching live:
// buildParcelClauses excludes it (see its "Roll # handling moved into
// searchParcels()" note) because the key match already identifies each
// row. The last test locks that in so a future tidy-up doesn't "fix" it
// into a divergence.
//
// Fully offline — fetch is stubbed to serve a fixture shard.
//
// Run: cd web && node test/snapshotFilters.test.js

import assert from 'node:assert/strict';

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

const { searchParcels, setRollEntrySnapshot, canonicalRoll } =
  await import('../src/arcgis.js');

const MUNI = 'TESTVILLE (TOWN)';
const MUNI_NO = 42;

// Build fixtures through canonicalRoll so the test doesn't hard-code the
// ".000" normalization the real shards carry.
const feat = (roll, props) => ({
  type: 'Feature',
  geometry: null,
  properties: {
    OBJECTID: roll,
    Roll_No_Txt: canonicalRoll(String(roll)),
    Muni_Name_With_Typ: MUNI,
    ...props,
  },
});

const SHARD = {
  type: 'FeatureCollection',
  features: [
    feat(100, { Dwelling_Units: 0, Property_Address: '12 MAIN ST' }),
    feat(200, { Dwelling_Units: 3, Property_Address: '14 MAIN ST' }),
    feat(300, { Dwelling_Units: 0, Property_Address: '9 OAK AVE' }),
  ],
};

let shardFetches = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes('rollentry-snapshot/')) {
    shardFetches += 1;
    return { ok: true, status: 200, json: async () => SHARD };
  }
  throw new Error(`unexpected network call in offline test: ${url}`);
};

setRollEntrySnapshot({
  munis: { [MUNI]: { file: 'testville.geojson', muni_no: MUNI_NO } },
});

const KEYS = [100, 200, 300].map((r) => ({
  muni_no: MUNI_NO,
  roll_no_txt: String(r),
}));

const rollsOf = (fc) =>
  (fc.features || []).map((f) => f.properties.Roll_No_Txt).sort();

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push('pass');
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push('fail');
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log('searchParcels — snapshot mode, imported-list path');

await test('returns every matched key when no other filter is set', async () => {
  const fc = await searchParcels({ parcelKeys: KEYS });
  assert.deepEqual(rollsOf(fc), [100, 200, 300].map((r) => canonicalRoll(String(r))).sort());
});

await test('applies the dwelling-units filter on top of parcelKeys', async () => {
  const fc = await searchParcels({ parcelKeys: KEYS, duMode: 'zero' });
  assert.deepEqual(rollsOf(fc), [100, 300].map((r) => canonicalRoll(String(r))).sort());
});

await test('applies the min-dwelling-units filter on top of parcelKeys', async () => {
  const fc = await searchParcels({ parcelKeys: KEYS, duMode: 'min', duMin: 2 });
  assert.deepEqual(rollsOf(fc), [canonicalRoll('200')]);
});

await test('applies the address filter on top of parcelKeys', async () => {
  const fc = await searchParcels({ parcelKeys: KEYS, addressStreet: 'MAIN' });
  assert.deepEqual(rollsOf(fc), [100, 200].map((r) => canonicalRoll(String(r))).sort());
});

await test('ignores `roll`, matching the live path\'s buildParcelClauses', async () => {
  const fc = await searchParcels({ parcelKeys: KEYS, roll: '999999' });
  assert.equal(fc.features.length, 3, 'roll must not narrow a parcelKeys query');
});

await test('never reports truncation — a shard is the whole municipality', async () => {
  const fc = await searchParcels({ parcelKeys: KEYS });
  assert.equal(fc._truncated, false);
});

await test('reuses the cached shard rather than refetching per search', async () => {
  assert.equal(shardFetches, 1, `expected 1 shard fetch, saw ${shardFetches}`);
});

const failed = results.filter((r) => r === 'fail').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
