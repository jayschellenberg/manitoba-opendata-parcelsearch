// Tests for lib/salesMapColors.js — the Sales Charts map's colouring.
//
// Run: cd web && node test/salesMapColors.test.js

import assert from 'node:assert/strict';
import {
  priceBuckets, yearColors, circleRing, PRICE_RAMP, SIZE_RAMP,
} from '../src/lib/salesMapColors.js';

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }

console.log('priceBuckets');
test('quintiles put about a fifth of the sales in each colour', () => {
  const vals = Array.from({ length: 100 }, (_, i) => (i + 1) * 1000);
  const b = priceBuckets(vals);
  assert.equal(b.legend.length, 5);
  const counts = new Map();
  for (const v of vals) counts.set(b.colorOf(v), (counts.get(b.colorOf(v)) || 0) + 1);
  for (const c of PRICE_RAMP) assert.ok(counts.get(c) >= 19 && counts.get(c) <= 21, `${c}: ${counts.get(c)}`);
  assert.equal(b.colorOf(1000), PRICE_RAMP[0], 'cheapest is palest');
  assert.equal(b.colorOf(100000), PRICE_RAMP[4], 'dearest is darkest');
});
test('ties collapse breaks instead of inventing empty buckets', () => {
  const b = priceBuckets([5, 5, 5, 5, 5, 5, 9]);
  assert.ok(b.legend.length < 5);
  assert.equal(b.colorOf(5), PRICE_RAMP[0]);
  assert.equal(b.colorOf(9), PRICE_RAMP[4]);
});
test('nothing to colour', () => { assert.equal(priceBuckets([]), null); });
test('the lot-size map uses its own ramp, smallest palest', () => {
  const b = priceBuckets([0.2, 0.5, 1, 2, 5, 10, 40, 80], String, SIZE_RAMP);
  assert.equal(b.colorOf(0.2), SIZE_RAMP[0]);
  assert.equal(b.colorOf(80), SIZE_RAMP[4]);
  assert.ok(b.legend.every((l) => SIZE_RAMP.includes(l.color)));
  assert.ok(!SIZE_RAMP.some((c) => PRICE_RAMP.includes(c)), 'no colour shared with the price ramp');
});

console.log('yearColors');
test('one colour per year, oldest palest', () => {
  const y = yearColors([2019, 2021, 2019, 2024]);
  assert.deepEqual(y.legend.map((l) => l.label), ['2019', '2021', '2024']);
  assert.equal(y.colorOf(2019), '#fee8c8');
  assert.equal(y.colorOf(2024), '#b30000');
  assert.equal(y.colorOf(2020), null);
});

console.log('circleRing');
test('a closed ring at the right radius', () => {
  const c = { lat: 49.9, lng: -97.1 };
  const ring = circleRing(c, 10);
  assert.deepEqual(ring[0].map((v) => v.toFixed(9)), ring[ring.length - 1].map((v) => v.toFixed(9)));
  // Due north: 10 km is ~0.0899 degrees of latitude.
  assert.ok(Math.abs(ring[0][1] - c.lat - 10 / 111.195) < 1e-3);
});

console.log(`\n${passed}/${passed} passed`);
