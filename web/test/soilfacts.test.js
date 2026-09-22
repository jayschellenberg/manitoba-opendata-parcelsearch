// The pre-baked shard and the live join must be the same answer.
//
// WHY THIS EXISTS. r/build_soilfacts.R moves the expensive half of the soil
// composition offline — the parcel x polygon clip, ~30 ms per parcel and the
// thing that made a 1,141-sale run take half a minute. What it deliberately
// does NOT move is the rules: the EXTENT normalisation, the component
// keying, the top-3 cap and the "Other mapped soils" remainder all stay in
// soilSurvey.js, and the shard ships only overlap ratios.
//
// That is the whole safety argument, so it is the thing to test. A shard
// entry and a live join carrying the same ratios must reach
// soilSurveyComponentsFromMatches and come out identical. If someone ever
// "optimises" the builder by baking finished rows into the shard, the two
// paths start answering differently for shard-covered parcels only — visible
// to nobody, because both answers look perfectly reasonable.
//
// Run: cd web && node test/soilfacts.test.js

import assert from 'node:assert/strict';
import { soilFeatureFromShard, soilMatchesFromShard, soilRollKey } from '../src/lib/soilfacts.js';
import { soilSurveyComponentsFromMatches } from '../src/soilSurvey.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// One municipality's shard, in the shape build_soilfacts.R writes.
const SHARD = {
  _meta: { muni: 'MACDONALD (RM)', parcels: 2, polygons: 2 },
  soils: {
    29049: {
      u: 'RDR-S1',
      n1: 'Red River', c1: 'RDR', e1: 60, t1: 'C', g1: '2', a1: '2W',
      n2: 'Osborne', c2: 'OSB', e2: 40, t2: 'C', g2: '3', a2: '3W',
    },
    29112: { u: 'ALM-S2', n1: 'Almasippi', c1: 'ALM', e1: 100, t1: 'FSL', g1: '4', a1: '4M' },
  },
  rolls: {
    '100.000': [[29049, 0.635], [29112, 0.365]],
    '200.000': [[29112, 1]],
  },
};

// The same overlaps as they arrive from the live join: real ArcGIS features.
const liveFeature = (props) => ({ type: 'Feature', properties: props, geometry: null });
const LIVE_100 = [
  {
    ratio: 0.635,
    feature: liveFeature({
      OBJECTID: 29049, MAPUNITNOM: 'RDR-S1',
      SOILNAME1: 'Red River', SOIL_CODE1: 'RDR', EXTENT1: 60, SURFTEXT1: 'C', AGCAP_CLS1: '2', AGRI_CAP1: '2W',
      SOILNAME2: 'Osborne', SOIL_CODE2: 'OSB', EXTENT2: 40, SURFTEXT2: 'C', AGCAP_CLS2: '3', AGRI_CAP2: '3W',
      SOILNAME3: null, SOIL_CODE3: null, EXTENT3: null, SURFTEXT3: null, AGCAP_CLS3: null, AGRI_CAP3: null,
    }),
  },
  {
    ratio: 0.365,
    feature: liveFeature({
      OBJECTID: 29112, MAPUNITNOM: 'ALM-S2',
      SOILNAME1: 'Almasippi', SOIL_CODE1: 'ALM', EXTENT1: 100, SURFTEXT1: 'FSL', AGCAP_CLS1: '4', AGRI_CAP1: '4M',
      SOILNAME2: null, SOIL_CODE2: null, EXTENT2: null, SURFTEXT2: null, AGCAP_CLS2: null, AGRI_CAP2: null,
      SOILNAME3: null, SOIL_CODE3: null, EXTENT3: null, SURFTEXT3: null, AGCAP_CLS3: null, AGRI_CAP3: null,
    }),
  },
];

console.log('soil facts — the shard and the live join are one answer');

test('a rebuilt feature carries the field names the rollup reads', () => {
  const f = soilFeatureFromShard(29049, SHARD.soils[29049]);
  assert.equal(f.properties.SOILNAME1, 'Red River');
  assert.equal(f.properties.AGRI_CAP2, '3W');
  assert.equal(f.properties.EXTENT1, 60);
  assert.equal(f.properties.MAPUNITNOM, 'RDR-S1');
  // Absent slots must be null, not undefined: componentsForFeature skips a
  // slot on empty-string/null and would otherwise read `undefined` into the
  // component and key it differently from the live side.
  assert.equal(f.properties.SOILNAME3, null);
  assert.equal(f.geometry, null, 'geometry is what the shard exists to avoid shipping');
});

test('shard and live produce identical composition rows', () => {
  const fromShard = soilMatchesFromShard(SHARD, '100.000');
  const opts = { maxRows: 3, parcelAreaAcres: 160 };
  const a = soilSurveyComponentsFromMatches(fromShard, opts);
  const b = soilSurveyComponentsFromMatches(LIVE_100, opts);
  assert.equal(a.length, b.length, 'row counts differ');
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].soilName, b[i].soilName);
    assert.equal(a[i].soilCode, b[i].soilCode);
    assert.equal(a[i].agriCap, b[i].agriCap);
    assert.equal(a[i].parcelPct.toFixed(9), b[i].parcelPct.toFixed(9));
    assert.equal(String(a[i].areaAcres), String(b[i].areaAcres));
  }
});

test('the EXTENT split is honoured, not flattened to the dominant soil', () => {
  // The reason the shard carries all three slots rather than slot 1: a
  // polygon 60% Red River / 40% Osborne contributes BOTH, weighted.
  const rows = soilSurveyComponentsFromMatches(
    soilMatchesFromShard(SHARD, '100.000'), { maxRows: 3, parcelAreaAcres: 160 });
  const names = rows.map((r) => r.soilName).sort();
  assert.deepEqual(names, ['Almasippi', 'Osborne', 'Red River']);
  const rr = rows.find((r) => r.soilName === 'Red River');
  assert.ok(Math.abs(rr.parcelPct - 63.5 * 0.6) < 1e-9,
    `Red River should be 63.5% x EXTENT 60%, got ${rr.parcelPct}`);
});

test('a roll the shard does not cover returns null, not an empty list', () => {
  // The distinction the caller depends on: null means "not covered, go and
  // join", [] would mean "measured, and there is no soil here". Collapsing
  // them stamps a town lot as having no soil instead of looking.
  assert.equal(soilMatchesFromShard(SHARD, '999.000'), null);
  assert.equal(soilMatchesFromShard(SHARD, null), null);
  assert.equal(soilMatchesFromShard(null, '100.000'), null);
});

test('roll keys normalise to the shard\'s three decimals', () => {
  assert.equal(soilRollKey({ Roll_No_Txt: '100.000' }), '100.000');
  assert.equal(soilRollKey({ Roll_No_Txt: '100' }), '100.000');
  assert.equal(soilRollKey({ Roll_No: 100.5 }), '100.500');
  assert.equal(soilRollKey({ TaxID: '2450.25' }), '2450.250');
  assert.equal(soilRollKey({}), null);
  assert.equal(soilRollKey({ Roll_No_Txt: '' }), null);
});

test('a malformed row is dropped rather than poisoning the composition', () => {
  const bad = { ...SHARD, rolls: { '1.000': [[29049, 0], [29112, 'x'], [null, 0.5], [29049, 0.25]] } };
  const m = soilMatchesFromShard(bad, '1.000');
  assert.equal(m.length, 1, 'only the one usable row should survive');
  assert.equal(m[0].ratio, 0.25);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
