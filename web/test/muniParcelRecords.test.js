// Unit tests for lib/muniParcelRecords.js — the Assessment Parcels popup
// resolver that turns the three properties a vector tile carries into the
// full parcel record, by OBJECTID, on click.
//
// Run: cd web && node test/muniParcelRecords.test.js

import assert from 'node:assert/strict';
import { createMuniParcelResolver, recordKey } from '../src/lib/muniParcelRecords.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

/** What a vector tile actually carries — see TILE_POLYGON_PROPS. */
const tileProps = (oid, muni = 'ALTONA (TOWN)') => ({
  OBJECTID: oid, Muni_Name_With_Typ: muni, Roll_No_Txt: `${oid}.000`,
});

/** What the fabric fetch returns — the full record. */
const fabricFeature = (oid, muni = 'ALTONA (TOWN)', extra = {}) => ({
  type: 'Feature',
  geometry: null,
  properties: {
    OBJECTID: oid, Muni_Name_With_Typ: muni, Roll_No_Txt: `${oid}.000`,
    Property_Address: `${oid} MAIN ST`, Dwelling_Units: 1,
    Asmt_Rpt_Url: 'https://www.gov.mb.ca/mao/public/summary.aspx?x=1',
    ...extra,
  },
});

const fabric = (...features) => ({ type: 'FeatureCollection', features });

function harness(overrides = {}) {
  const calls = { fetch: [], enrich: 0, warn: [] };
  const resolver = createMuniParcelResolver({
    fetchFabric: async (muni) => { calls.fetch.push(muni); return fabric(fabricFeature(1, muni), fabricFeature(2, muni)); },
    enrichLegals: async (fc) => {
      calls.enrich += 1;
      for (const f of fc.features) f.properties._legalDescription = `LOT ${f.properties.OBJECTID}`;
    },
    onWarn: (m, e) => calls.warn.push([m, e]),
    ...overrides,
  });
  return { resolver, calls };
}

// ---------- recordKey ----------

await test('recordKey joins municipality and OBJECTID', () => {
  assert.equal(recordKey(tileProps(7)), 'ALTONA (TOWN)|7');
});

await test('recordKey is null when either half is missing', () => {
  assert.equal(recordKey({ OBJECTID: 7 }), null);
  assert.equal(recordKey({ Muni_Name_With_Typ: 'ALTONA (TOWN)' }), null);
  assert.equal(recordKey(null), null);
  assert.equal(recordKey(undefined), null);
});

await test('OBJECTID 0 is a real id, not a missing one', () => {
  assert.equal(recordKey({ Muni_Name_With_Typ: 'X (RM)', OBJECTID: 0 }), 'X (RM)|0');
});

// ---------- resolve ----------

await test('resolve returns the full record, not the tile properties', async () => {
  const { resolver } = harness();
  const rec = await resolver.resolve(tileProps(1));
  assert.equal(rec.Property_Address, '1 MAIN ST');
  assert.equal(rec._legalDescription, 'LOT 1');
  assert.ok(rec.Asmt_Rpt_Url, 'the live report URL comes from the fetch, not the tile');
});

await test('one fetch per municipality, however many parcels are clicked', async () => {
  const { resolver, calls } = harness();
  await resolver.resolve(tileProps(1));
  await resolver.resolve(tileProps(2));
  await resolver.resolve(tileProps(1));
  assert.deepEqual(calls.fetch, ['ALTONA (TOWN)']);
  assert.equal(calls.enrich, 1);
});

await test('concurrent clicks share one in-flight fetch', async () => {
  const { resolver, calls } = harness();
  await Promise.all([resolver.resolve(tileProps(1)), resolver.resolve(tileProps(2))]);
  assert.equal(calls.fetch.length, 1);
});

await test('a different municipality fetches separately', async () => {
  const { resolver, calls } = harness();
  await resolver.resolve(tileProps(1, 'ALTONA (TOWN)'));
  await resolver.resolve(tileProps(1, 'MORDEN (CITY)'));
  assert.deepEqual(calls.fetch, ['ALTONA (TOWN)', 'MORDEN (CITY)']);
});

