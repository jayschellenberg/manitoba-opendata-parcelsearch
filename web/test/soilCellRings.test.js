// The spatial filter for the parcel-scoped soil fetch must be made of
// DISJOINT rings.
//
// WHY THIS EXISTS. Batching sends many rings to ArcGIS as one Esri polygon,
// and Esri resolves a multi-ring polygon by winding/parity: where two
// same-direction outer rings overlap, the overlap reads as a HOLE. The first
// version of this fetch sent raw parcel bounding boxes, which in a comp set
// overlap constantly — measured 69 overlapping pairs in a single batch of 50.
// Any soil polygon reaching only into one of those holes was never returned.
//
// Measured against the live service on the reported case (1,122 parcels over
// Macdonald and five neighbours): the raw-bbox batching returned 588 soil
// polygons where the truth is 781 — it silently lost 193 of them, 25%. One
// visible consequence was parcel 37865 losing a 6.35% share of class-1 Fort
// Garry from its composition, with nothing on screen to say a component was
// missing.
//
// Nothing about that failure is visible from the outside: the request
// succeeds, the columns fill, the percentages just quietly do not add up to
// what the survey says. So the invariant is pinned here instead of trusted.
//
// Run: cd web && node test/soilCellRings.test.js

import assert from 'node:assert/strict';
import { soilCellRings } from '../src/arcgis.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const parcel = (w, s, e, n) => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
});

// Ring -> [w, s, e, n]
const boxOf = (f) => {
  const ring = f.geometry.coordinates[0];
  const xs = ring.map((p) => p[0]); const ys = ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
// Positive-area overlap only; sharing an edge is not an overlap.
const overlapArea = (a, b) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
};

console.log('soil cell rings — the batch filter must be disjoint');

// The shape that broke it: heavily overlapping parcel bounding boxes.
const OVERLAPPING = [
  parcel(-97.2000, 49.5000, -97.1900, 49.5090),
  parcel(-97.1950, 49.5040, -97.1850, 49.5130),
  parcel(-97.1930, 49.5010, -97.1830, 49.5100),
  parcel(-97.1990, 49.5060, -97.1890, 49.5150),
  parcel(-97.1970, 49.5020, -97.1870, 49.5110),
];

test('the input really is the overlapping case this guards', () => {
  let pairs = 0;
  const boxes = OVERLAPPING.map(boxOf);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) if (overlapArea(boxes[i], boxes[j]) > 0) pairs++;
  }
  assert.ok(pairs > 0, 'the fixture must contain overlapping bboxes or it proves nothing');
});

test('no two emitted rings overlap in area', () => {
  const boxes = soilCellRings(OVERLAPPING).map(boxOf);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.equal(overlapArea(boxes[i], boxes[j]), 0,
        `cells ${i} and ${j} overlap — Esri reads that overlap as a hole and drops `
        + 'any soil polygon that only reaches into it');
    }
  }
});

test('every parcel bbox is fully covered by the cells', () => {
  // Over-fetching is fine and expected; under-covering is the bug.
  const cells = soilCellRings(OVERLAPPING).map(boxOf);
  for (const p of OVERLAPPING) {
    const [w, s, e, n] = boxOf(p);
    let covered = 0;
    for (const c of cells) covered += overlapArea([w, s, e, n], c);
    const need = (e - w) * (n - s);
    assert.ok(covered >= need - 1e-12,
      `a parcel bbox is only ${(100 * covered / need).toFixed(4)}% covered by the cells`);
  }
});

test('a parcel spanning a cell boundary gets every cell it touches', () => {
  // 0.01-degree grid: this one straddles two columns and two rows.
  const cells = soilCellRings([parcel(-97.2050, 49.4950, -97.1950, 49.5050)]);
  assert.ok(cells.length >= 4, `expected at least 4 cells, got ${cells.length}`);
});

test('identical parcels collapse to one cell set', () => {
  const one = soilCellRings([parcel(-97.2000, 49.5000, -97.1990, 49.5010)]);
  const five = soilCellRings(Array.from({ length: 5 },
    () => parcel(-97.2000, 49.5000, -97.1990, 49.5010)));
  assert.equal(five.length, one.length, 'duplicate ground should not produce duplicate rings');
});

test('unusable geometry is skipped, not emitted as a broken ring', () => {
  const bad = { type: 'Feature', properties: {}, geometry: null };
  assert.deepEqual(soilCellRings([bad]), []);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
