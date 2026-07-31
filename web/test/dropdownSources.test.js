// Unit tests for lib/dropdownSources.js — how the boot dropdowns degrade
// when the probes behind them fail independently.
//
// Written against a live incident: the municipality picker came up reading
// "Failed to load" because the four boot probes shared one Promise.all, and
// something transient upstream rejected it. Both provincial services tested
// healthy minutes later, so the outage was a blip; the damage was the
// all-or-nothing coupling.
//
// Run: cd web && node test/dropdownSources.test.js

import assert from 'node:assert/strict';
import {
  resolveDropdownSources,
  MUNI_PLACEHOLDER,
  MUNI_FAILED_PLACEHOLDER,
  ZONE_PLACEHOLDER,
  ZONE_FAILED_PLACEHOLDER,
} from '../src/lib/dropdownSources.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const LIVE = ['ALEXANDER (RM)', 'BRANDON (CITY)', 'PINEY (RM)'];
const SNAPSHOT = ['ALEXANDER (RM)', 'BRANDON (CITY)', 'PINEY (RM)', 'STUARTBURN (RM)'];
const ZONES = ['Agricultural', 'Residential'];

console.log('healthy boot');

test('everything up: live lists, no snapshot mode', () => {
  const r = resolveDropdownSources({ liveMunis: LIVE, zoneCats: ZONES, snapshotMunis: SNAPSHOT });
  assert.deepEqual(r.munis, LIVE);
  assert.equal(r.muniSource, 'live');
  assert.equal(r.muniPlaceholder, MUNI_PLACEHOLDER);
  assert.deepEqual(r.zoneCats, ZONES);
  assert.equal(r.zonePlaceholder, ZONE_PLACEHOLDER);
  assert.equal(r.useSnapshot, false);
});

console.log('\nthe reported bug — one service blips');

test('a failed ZONING probe must not touch the municipality picker', () => {
  const r = resolveDropdownSources({ liveMunis: LIVE, zoneCats: null, snapshotMunis: SNAPSHOT });
  assert.deepEqual(r.munis, LIVE, 'munis survive a zoning outage');
  assert.equal(r.muniPlaceholder, MUNI_PLACEHOLDER, 'and show no error');
  assert.deepEqual(r.zoneCats, []);
  assert.equal(r.zonePlaceholder, ZONE_FAILED_PLACEHOLDER, 'the zoning dropdown owns the failure');
  assert.equal(r.useSnapshot, false, 'a zoning blip is not a Roll_Entry problem');
});

test('a failed MUNI probe falls back to the snapshot names', () => {
  const r = resolveDropdownSources({ liveMunis: null, zoneCats: ZONES, snapshotMunis: SNAPSHOT });
  assert.deepEqual(r.munis, SNAPSHOT);
  assert.equal(r.muniSource, 'snapshot-fallback');
  assert.equal(r.muniPlaceholder, MUNI_PLACEHOLDER, 'no error shown over data we have');
  assert.deepEqual(r.zoneCats, ZONES, 'the zoning dropdown is unaffected');
});

test('borrowing snapshot NAMES must not flip snapshot MODE', () => {
  // The distinction that matters: routing a whole session to static shards
  // because one dropdown query blipped would be worse than the blip.
  const r = resolveDropdownSources({ liveMunis: null, zoneCats: ZONES, snapshotMunis: SNAPSHOT });
  assert.equal(r.useSnapshot, false);
});

test('an empty live list is treated as a failure, not as zero munis', () => {
  const r = resolveDropdownSources({ liveMunis: [], zoneCats: ZONES, snapshotMunis: SNAPSHOT });
  assert.deepEqual(r.munis, SNAPSHOT);
  assert.equal(r.muniSource, 'snapshot-fallback');
});

test('both probes down: each dropdown reports its own state', () => {
  const r = resolveDropdownSources({ liveMunis: null, zoneCats: null, snapshotMunis: SNAPSHOT });
  assert.deepEqual(r.munis, SNAPSHOT, 'muni picker still works off the snapshot');
  assert.equal(r.zonePlaceholder, ZONE_FAILED_PLACEHOLDER);
  assert.equal(r.useSnapshot, false);
});

console.log('\npartial republish — the case snapshot mode exists for');

test('incomplete live service switches to the snapshot list AND snapshot mode', () => {
  const r = resolveDropdownSources({
    liveMunis: ['ALEXANDER (RM)'], zoneCats: ZONES, snapshotMunis: SNAPSHOT, incomplete: true,
  });
  assert.deepEqual(r.munis, SNAPSHOT, 'a user must be able to select all of Manitoba');
  assert.equal(r.muniSource, 'snapshot');
  assert.equal(r.useSnapshot, true, 'this one DOES reroute parcel queries');
});

test('incomplete but no snapshot available: keep the partial live list', () => {
  const r = resolveDropdownSources({
    liveMunis: ['ALEXANDER (RM)'], zoneCats: ZONES, snapshotMunis: [], incomplete: true,
  });
  assert.deepEqual(r.munis, ['ALEXANDER (RM)'], 'a short list beats no list');
  assert.equal(r.useSnapshot, false, 'never route to a snapshot that is not there');
});

console.log('\nnothing to fall back on');

test('muni probe down and no snapshot: the error placeholder is honest', () => {
  const r = resolveDropdownSources({ liveMunis: null, zoneCats: ZONES, snapshotMunis: [] });
  assert.deepEqual(r.munis, []);
  assert.equal(r.muniSource, 'none');
  assert.equal(r.muniPlaceholder, MUNI_FAILED_PLACEHOLDER);
});

test('no arguments at all does not throw', () => {
  const r = resolveDropdownSources();
  assert.deepEqual(r.munis, []);
  assert.deepEqual(r.zoneCats, []);
  assert.equal(r.useSnapshot, false);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
