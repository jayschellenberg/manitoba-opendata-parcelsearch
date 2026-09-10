// Unit tests for the per-station AADT history join.
//
// The station layer carries points and no counts; traffic-history.json
// carries counts and no points. joinTrafficHistory() is the seam between
// them, and everything the station popup shows comes out of it — so the
// failure modes worth pinning are the quiet ones: a series that silently
// sorts wrong, a town station that renders as a highway station, and a
// nested value that survives the GeoJSON round-trip as "[object Object]".
//
// Run: cd web && node test/trafficHistory.test.js

import assert from 'node:assert/strict';
import { stationSeries, joinTrafficHistory } from '../src/arcgis.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('arcgis.js — stationSeries');

test('returns years oldest-first as numbers', () => {
  // Real values for station 1193 (PTH 68 at Arborg).
  const entry = { y: { 2018: 1130, 2004: 930, 2024: 1230, 2010: 1040 } };
  assert.deepEqual(stationSeries(entry), [
    { year: 2004, aadt: 930 },
    { year: 2010, aadt: 1040 },
    { year: 2018, aadt: 1130 },
    { year: 2024, aadt: 1230 },
  ]);
});

test('sorts numerically, not lexicographically', () => {
  // Years arrive as object keys, i.e. strings. String ordering happens to be
  // right for 4-digit years, so a lexicographic sort would pass every
  // realistic fixture and still be wrong in principle — pin the intent.
  const entry = { y: { 998: 10, 1002: 20, 99: 30 } };
  assert.deepEqual(stationSeries(entry).map((r) => r.year), [99, 998, 1002]);
});

test('drops unusable rows rather than emitting NaN', () => {
  const entry = { y: { 2018: 0, 2019: null, 2020: 'n/a', 2021: 500 } };
  assert.deepEqual(stationSeries(entry), [{ year: 2021, aadt: 500 }]);
});

test('an absent or empty entry yields an empty series', () => {
  assert.deepEqual(stationSeries(undefined), []);
  assert.deepEqual(stationSeries(null), []);
  assert.deepEqual(stationSeries({}), []);
  assert.deepEqual(stationSeries({ y: {} }), []);
});

console.log('\narcgis.js — joinTrafficHistory');

const history = {
  stations: {
    1193: { t: 0, hwy: '68', loc: '3.2 KM E. OF P.T.H. #7', y: { 2018: 1130, 2024: 1230 } },
    5023: { t: 1, hwy: '326', loc: 'ARBORG - N. OF P.T.H. #68', y: { 2018: 3480, 2024: 3620 } },
  },
};
const fcOf = (...nums) => ({
  features: nums.map((n) => ({ properties: { StationNum: n } })),
});

test('stamps the latest point and the full series', () => {
  const fc = joinTrafficHistory(fcOf(1193), history);
  const p = fc.features[0].properties;
  assert.equal(p._aadt, 1230);
  assert.equal(p._aadtYear, 2024);
  assert.equal(p._count, 2);
  // The series must survive as a STRING: a nested array put through a
  // MapLibre GeoJSON source comes back as "[object Object]".
  assert.equal(typeof p._series, 'string');
  assert.deepEqual(JSON.parse(p._series), [[2018, 1130], [2024, 1230]]);
});

test('flags town stations from the report section', () => {
  const fc = joinTrafficHistory(fcOf(1193, 5023), history);
  assert.equal(fc.features[0].properties._town, 0, 'highway station');
  assert.equal(fc.features[1].properties._town, 1, 'town station');
});

test('falls back to the >= 5000 numbering when a station has no history', () => {
  // Otherwise an unmatched town station renders with the highway marker and
  // reads as a rural count — the two differ by 2-3x at the same place.
  const fc = joinTrafficHistory(fcOf(5999, 42), history);
  assert.equal(fc.features[0].properties._town, 1);
  assert.equal(fc.features[1].properties._town, 0);
});

test('a station with no history gets nulls, not stale values', () => {
  const fc = joinTrafficHistory(fcOf(9999), history);
  const p = fc.features[0].properties;
  assert.equal(p._aadt, null);
  assert.equal(p._aadtYear, null);
  assert.equal(p._series, '');
  assert.equal(p._count, 0);
});

test('a missing history file leaves every station countless but rendered', () => {
  // fetchTrafficHistory failing must not take the whole overlay down.
  const fc = joinTrafficHistory(fcOf(1193, 5023), null);
  for (const f of fc.features) {
    assert.equal(f.properties._aadt, null);
    assert.equal(f.properties._series, '');
  }
  assert.equal(fc.features[1].properties._town, 1, 'town flag still derived from the number');
});

test('tolerates a malformed feature collection', () => {
  assert.doesNotThrow(() => joinTrafficHistory({ features: [] }, history));
  assert.doesNotThrow(() => joinTrafficHistory({}, history));
  assert.doesNotThrow(() => joinTrafficHistory({ features: [{}] }, history));
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
