// Unit tests for src/lib/acres.js — the assessor-vs-geometry acreage
// resolver and its nominal-roll sanity guard.
//
// Run: cd web && node test/acres.test.js

import assert from 'node:assert/strict';
import {
  resolveParcelAcres,
  ROLL_NOMINAL_RATIO,
  ROLL_NOMINAL_MIN_GEOM_ACRES,
} from '../src/lib/acres.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('acres.js — resolveParcelAcres');

test('prefers assessor area when both present and plausible', () => {
  const r = resolveParcelAcres(144.06, 159.59);
  assert.equal(r.acres, 144.06);
  assert.equal(r.source, 'assessor');
  assert.equal(r.rollNominal, false);
});

test('nominal roll on a large polygon falls back to geometry + flags', () => {
  const r = resolveParcelAcres(0.01, 357.09);   // crown/reserve placeholder
  assert.equal(r.acres, 357.09);
  assert.equal(r.source, 'geometry');
  assert.equal(r.rollNominal, true);
  assert.equal(r.rollValue, 0.01);
});

test('tiny roll on a SMALL polygon is NOT overridden (below geom floor)', () => {
  // geom 0.30 ac < ROLL_NOMINAL_MIN_GEOM_ACRES — guard must not fire.
  assert.ok(0.30 < ROLL_NOMINAL_MIN_GEOM_ACRES);
  const r = resolveParcelAcres(0.01, 0.30);
  assert.equal(r.acres, 0.01);
  assert.equal(r.source, 'assessor');
  assert.equal(r.rollNominal, false);
});

test('roll within ratio of geometry is kept (not nominal)', () => {
  // roll = 90% of geom — clearly a real area.
  const r = resolveParcelAcres(143.6, 159.6);
  assert.equal(r.source, 'assessor');
  assert.equal(r.rollNominal, false);
});

test('guard boundary: roll exactly at ratio*geom with geom at floor → geometry', () => {
  const geom = ROLL_NOMINAL_MIN_GEOM_ACRES;          // 5
  const roll = geom * ROLL_NOMINAL_RATIO;            // 0.5
  const r = resolveParcelAcres(roll, geom);
  assert.equal(r.source, 'geometry');
  assert.equal(r.rollNominal, true);
});

test('no geometry → use assessor area', () => {
  const r = resolveParcelAcres(12.5, null);
  assert.equal(r.acres, 12.5);
  assert.equal(r.source, 'assessor');
});

test('no assessor area → use geometry (frontage fallback)', () => {
  const r = resolveParcelAcres(null, 8.4);
  assert.equal(r.acres, 8.4);
  assert.equal(r.source, 'geometry');
  assert.equal(r.rollValue, null);
});

test('neither present → null', () => {
  const r = resolveParcelAcres(null, null);
  assert.equal(r.acres, null);
  assert.equal(r.source, null);
});

test('non-finite / non-positive inputs are ignored', () => {
  assert.equal(resolveParcelAcres(NaN, 0).acres, null);
  assert.equal(resolveParcelAcres(0, -3).acres, null);
  assert.equal(resolveParcelAcres(-1, 5).acres, 5);     // bad roll, good geom
  assert.equal(resolveParcelAcres(-1, 5).source, 'geometry');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
