// Unit tests for lib/parcelPackGroups.js — which result parcels share a set
// of Parcel Pack maps, and what the files are called.
//
// Run: cd web && node test/parcelPackGroups.test.js

import assert from 'node:assert/strict';
import {
  boxGapMeters, suggestMerges, applyMerges, packBaseName, uniqueName,
} from '../src/lib/parcelPackGroups.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// ~0.0072 degrees of longitude is ~500 m at 50 N; 0.0045 of latitude ~500 m.
const quarter = [-97.0072, 50.0, -97.0, 50.0045];
const sliver = [-97.0, 50.0, -96.9995, 50.0005];          // touches the quarter
const farSliver = [-96.9, 50.0, -96.8995, 50.0005];       // ~7 km away
const feat = (roll, extra = {}) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] },
  properties: { Roll_No_Txt: roll, Municipality: '610 - TEST (RM)', ...extra },
});

console.log('boxGapMeters');
test('touching boxes have no gap', () => assert.equal(boxGapMeters(quarter, sliver), 0));
test('distant boxes are kilometres apart', () => assert.ok(boxGapMeters(quarter, farSliver) > 5000));
test('a missing box is infinitely far', () => assert.equal(boxGapMeters(null, quarter), Infinity));

console.log('suggestMerges');
test('a sliver beside a quarter goes with it', () => {
  const m = suggestMerges([{ id: 'q', acres: 160, box: quarter }, { id: 's', acres: 2, box: sliver }]);
  assert.deepEqual([...m], [['s', 'q']]);
});
test('a small parcel far away stands alone', () => {
  const m = suggestMerges([{ id: 'q', acres: 160, box: quarter }, { id: 's', acres: 2, box: farSliver }]);
  assert.equal(m.size, 0);
});
test('similar-sized neighbours are not merged', () => {
  const m = suggestMerges([{ id: 'q', acres: 160, box: quarter }, { id: 's', acres: 80, box: sliver }]);
  assert.equal(m.size, 0);
});
test('unknown areas are never suggested', () => {
  const m = suggestMerges([{ id: 'q', acres: 160, box: quarter }, { id: 's', acres: null, box: sliver }]);
  assert.equal(m.size, 0);
});
test('a target is not itself merged away', () => {
  const m = suggestMerges([
    { id: 'big', acres: 2000, box: quarter }, { id: 'mid', acres: 150, box: sliver }, { id: 'tiny', acres: 5, box: sliver },
  ]);
  assert.equal(m.get('mid'), 'big');
  assert.equal(m.get('tiny'), 'big');
});

console.log('applyMerges');
const frames = [
  { id: 'a', members: [feat('100')] }, { id: 'b', members: [feat('200')] }, { id: 'c', members: [feat('300')] },
];
const rolls = (sets) => sets.map((s) => s.map((f) => f.properties.Roll_No_Txt));
test('no choices: one set per frame', () => {
  assert.deepEqual(rolls(applyMerges(frames, new Map())), [['100'], ['200'], ['300']]);
});
test('a merged frame joins its target', () => {
  assert.deepEqual(rolls(applyMerges(frames, new Map([['c', 'a']]))), [['100', '300'], ['200']]);
});
test('chains end up together', () => {
  assert.deepEqual(rolls(applyMerges(frames, new Map([['a', 'b'], ['b', 'c']]))), [['300', '100', '200']]);
});
test('a loop leaves both frames alone', () => {
  assert.deepEqual(rolls(applyMerges(frames, { a: 'b', b: 'a' })), [['100'], ['200'], ['300']]);
});
test('unknown and self targets are ignored', () => {
  assert.deepEqual(rolls(applyMerges(frames, { a: 'zzz', b: 'b' })), [['100'], ['200'], ['300']]);
});

console.log('names');
test('one parcel', () => assert.equal(packBaseName([feat('225600.000')]), '610-225600'));
test('merged parcels list rolls lowest first with a count', () => {
  assert.equal(packBaseName([feat('300'), feat('100')]), '610-100_300-2p');
});
test('uniqueName adds a suffix on a clash', () => {
  const used = new Set();
  assert.equal(uniqueName('610-1', used), '610-1');
  assert.equal(uniqueName('610-1', used), '610-1-2');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
