// Unit tests for src/lib/acres.js — the assessor-vs-geometry acreage
// resolver and its nominal-roll sanity guard.
//
// Run: cd web && node test/acres.test.js

import assert from 'node:assert/strict';
import {
  resolveParcelAcres,
  ROLL_NOMINAL_RATIO,
  ROLL_NOMINAL_MIN_GEOM_ACRES,
  AREA_VARIANCE_PCT,
  formatRollSizeField,
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

console.log('\nacres.js — roll-vs-shape cross-check');

test('agreement within tolerance does not flag', () => {
  // RM of Ste Anne roll 126910 as the province actually serves it
  // (2026-08-05): roll 17.22 ac against a 16.97 ac polygon. Both predate the
  // subdivision, so they agree with each other and nothing fires — the case
  // this check deliberately cannot catch.
  const r = resolveParcelAcres(17.22, 16.97);
  assert.equal(r.areaMismatch, false);
  assert.ok(r.variancePct < AREA_VARIANCE_PCT);
  assert.equal(r.source, 'assessor');
});

test('divergence past tolerance flags but still shows the assessor figure', () => {
  // A subdivision that reached the polygon but not the roll attribute.
  const r = resolveParcelAcres(17.22, 2.3);
  assert.equal(r.areaMismatch, true);
  assert.equal(r.acres, 17.22);            // assessor still wins the display
  assert.equal(r.source, 'assessor');
  assert.equal(r.geomValue, 2.3);
  assert.ok(r.variancePct > 6);            // ~648% of the shape area
});

test('variance is measured against the polygon, not the roll', () => {
  const r = resolveParcelAcres(11, 10);
  assert.ok(Math.abs(r.variancePct - 0.1) < 1e-9);
});

test('exactly at the tolerance does not flag; just past it does', () => {
  const at = resolveParcelAcres(10 * (1 + AREA_VARIANCE_PCT), 10);
  assert.equal(at.areaMismatch, false);    // boundary is inclusive-agreeing
  const past = resolveParcelAcres(10 * (1 + AREA_VARIANCE_PCT) + 0.01, 10);
  assert.equal(past.areaMismatch, true);
});

test('nominal-roll parcels are not double-flagged', () => {
  const r = resolveParcelAcres(0.01, 357.09);
  assert.equal(r.rollNominal, true);
  assert.equal(r.areaMismatch, false);     // rollNominal already explains it
  assert.equal(r.variancePct, null);
});

test('single-sided figures cannot be cross-checked', () => {
  assert.equal(resolveParcelAcres(12.5, null).variancePct, null);
  assert.equal(resolveParcelAcres(12.5, null).areaMismatch, false);
  assert.equal(resolveParcelAcres(null, 8.4).variancePct, null);
  assert.equal(resolveParcelAcres(null, 8.4).areaMismatch, false);
});

test('geomValue is exposed for the UI on every branch that has one', () => {
  assert.equal(resolveParcelAcres(17.22, 2.3).geomValue, 2.3);
  assert.equal(resolveParcelAcres(null, 8.4).geomValue, 8.4);
  assert.equal(resolveParcelAcres(12.5, null).geomValue, null);
  assert.equal(resolveParcelAcres(null, null).geomValue, null);
});

console.log('\nacres.js — formatRollSizeField (the roll\'s own figure, verbatim)');

test('an acres figure keeps its number and trailing zeros', () => {
  assert.equal(formatRollSizeField('160.00 ACRES'), '160.00 acres');
});

test('a frontage figure survives instead of being discarded', () => {
  // The whole point: 37% of parcels state feet, and this is the only
  // assessor-stated size they have. It must not silently become acres.
  assert.equal(formatRollSizeField('110.00 FEET'), '110.00 feet');
});

test('hectares and abbreviations lower-case too', () => {
  assert.equal(formatRollSizeField('2.5 HA'), '2.5 ha');
  assert.equal(formatRollSizeField('45 FT'), '45 ft');
});

test('null-ish and the literal <Null> render as empty, not as text', () => {
  for (const v of [null, undefined, '', '   ', '<Null>']) {
    assert.equal(formatRollSizeField(v), '', `expected '' for ${JSON.stringify(v)}`);
  }
});

test('an unrecognised string is passed through rather than dropped', () => {
  // Better to show something odd than to hide what the roll says.
  assert.equal(formatRollSizeField('16.10'), '16.10');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