await test('an OBJECTID absent from the fabric resolves to null, not a throw', async () => {
  const { resolver } = harness();
  assert.equal(await resolver.resolve(tileProps(999)), null);
});

await test('unusable tile properties resolve to null without fetching', async () => {
  const { resolver, calls } = harness();
  assert.equal(await resolver.resolve({ OBJECTID: 1 }), null);
  assert.equal(await resolver.resolve(null), null);
  assert.equal(calls.fetch.length, 0);
});

await test('a failed fetch does not poison the cache — the next click retries', async () => {
  let attempt = 0;
  const { resolver, calls } = harness({
    fetchFabric: async (muni) => {
      calls.fetch.push(muni);
      attempt += 1;
      if (attempt === 1) throw new Error('network');
      return fabric(fabricFeature(1, muni));
    },
  });
  await assert.rejects(() => resolver.resolve(tileProps(1)), /network/);
  const rec = await resolver.resolve(tileProps(1));
  assert.equal(rec.Property_Address, '1 MAIN ST');
  assert.equal(calls.fetch.length, 2, 'retried rather than replaying the rejection');
});

await test('a failed legal enrichment is non-fatal — the record still resolves', async () => {
  const { resolver, calls } = harness({
    enrichLegals: async () => { throw new Error('legal index down'); },
  });
  const rec = await resolver.resolve(tileProps(1));
  assert.equal(rec.Property_Address, '1 MAIN ST');
  assert.equal(rec._legalDescription, undefined);
  assert.equal(calls.warn.length, 1);
});

// ---------- getLoadedFabric ----------

await test('an already-loaded fabric is reused, carrying its runtime stamps', async () => {
  const loaded = fabric(
    fabricFeature(1, 'ALTONA (TOWN)', { _soilComposition: 'Newdale 60%', _lcColor: '#0f0' }),
  );
  const { resolver, calls } = harness({ getLoadedFabric: () => loaded });
  const rec = await resolver.resolve(tileProps(1));
  // These only exist because an overlay stamped them in place — a fetch
  // would not have them.
  assert.equal(rec._soilComposition, 'Newdale 60%');
  assert.equal(rec._lcColor, '#0f0');
  assert.equal(calls.fetch.length, 0, 'no fetch when the fabric is already here');
});

await test('a loaded fabric for a DIFFERENT municipality is ignored', async () => {
  const loaded = fabric(fabricFeature(1, 'MORDEN (CITY)'));
  const { resolver, calls } = harness({ getLoadedFabric: () => loaded });
  const rec = await resolver.resolve(tileProps(1, 'ALTONA (TOWN)'));
  assert.deepEqual(calls.fetch, ['ALTONA (TOWN)']);
  assert.equal(rec.Muni_Name_With_Typ, 'ALTONA (TOWN)');
});

await test('an empty loaded fabric falls through to the fetch', async () => {
  const { resolver, calls } = harness({ getLoadedFabric: () => fabric() });
  await resolver.resolve(tileProps(1));
  assert.equal(calls.fetch.length, 1);
});

// ---------- peek ----------

await test('peek is null before resolve and the record after', async () => {
  const { resolver } = harness();
  assert.equal(resolver.peek(tileProps(1)), null);
  await resolver.resolve(tileProps(1));
  assert.equal(resolver.peek(tileProps(1)).Property_Address, '1 MAIN ST');
});

await test('resolving one parcel makes its whole municipality peekable', async () => {
  const { resolver } = harness();
  await resolver.resolve(tileProps(1));
  // Hovering a neighbour now shows full detail without any wait.
  assert.equal(resolver.peek(tileProps(2)).Property_Address, '2 MAIN ST');
});

await test('peek never throws on junk', () => {
  const { resolver } = harness();
  assert.equal(resolver.peek(null), null);
  assert.equal(resolver.peek({}), null);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
