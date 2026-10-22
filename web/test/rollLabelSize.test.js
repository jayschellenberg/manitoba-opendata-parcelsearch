// Unit tests for lib/rollLabelSize.js — the one table behind the roll
// numbers' text-size expression and the callouts' "badge just above the
// roll number" offset (Jason, 2026-10-22).
//
// Run: cd web && node test/rollLabelSize.test.js

import assert from 'node:assert/strict';
import { rollLabelSize, rollLabelSizeExpression } from '../src/lib/rollLabelSize.js';

// The expression the muni-parcels-label layer carried before the table
// moved out of map.js — moving it must not change a single stop.
const BEFORE = [
  'interpolate', ['linear'], ['zoom'],
  13, ['interpolate', ['linear'], ['to-number', ['get', '_acres'], 1], 0.1, 7, 1, 9, 10, 11, 80, 12, 640, 14],
  14, ['interpolate', ['linear'], ['to-number', ['get', '_acres'], 1], 0.1, 7, 1, 10, 10, 12, 80, 13, 640, 15],
  17, ['interpolate', ['linear'], ['to-number', ['get', '_acres'], 1], 0.1, 9, 1, 12, 10, 14, 80, 16, 640, 18],
  19, ['interpolate', ['linear'], ['to-number', ['get', '_acres'], 1], 0.1, 11, 1, 14, 10, 16, 80, 18, 640, 20],
];
assert.deepEqual(rollLabelSizeExpression(), BEFORE);

// On the stops.
assert.equal(rollLabelSize(13, 0.1), 7);
assert.equal(rollLabelSize(17, 10), 14);
assert.equal(rollLabelSize(19, 640), 20);
// Clamped past both ends, on zoom and on acreage.
assert.equal(rollLabelSize(12, 640), 14);
assert.equal(rollLabelSize(21, 0.01), 11);
assert.equal(rollLabelSize(17, 5000), 18);
// Linear between stops: zoom 15.5 is halfway from 14 to 17; 5.5 ac is
// halfway from 1 to 10.
assert.equal(rollLabelSize(15.5, 1), 11);
assert.equal(rollLabelSize(14, 5.5), 11);
// A missing _acres reads as 0 (to-number(null)), a junk one as the 1.
assert.equal(rollLabelSize(17, undefined), 9);
assert.equal(rollLabelSize(17, null), 9);
assert.equal(rollLabelSize(17, 'n/a'), 12);

console.log('rollLabelSize.test.js: all assertions passed');
