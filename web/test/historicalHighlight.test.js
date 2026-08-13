// Unit tests for src/lib/historicalHighlight.js — as-of geometry for the
// search-result highlight under an active Historical (as-of-date) overlay.
//
// Run: cd web && node test/historicalHighlight.test.js

import assert from 'node:assert/strict';
import {
  muniRollKey,
  indexHistoricalGeometry,
  applyHistoricalGeometry,
} from '../src/lib/historicalHighlight.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// The real one lives in arcgis.js; injected here exactly as main.js injects it.
function canonicalRoll(input) {
  if (input == null) return '';
  const s = String(input).trim();
  if (s === '') return '';
  const m = s.match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return s;
  return `${m[1]}.${(m[2] || '').padEnd(3, '0').slice(0, 3)}`;
}

const sq = (x, y, size) => ({
  type: 'Polygon',
  coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]],
});

const parcel = (muni, roll, geometry, extra = {}) => ({
  type: 'Feature',
  properties: { Muni_Name_With_Typ: muni, Roll_No_Txt: roll, ...extra },
  geometry,
});

console.log('historicalHighlight.js — muniRollKey');

test('folds case and whitespace, canonicalizes the roll', () => {
  assert.equal(
    muniRollKey('brandon  (city)', '562264', canonicalRoll),
    muniRollKey('BRANDON (CITY)', '562264.000', canonicalRoll),
  );
});

test('returns empty when either half is missing', () => {
  assert.equal(muniRollKey('', '562264', canonicalRoll), '');
  assert.equal(muniRollKey('BRANDON (CITY)', null, canonicalRoll), '');
});

console.log('historicalHighlight.js — indexHistoricalGeometry');

test('indexes by muni + roll', () => {
  const idx = indexHistoricalGeometry({
    features: [
      parcel('BRANDON (CITY)', '562264.000', sq(0, 0, 1)),
      parcel('HANOVER (RM)', '562264.000', sq(9, 9, 1)),
    ],
  }, { canonicalRoll });
  assert.equal(idx.size, 2);
  assert.deepEqual(
    idx.get(muniRollKey('BRANDON (CITY)', '562264', canonicalRoll)).coordinates,
    sq(0, 0, 1).coordinates,
  );
});

test('merges a multi-part roll into one MultiPolygon', () => {
  const idx = indexHistoricalGeometry({
    features: [
      parcel('BRANDON (CITY)', '100.000', sq(0, 0, 1)),
      parcel('BRANDON (CITY)', '100.000', sq(5, 5, 1)),
    ],
  }, { canonicalRoll });
  const g = idx.get(muniRollKey('BRANDON (CITY)', '100', canonicalRoll));
  assert.equal(g.type, 'MultiPolygon');
  assert.equal(g.coordinates.length, 2);
});

test('flattens an incoming MultiPolygon rather than nesting it', () => {
  const idx = indexHistoricalGeometry({
    features: [
      parcel('BRANDON (CITY)', '100.000', {
        type: 'MultiPolygon',
        coordinates: [sq(0, 0, 1).coordinates, sq(2, 2, 1).coordinates],
      }),
      parcel('BRANDON (CITY)', '100.000', sq(5, 5, 1)),
    ],
  }, { canonicalRoll });
  const g = idx.get(muniRollKey('BRANDON (CITY)', '100', canonicalRoll));
  assert.equal(g.type, 'MultiPolygon');
  assert.equal(g.coordinates.length, 3);
  assert.equal(typeof g.coordinates[0][0][0][0], 'number');   // ring → point → x
});

test('skips features with no roll, no muni, or no geometry', () => {
  const idx = indexHistoricalGeometry({
    features: [
      parcel('BRANDON (CITY)', '', sq(0, 0, 1)),
      parcel('', '100.000', sq(0, 0, 1)),
      parcel('BRANDON (CITY)', '200.000', null),
      { type: 'Feature' },
    ],
  }, { canonicalRoll });
  assert.equal(idx.size, 0);
});

console.log('historicalHighlight.js — applyHistoricalGeometry');

