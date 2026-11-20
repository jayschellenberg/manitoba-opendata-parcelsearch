// Unit tests for lib/pinClusters.js — one locator pin per group of parcels.
//
// Run: cd web && node test/pinClusters.test.js

import assert from 'node:assert/strict';
import { clusterPinPoints, PIN_CLUSTER_GAP_M } from '../src/lib/pinClusters.js';

/** A square parcel `sizeM` metres a side, south-west corner at (lng, lat). */
function lot(lng, lat, sizeM = 100) {
  const dLat = sizeM / 111320;
  const dLng = sizeM / (111320 * Math.cos((lat * Math.PI) / 180));
  return {
    type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [[[lng, lat], [lng + dLng, lat], [lng + dLng, lat + dLat], [lng, lat + dLat], [lng, lat]]] },
  };
}

const dLng100 = 100 / (111320 * Math.cos((49.85 * Math.PI) / 180));

// Empty / missing geometry.
assert.deepEqual(clusterPinPoints([]), []);
assert.deepEqual(clusterPinPoints(null), []);
assert.deepEqual(clusterPinPoints([{ type: 'Feature', geometry: null }]), []);

// One parcel: its bbox midpoint, count 1.
{
  const [p, ...rest] = clusterPinPoints([lot(-97.4, 49.85)]);
  assert.equal(rest.length, 0);
  assert.equal(p.count, 1);
  assert.ok(Math.abs(p.lng - (-97.4 + dLng100 / 2)) < 1e-9);
}

// Two adjoining lots (a two-roll subject): one pin between them.
{
  const pins = clusterPinPoints([lot(-97.4, 49.85), lot(-97.4 + dLng100, 49.85)]);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].count, 2);
  assert.ok(Math.abs(pins[0].lng - (-97.4 + dLng100)) < 1e-9, 'pin at the middle of the pair');
}

// Across a 20 m road allowance: still one pin.
{
  const gap = 20 / (111320 * Math.cos((49.85 * Math.PI) / 180));
  assert.equal(clusterPinPoints([lot(-97.4, 49.85), lot(-97.4 + dLng100 + gap, 49.85)]).length, 1);
}

// 2 km apart: two pins. Chains join transitively.
{
  const far = 2000 / (111320 * Math.cos((49.85 * Math.PI) / 180));
  assert.equal(clusterPinPoints([lot(-97.4, 49.85), lot(-97.4 + far, 49.85)]).length, 2);
  const chain = [0, 1, 2, 3].map((i) => lot(-97.4 + i * (dLng100 + 200 / 111320 / 0.645), 49.85));
  assert.equal(clusterPinPoints(chain).length, 1, 'lots 200 m apart in a row share one pin');
  assert.equal(clusterPinPoints(chain, { gapM: 100 }).length, 4);
}

assert.ok(PIN_CLUSTER_GAP_M > 0);
console.log('pinClusters: all tests passed');
