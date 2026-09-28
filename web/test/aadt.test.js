// Unit tests for the MHTIS traffic-flow field mapping and AADT/year selection.
//
// The layer the app read until 2026-09-23 (MHTIS_Traffic_Flow_2023_(new))
// grew an AADT_<year> column per republish and split the year across
// DateOfEsti / EYear; the province then withdrew it outright, which blanked
// the Flow overlay. Its replacement (E_MHTIS_LRS_20260923, "MHTIS Traffic
// Flow 2025") has one current AADT and an explicit AADT_YEAR, but renames the
// fields the rest of the app joins on (STATION_NO, FLOW_DIR, ROAD_TYPE).
//
// These tests pin the rename, so the station join cannot quietly lose its
// key, and pin the year logic, so no one reintroduces a hardcoded vintage.
//
// Run: cd web && node test/aadt.test.js

import assert from 'node:assert/strict';
import { currentAadt, currentAadtYear, buildAadtIndex, normalizeFlowProps } from '../src/arcgis.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('arcgis.js — normalizeFlowProps');

test('maps the 2026-09 service schema onto the app\'s names', () => {
  // A real row from E_MHTIS_LRS_20260923 layer 1, 2026-09-28.
  const p = normalizeFlowProps({
    OBJECTID: 4, STATION_NO: 19, ROAD_NO: 1, ROAD_NO_STR: '1', FLOW_DIR: 'C',
    AADT: 19380, AADT_YEAR: 2025, ROAD_TYPE: 'Provincial Trunk Highway',
    START_KM: 0, END_KM: 2.1, LENGTH_KM: 2.1, GlobalID: '{x}',
  });
  assert.deepEqual(p, {
    StationNum: 19, ROAD_NO: 1, ROAD_NO_STR: '1', ROAD_IDENT: 'Provincial Trunk Highway',
    FlowDirect: 'C', AADT: 19380, AADT_YEAR: 2025, START_KM: 0, END_KM: 2.1, LENGTH_KM: 2.1,
  });
});

test('keeps ROAD_IDENT on the values findHighwayAadt matches against', () => {
  // main.js maps Road Network RteType to exactly these two strings.
  assert.equal(normalizeFlowProps({ ROAD_TYPE: 'Provincial Road' }).ROAD_IDENT, 'Provincial Road');
});

test('drops what it does not know and survives empty input', () => {
  assert.deepEqual(normalizeFlowProps({ Shape__Length: 5 }), {});
  assert.deepEqual(normalizeFlowProps(null), {});
  assert.deepEqual(normalizeFlowProps(undefined), {});
  // A null value is carried, not dropped: the segment has the field, empty.
  assert.deepEqual(normalizeFlowProps({ AADT_YEAR: null }), { AADT_YEAR: null });
});

console.log('\narcgis.js — currentAadt');

test('reads AADT', () => {
  // Station 1193 — PTH 68 at Arborg. The retired layer served a carried-
  // forward 2018 count of 1130; the new one carries the 2024 count.
  assert.equal(currentAadt({ AADT: 1230, AADT_YEAR: 2024 }), 1230);
});

test('treats null, zero and non-numeric as absent', () => {
  assert.equal(currentAadt({ AADT: null }), null);
  assert.equal(currentAadt({ AADT: 0 }), null);
  assert.equal(currentAadt({ AADT: 'n/a' }), null);
  assert.equal(currentAadt({}), null);
  assert.equal(currentAadt(null), null);
  assert.equal(currentAadt(undefined), null);
});

console.log('\narcgis.js — currentAadtYear');

test('uses the segment\'s own AADT_YEAR', () => {
  assert.equal(currentAadtYear({ AADT: 1230, AADT_YEAR: 2024 }), 2024);
  // The layer is not one vintage: some segments still serve 1995 counts.
  assert.equal(currentAadtYear({ AADT: 610, AADT_YEAR: 1995 }), 1995);
});

test('returns null rather than guessing a year', () => {
  // No count at all — nothing to date.
  assert.equal(currentAadtYear({ AADT_YEAR: 2024 }), null);
  // A count but no usable year (2 segments on 2026-09-28): print it bare.
  assert.equal(currentAadtYear({ AADT: 1230 }), null);
  assert.equal(currentAadtYear({ AADT: 1230, AADT_YEAR: null }), null);
  assert.equal(currentAadtYear({ AADT: 1230, AADT_YEAR: 0 }), null);
  assert.equal(currentAadtYear(null), null);
  assert.equal(currentAadtYear(undefined), null);
});

console.log('\narcgis.js — buildAadtIndex');

test('keeps the max across a station\'s segments', () => {
  // Same station, two directions/sections — busiest is the useful summary.
  const fc = { features: [
    { properties: { StationNum: 5, AADT: 300 } },
    { properties: { StationNum: 5, AADT: 700 } },
    { properties: { StationNum: 5, AADT: 200 } },
  ] };
  assert.equal(buildAadtIndex(fc).get(5), 700);
});

test('skips features with no station or no usable count', () => {
  const fc = { features: [
    { properties: { StationNum: null, AADT: 500 } },
    { properties: { StationNum: 9, AADT: null } },
    { properties: { StationNum: 9, AADT: 250 } },
  ] };
  const idx = buildAadtIndex(fc);
  assert.equal(idx.size, 1);
  assert.equal(idx.get(9), 250);
});

test('an empty or malformed FC yields an empty index', () => {
  assert.equal(buildAadtIndex({ features: [] }).size, 0);
  assert.equal(buildAadtIndex({}).size, 0);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