test('swaps in the as-of boundary and stamps the date', () => {
  // Brandon 562264: 12.23 ac on 2025-02-12, 3.78 ac today after 562314 came off it.
  const idx = indexHistoricalGeometry({
    features: [parcel('BRANDON (CITY)', '562264.000', sq(0, 0, 10))],
  }, { canonicalRoll });
  const today = { type: 'FeatureCollection', features: [
    parcel('BRANDON (CITY)', '562264.000', sq(0, 0, 1), { OBJECTID: 7, _seq: 1 }),
  ] };

  const r = applyHistoricalGeometry(today, idx, { snapshot: '2025-02-12', canonicalRoll });

  assert.equal(r.swapped, 1);
  assert.equal(r.missing, 0);
  assert.deepEqual(r.fc.features[0].geometry.coordinates, sq(0, 0, 10).coordinates);
  assert.equal(r.fc.features[0].properties._asOfGeom, true);
  assert.equal(r.fc.features[0].properties._asOfDate, '2025-02-12');
  // Everything the map and table key off must survive the swap.
  assert.equal(r.fc.features[0].properties.OBJECTID, 7);
  assert.equal(r.fc.features[0].properties._seq, 1);
  // Input untouched — the caller keeps today's geometry for the table/export.
  assert.deepEqual(today.features[0].geometry.coordinates, sq(0, 0, 1).coordinates);
  assert.equal(today.features[0].properties._asOfGeom, undefined);
});

test('a roll with no parcel at that date keeps today geometry and is counted', () => {
  const idx = indexHistoricalGeometry({
    features: [parcel('BRANDON (CITY)', '100.000', sq(0, 0, 10))],
  }, { canonicalRoll });
  const today = { type: 'FeatureCollection', features: [
    parcel('BRANDON (CITY)', '100.000', sq(0, 0, 1)),
    parcel('BRANDON (CITY)', '999.000', sq(3, 3, 1)),     // created since
  ] };

  const r = applyHistoricalGeometry(today, idx, { snapshot: '2025-02-12', canonicalRoll });

  assert.equal(r.swapped, 1);
  assert.equal(r.missing, 1);
  assert.deepEqual(r.missingRolls, ['999.000']);
  assert.deepEqual(r.fc.features[1].geometry.coordinates, sq(3, 3, 1).coordinates);
  assert.equal(r.fc.features[1].properties._asOfGeom, undefined);
});

test('never borrows another municipality parcel that shares a roll', () => {
  const idx = indexHistoricalGeometry({
    features: [parcel('BRANDON (CITY)', '562264.000', sq(0, 0, 10))],
  }, { canonicalRoll });
  const today = { type: 'FeatureCollection', features: [
    parcel('HANOVER (RM)', '562264.000', sq(50, 50, 1)),
  ] };

  const r = applyHistoricalGeometry(today, idx, { snapshot: '2025-02-12', canonicalRoll });

  assert.equal(r.swapped, 0);
  // Out of the overlay's scope, so not reported as a missing as-of parcel.
  assert.equal(r.missing, 0);
  assert.deepEqual(r.missingRolls, []);
  assert.equal(r.fc, today);          // untouched, same object
});

test('dedupes missingRolls across repeated features of one roll', () => {
  const idx = indexHistoricalGeometry({
    features: [parcel('BRANDON (CITY)', '100.000', sq(0, 0, 10))],
  }, { canonicalRoll });
  const today = { type: 'FeatureCollection', features: [
    parcel('BRANDON (CITY)', '999.000', sq(3, 3, 1), { _saleDate: '2026-01-01' }),
    parcel('BRANDON (CITY)', '999.000', sq(3, 3, 1), { _saleDate: '2024-05-05' }),
  ] };

  const r = applyHistoricalGeometry(today, idx, { snapshot: '2025-02-12', canonicalRoll });

  assert.equal(r.missing, 2);                    // features
  assert.deepEqual(r.missingRolls, ['999.000']); // distinct rolls
});

test('empty index or empty result set is a no-op returning the same object', () => {
  const today = { type: 'FeatureCollection', features: [parcel('BRANDON (CITY)', '1.000', sq(0, 0, 1))] };
  assert.equal(applyHistoricalGeometry(today, new Map(), { canonicalRoll }).fc, today);
  assert.equal(applyHistoricalGeometry(today, null, { canonicalRoll }).fc, today);
  const empty = { type: 'FeatureCollection', features: [] };
  assert.equal(applyHistoricalGeometry(empty, new Map([['k', sq(0, 0, 1)]]), { canonicalRoll }).fc, empty);
});

test('handles a null/undefined FeatureCollection', () => {
  const r = applyHistoricalGeometry(null, new Map(), { canonicalRoll });
  assert.deepEqual(r.fc.features, []);
  assert.equal(r.swapped, 0);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
