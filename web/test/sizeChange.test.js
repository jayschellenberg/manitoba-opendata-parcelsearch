// Unit tests for src/lib/sizeChange.js — historical→current parcel
// size-change banding.
//
// Run: cd web && node test/sizeChange.test.js

import assert from 'node:assert/strict';
import { sizeBand, computeSizeChanges, SIZE_MINOR_PCT, SIZE_MAJOR_PCT } from '../src/lib/sizeChange.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('sizeChange.js — sizeBand');

test('bands by absolute percent, signed-agnostic', () => {
  assert.equal(sizeBand(0), 'same');
  assert.equal(sizeBand(SIZE_MINOR_PCT), 'same');          // boundary inclusive at 5
  assert.equal(sizeBand(SIZE_MINOR_PCT + 0.1), 'minor');
  assert.equal(sizeBand(SIZE_MAJOR_PCT), 'minor');         // boundary inclusive at 25
  assert.equal(sizeBand(SIZE_MAJOR_PCT + 0.1), 'major');
  assert.equal(sizeBand(-30), 'major');                    // shrink counts too
  assert.equal(sizeBand(null), 'unknown');
  assert.equal(sizeBand(NaN), 'unknown');
});

console.log('sizeChange.js — computeSizeChanges');

test('classifies same / minor / major / gone / appeared', () => {
  const hist = new Map([['a', 10], ['b', 100], ['c', 5], ['e', 20]]);
  const cur  = new Map([['a', 10.2], ['b', 200], ['d', 7], ['e', 22.5]]);
  const { byRoll, summary } = computeSizeChanges(hist, cur);

  assert.equal(byRoll.get('a').band, 'same');   // +2%
  assert.equal(byRoll.get('b').band, 'major');  // +100%
  assert.equal(byRoll.get('c').band, 'gone');   // not in current
  assert.equal(byRoll.get('e').band, 'minor');  // +12.5%
  assert.equal(byRoll.get('a').deltaPct.toFixed(1), '2.0');
  assert.equal(byRoll.get('c').curAcres, null);

  assert.deepEqual(summary, { same: 1, minor: 1, major: 1, gone: 1, appeared: 1, unknown: 0 });
});

test('non-positive acreage → unknown band', () => {
  const { byRoll, summary } = computeSizeChanges(new Map([['x', 0]]), new Map([['x', 4]]));
  assert.equal(byRoll.get('x').band, 'unknown');
  assert.equal(summary.unknown, 1);
});

test('empty inputs yield empty result', () => {
  const { byRoll, summary } = computeSizeChanges(new Map(), new Map());
  assert.equal(byRoll.size, 0);
  assert.deepEqual(summary, { same: 0, minor: 0, major: 0, gone: 0, appeared: 0, unknown: 0 });
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
