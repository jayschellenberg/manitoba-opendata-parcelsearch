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
import {
  stationSeries, joinTrafficHistory, joinFlowHistory, countLabels, latestStationCount,
} from '../src/arcgis.js';

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


console.log('\narcgis.js — countLabels');

test('formats with a thousands separator, and the year only when known', () => {
  assert.deepEqual(countLabels(2110, 2024), { label: '2,110', labelYear: '2,110 (2024)' });
  // No usable year: the plain number is honest, "(NaN)" is not.
  assert.deepEqual(countLabels(400, null), { label: '400', labelYear: '400' });
  assert.deepEqual(countLabels(400, 0), { label: '400', labelYear: '400' });
});

test('nothing to label yields empty strings, not "0" or "NaN"', () => {
  assert.deepEqual(countLabels(null, 2024), { label: '', labelYear: '' });
  assert.deepEqual(countLabels(0, 2024), { label: '', labelYear: '' });
  assert.deepEqual(countLabels(undefined, undefined), { label: '', labelYear: '' });
});

console.log('\narcgis.js — latestStationCount');

test('returns the newest published point', () => {
  assert.deepEqual(latestStationCount({ y: { 2018: 1130, 2024: 1230, 2010: 1040 } }),
                   { year: 2024, aadt: 1230 });
  assert.equal(latestStationCount({ y: {} }), null);
  assert.equal(latestStationCount(undefined), null);
});

console.log('\narcgis.js — joinFlowHistory');

test('a segment takes its station\'s published count over the service column', () => {
  // Station 73 on 2026-09-10: the service stops at 2024 (1,000) while the
  // reports carry 2025 (1,040). Reading the service put a different number
  // on the segment than on the station dot sitting on it.
  const fc = { features: [{ properties: {
    StationNum: 73, AADT: 1040, AADT_2023: 1020, AADT_2024: 1000, DateOfEsti: 2024, EYear: 2019,
  } }] };
  const p = joinFlowHistory(fc, { stations: { 73: { t: 0, y: { 2024: 1000, 2025: 1040 } } } })
    .features[0].properties;
  assert.equal(p._aadt, 1040);
  assert.equal(p._aadtYear, 2025);
  assert.equal(p._src, 'report');
  assert.equal(p._label, '1,040');
  assert.equal(p._labelYear, '1,040 (2025)');
});

test('falls back to the service columns when the station is not in the reports', () => {
  const fc = { features: [{ properties: {
    StationNum: 999, AADT: 900, AADT_2023: 950, AADT_2024: 980, DateOfEsti: 2024, EYear: 2019,
  } }] };
  const p = joinFlowHistory(fc, { stations: {} }).features[0].properties;
  assert.equal(p._aadt, 980, 'newest service column');
  assert.equal(p._aadtYear, 2024, 'DateOfEsti');
  assert.equal(p._src, 'service');
  assert.equal(p._labelYear, '980 (2024)');
});

test('a missing history file leaves the overlay on the service columns', () => {
  const fc = { features: [{ properties: { StationNum: 73, AADT_2024: 1000, DateOfEsti: 2024 } }] };
  const p = joinFlowHistory(fc, null).features[0].properties;
  assert.equal(p._aadt, 1000);
  assert.equal(p._src, 'service');
});

test('a segment and its station agree once both read the history', () => {
  // The property this whole change exists to guarantee.
  const history = { stations: { 73: { t: 0, y: { 2024: 1000, 2025: 1040 } } } };
  const seg = joinFlowHistory({ features: [{ properties: { StationNum: 73, AADT_2024: 1000 } }] },
                              history).features[0].properties;
  const stn = joinTrafficHistory({ features: [{ properties: { StationNum: 73 } }] },
                                 history).features[0].properties;
  assert.equal(seg._aadt, stn._aadt);
  assert.equal(seg._aadtYear, stn._aadtYear);
});

test('tolerates a malformed feature collection', () => {
  assert.doesNotThrow(() => joinFlowHistory({ features: [] }, { stations: {} }));
  assert.doesNotThrow(() => joinFlowHistory({}, { stations: {} }));
  assert.doesNotThrow(() => joinFlowHistory({ features: [{}] }, { stations: {} }));
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
