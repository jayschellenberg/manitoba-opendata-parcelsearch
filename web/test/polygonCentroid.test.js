// Unit tests for lib/polygonCentroid.js — the bbox-midpoint approximation
// used for parcel label placement (at tile-build time) and popup
// coordinates (at runtime).
//
// Run: cd web && node test/polygonCentroid.test.js

import assert from 'node:assert/strict';
import { polygonBboxMidpoint } from '../src/lib/polygonCentroid.js';

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

const square = (x, y) => ({
  type: 'Polygon',
  coordinates: [[[x, y], [x + 2, y], [x + 2, y + 2], [x, y + 2], [x, y]]],
});

test('midpoint of a square is its centre', () => {
  assert.deepEqual(polygonBboxMidpoint(square(0, 0)), [1, 1]);
});

test('negative coordinates work — Manitoba is west of the meridian', () => {
  assert.deepEqual(polygonBboxMidpoint(square(-98, 49)), [-97, 50]);
});

test('MultiPolygon spans every part', () => {
  const mp = {
    type: 'MultiPolygon',
    coordinates: [square(0, 0).coordinates, square(10, 10).coordinates],
  };
  assert.deepEqual(polygonBboxMidpoint(mp), [6, 6]);
});

test('interior rings do not move the midpoint outside the bbox', () => {
  const donut = {
    type: 'Polygon',
    coordinates: [
      square(0, 0).coordinates[0],
      [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]],
    ],
  };
  assert.deepEqual(polygonBboxMidpoint(donut), [1, 1]);
});

test('a Point yields null — that is how the callout sites detect a withheld parcel', () => {
  assert.equal(polygonBboxMidpoint({ type: 'Point', coordinates: [1, 2] }), null);
});

test('LineString yields null too', () => {
  assert.equal(polygonBboxMidpoint({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }), null);
});

test('missing or empty geometry yields null rather than throwing', () => {
  assert.equal(polygonBboxMidpoint(null), null);
  assert.equal(polygonBboxMidpoint(undefined), null);
  assert.equal(polygonBboxMidpoint({}), null);
  assert.equal(polygonBboxMidpoint({ type: 'Polygon' }), null);
  assert.equal(polygonBboxMidpoint({ type: 'Polygon', coordinates: [] }), null);
  assert.equal(polygonBboxMidpoint({ type: 'Polygon', coordinates: [[]] }), null);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
