// Unit tests for the MHTIS traffic-flow AADT field and year selection.
//
// The Traffic Flow service accumulates a new AADT_<year> column on every
// republish and never renames the old ones, so the obvious field name
// (`AADT`, whose own alias is "AADT 2019") is always the stalest thing on
// the feature. Reading the wrong one yields numbers that are several years
// out of date but entirely plausible — no error, no blank cell, just quietly
// outdated traffic volumes in an appraisal. The 2026-02-12 republish added
// AADT_2024 beside AADT_2023 and moved 748 of 2,067 segments; reading
// AADT_2023 was stale on more than a third of the network.
//
// These tests pin the precedence so a later refactor can't "simplify" it
// back to props.AADT, and pin the year logic so no one reintroduces a
// hardcoded vintage in a label.
//
// Run: cd web && node test/aadt.test.js

import assert from 'node:assert/strict';
import { currentAadt, currentAadtYear, buildAadtIndex } from '../src/arcgis.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('arcgis.js — currentAadt');

test('prefers AADT_2024 over every older column', () => {
  // Real values from station 73 (PTH 287) on 2026-09-10. MHTIS's own
  // "Traffic on Manitoba Highways 2025" report confirms each column is its
  // own year at a continuous station: 2019 → 1040, 2023 → 1020, 2024 → 1000.
  assert.equal(currentAadt({ AADT: 1040, AADT_2023: 1020, AADT_2024: 1000 }), 1000);
  // Station 1193 — PTH 68 at Arborg. The report shows 1,130 counted in 2018
  // and 1,230 in 2024, so the newest column is the one that moved.
  assert.equal(currentAadt({ AADT: 1130, AADT_2023: 1130, AADT_2024: 1230 }), 1230);
  // Station 533 — the gap runs the other way, so this is not "largest wins".
  assert.equal(currentAadt({ AADT: 540, AADT_2023: 400, AADT_2024: 400 }), 400);
});

test('falls back through the vintages when newer columns are absent', () => {
  // An FC cached before the 2024 column landed.
  assert.equal(currentAadt({ AADT: 1040, AADT_2023: 1020 }), 1020);
  // Or before 2023 — the original 2019 layer's shape.
  assert.equal(currentAadt({ AADT: 1040 }), 1040);
});

test('treats null, zero and non-numeric as absent', () => {
  assert.equal(currentAadt({ AADT_2024: null, AADT_2023: null, AADT: 900 }), 900);
  assert.equal(currentAadt({ AADT_2024: 0, AADT: 900 }), 900);
  assert.equal(currentAadt({ AADT_2024: 'n/a', AADT: 900 }), 900);
  assert.equal(currentAadt({}), null);
  assert.equal(currentAadt(null), null);
  assert.equal(currentAadt(undefined), null);
});

console.log('\narcgis.js — currentAadtYear');

test('uses DateOfEsti for the year of a current-column count', () => {
  // DateOfEsti is the year of the NEWEST published count, which is the one
  // currentAadt returns. Verified against the MHTIS 2025 report: the pair
  // (DateOfEsti, newest column) lands on a real published station-year for
  // 1,649 of 1,655 stations.
  assert.equal(currentAadtYear({ AADT_2024: 1230, AADT_2023: 1130, AADT: 1130, DateOfEsti: 2024, EYear: 2018 }), 2024);
  // No 2024 count at this station, so 2024 carries 2023's value forward and
  // DateOfEsti still names the real vintage.
  assert.equal(currentAadtYear({ AADT_2024: 400, AADT_2023: 400, AADT: 540, DateOfEsti: 2023, EYear: 2017 }), 2023);
});

test('uses EYear when the count came from the AADT fallback column', () => {
  // Only the legacy column has a value, so DateOfEsti (which describes a
  // newer count this feature does not carry) would be the wrong year.
  assert.equal(currentAadtYear({ AADT: 1040, DateOfEsti: 2024, EYear: 2019 }), 2019);
});

test('returns null rather than guessing a year', () => {
  // No count at all — nothing to date.
  assert.equal(currentAadtYear({ DateOfEsti: 2024 }), null);
  // A count but no usable year: print it bare rather than assert a wrong one.
  assert.equal(currentAadtYear({ AADT_2024: 1230 }), null);
  assert.equal(currentAadtYear({ AADT_2024: 1230, DateOfEsti: null }), null);
  assert.equal(currentAadtYear({ AADT_2024: 1230, DateOfEsti: 0 }), null);
  assert.equal(currentAadtYear(null), null);
  assert.equal(currentAadtYear(undefined), null);
});

console.log('\narcgis.js — buildAadtIndex');

test('indexes on the current count, not a carried-forward one', () => {
  const fc = { features: [
    { properties: { StationNum: 73, AADT: 1040, AADT_2023: 1020, AADT_2024: 1000 } },
  ] };
  assert.equal(buildAadtIndex(fc).get(73), 1000);
});

test('keeps the max across a station\'s segments', () => {
  // Same station, two directions/sections — busiest is the useful summary.
  const fc = { features: [
    { properties: { StationNum: 5, AADT: 100, AADT_2023: 300, AADT_2024: 300 } },
    { properties: { StationNum: 5, AADT: 999, AADT_2023: 700, AADT_2024: 700 } },
    { properties: { StationNum: 5, AADT: 100, AADT_2023: 200, AADT_2024: 200 } },
  ] };
  assert.equal(buildAadtIndex(fc).get(5), 700, 'max of the current column, not of AADT');
});

test('skips features with no station or no usable count', () => {
  const fc = { features: [
    { properties: { StationNum: null, AADT_2024: 500 } },
    { properties: { StationNum: 9, AADT_2024: null, AADT_2023: null, AADT: null } },
    { properties: { StationNum: 9, AADT_2024: 250 } },
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
