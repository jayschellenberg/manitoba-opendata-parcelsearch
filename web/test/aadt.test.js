// Unit tests for the MHTIS traffic-flow AADT field selection.
//
// The 2023 Traffic Flow service ships BOTH a current count (AADT_2023) and a
// carried-forward prior estimate under the obvious name (AADT). Reading the
// wrong one yields numbers that are several years stale but entirely
// plausible — no error, no blank cell, just quietly outdated traffic volumes
// in an appraisal. These tests pin the precedence so a later refactor can't
// "simplify" it back to props.AADT.
//
// Run: cd web && node test/aadt.test.js

import assert from 'node:assert/strict';
import { currentAadt, buildAadtIndex } from '../src/arcgis.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('arcgis.js — currentAadt');

test('prefers AADT_2023 over the carried-forward AADT', () => {
  // Real values from station 73 on 2026-08-05: the service reports the 2019
  // estimate (1040) under AADT and the current one (1020) under AADT_2023.
  assert.equal(currentAadt({ AADT: 1040, AADT_2023: 1020 }), 1020);
  // Station 533 — the gap runs the other way, so this is not just "smaller wins".
  assert.equal(currentAadt({ AADT: 540, AADT_2023: 400 }), 400);
  // Station 1502 — current count HIGHER than the carried-forward one.
  assert.equal(currentAadt({ AADT: 40, AADT_2023: 60 }), 60);
});

test('falls back to AADT when the current column is absent', () => {
  // An FC cached before the switch, or a future republish that renames things.
  assert.equal(currentAadt({ AADT: 1040 }), 1040);
});

test('treats null, zero and non-numeric as absent', () => {
  assert.equal(currentAadt({ AADT_2023: null, AADT: 900 }), 900);
  assert.equal(currentAadt({ AADT_2023: 0, AADT: 900 }), 900);
  assert.equal(currentAadt({ AADT_2023: 'n/a', AADT: 900 }), 900);
  assert.equal(currentAadt({}), null);
  assert.equal(currentAadt(null), null);
  assert.equal(currentAadt(undefined), null);
});

console.log('\narcgis.js — buildAadtIndex');

test('indexes on the current count, not the carried-forward one', () => {
  const fc = { features: [
    { properties: { StationNum: 73, AADT: 1040, AADT_2023: 1020 } },
  ] };
  assert.equal(buildAadtIndex(fc).get(73), 1020);
});

test('keeps the max across a station\'s segments', () => {
  // Same station, two directions/sections — busiest is the useful summary.
  const fc = { features: [
    { properties: { StationNum: 5, AADT: 100, AADT_2023: 300 } },
    { properties: { StationNum: 5, AADT: 999, AADT_2023: 700 } },
    { properties: { StationNum: 5, AADT: 100, AADT_2023: 200 } },
  ] };
  assert.equal(buildAadtIndex(fc).get(5), 700, 'max of AADT_2023, not of AADT');
});

test('skips features with no station or no usable count', () => {
  const fc = { features: [
    { properties: { StationNum: null, AADT_2023: 500 } },
    { properties: { StationNum: 9, AADT_2023: null, AADT: null } },
    { properties: { StationNum: 9, AADT_2023: 250 } },
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
