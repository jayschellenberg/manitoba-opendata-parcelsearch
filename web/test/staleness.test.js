// Unit tests for lib/staleness.js — the MAO scrape staleness banner
// decision. The cadence is semiannual (NOT monthly), so the contract
// these tests pin down is: a one-or-two-month-old scrape is fresh.
//
// Run: cd web && node test/staleness.test.js

import assert from 'node:assert/strict';
import {
  stalenessBannerState,
  STALE_FRESH_MAX_DAYS,
  STALE_RED_MIN_DAYS,
} from '../src/lib/staleness.js';

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

console.log('stalenessBannerState');

test('a 36-day-old scrape is fresh (the false-alarm case)', () => {
  const s = stalenessBannerState(36);
  assert.equal(s.show, false);
  assert.equal(s.tone, null);
});

test('hidden right up to the semiannual mark (180 days)', () => {
  assert.equal(stalenessBannerState(0).show, false);
  assert.equal(stalenessBannerState(120).show, false);
  assert.equal(stalenessBannerState(STALE_FRESH_MAX_DAYS).show, false);
});

test('amber just past the semiannual mark', () => {
  const s = stalenessBannerState(STALE_FRESH_MAX_DAYS + 1);
  assert.equal(s.show, true);
  assert.equal(s.tone, 'data-staleness-amber');
  assert.match(s.tail, /semiannual/);
  assert.doesNotMatch(s.tail, /[Mm]onthly/);  // the framing we removed
});

test('amber holds through the nudge zone (up to 12 months)', () => {
  assert.equal(stalenessBannerState(270).tone, 'data-staleness-amber');
  assert.equal(stalenessBannerState(STALE_RED_MIN_DAYS).tone, 'data-staleness-amber');
});

test('red past the 12-month rule', () => {
  const s = stalenessBannerState(STALE_RED_MIN_DAYS + 1);
  assert.equal(s.show, true);
  assert.equal(s.tone, 'data-staleness-red');
  assert.match(s.tail, /12-month/);
});

test('lead reports the age', () => {
  assert.equal(stalenessBannerState(400).lead, 'MAO scrape is 400 days old.');
});

test('null / non-finite ages are hidden, never throw', () => {
  for (const v of [null, undefined, NaN, Infinity]) {
    assert.equal(stalenessBannerState(v).show, false);
  }
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
