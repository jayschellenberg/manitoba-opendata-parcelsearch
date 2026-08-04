// Area-selection shape filter — the pure predicates behind the draw
// radius/rectangle/polygon tools. The include/exclude combinations are
// the point: Matrix semantics say exclude always wins, include shapes
// only constrain when at least one exists, and a row with no placeable
// centroid must not leak into an area-narrowed set.
import assert from 'node:assert/strict';
import {
  pointInRing,
  pointInShape,
  passesShapeFilter,
  circleRing,
  rectRing,
  shapesToFc,
} from '../src/lib/shapeFilter.js';

// A ~10 km square around Niverville-ish coordinates.
const SQUARE = [
  [-97.10, 49.55],
  [-96.96, 49.55],
  [-96.96, 49.65],
  [-97.10, 49.65],
];
const INSIDE  = { lng: -97.03, lat: 49.60 };
const OUTSIDE = { lng: -97.30, lat: 49.60 };

// ---- pointInRing ----------------------------------------------------------
assert.equal(pointInRing(INSIDE, SQUARE), true);
assert.equal(pointInRing(OUTSIDE, SQUARE), false);
// Closed ring (duplicated first vertex) behaves identically.
assert.equal(pointInRing(INSIDE, [...SQUARE, SQUARE[0]]), true);
// Degenerate inputs never throw and never match.
assert.equal(pointInRing(INSIDE, []), false);
assert.equal(pointInRing(INSIDE, SQUARE.slice(0, 2)), false);
assert.equal(pointInRing(null, SQUARE), false);

// A concave (L-shaped) ring: the notch is OUTSIDE even though its
// bounding box contains it — this is what ray casting buys over a
// bbox test.
const L_SHAPE = [
  [0, 0], [4, 0], [4, 4], [3, 4], [3, 1], [0, 1],
];
assert.equal(pointInRing({ lng: 3.5, lat: 2 }, L_SHAPE), true,  'inside the L arm');
assert.equal(pointInRing({ lng: 1, lat: 3 },   L_SHAPE), false, 'in the notch = outside');

// ---- pointInShape ---------------------------------------------------------
const CIRCLE = { kind: 'circle', mode: 'include', center: { lng: -97.0, lat: 49.6 }, radiusKm: 5 };
// ~2.2 km east of centre — inside; ~22 km — outside.
assert.equal(pointInShape({ lng: -96.97, lat: 49.6 }, CIRCLE), true);
assert.equal(pointInShape({ lng: -96.70, lat: 49.6 }, CIRCLE), false);
assert.equal(pointInShape(INSIDE, { kind: 'polygon', mode: 'include', ring: SQUARE }), true);
assert.equal(pointInShape(INSIDE, null), false);
assert.equal(pointInShape(null, CIRCLE), false);

// ---- passesShapeFilter: the include/exclude matrix ------------------------
const inc = (ring) => ({ kind: 'polygon', mode: 'include', ring });
const exc = (ring) => ({ kind: 'polygon', mode: 'exclude', ring });
const FAR_SQUARE = SQUARE.map(([x, y]) => [x - 1, y]); // shifted ~70 km west

// No shapes → filter off, everything passes.
assert.equal(passesShapeFilter(INSIDE, []), true);
assert.equal(passesShapeFilter(null, []), true);
// One include: in passes, out fails.
assert.equal(passesShapeFilter(INSIDE,  [inc(SQUARE)]), true);
assert.equal(passesShapeFilter(OUTSIDE, [inc(SQUARE)]), false);
// Two includes: inside EITHER passes.
assert.equal(passesShapeFilter(INSIDE, [inc(FAR_SQUARE), inc(SQUARE)]), true);
// Only excludes: outside them passes, inside fails.
assert.equal(passesShapeFilter(INSIDE,  [exc(SQUARE)]), false);
assert.equal(passesShapeFilter(OUTSIDE, [exc(SQUARE)]), true);
// Exclude wins over include — an exclude hole cut into an include area.
const HOLE = [
  [-97.05, 49.58], [-97.01, 49.58], [-97.01, 49.62], [-97.05, 49.62],
];
assert.equal(passesShapeFilter({ lng: -97.03, lat: 49.60 }, [inc(SQUARE), exc(HOLE)]), false);
assert.equal(passesShapeFilter({ lng: -96.98, lat: 49.56 }, [inc(SQUARE), exc(HOLE)]), true);
// Unplaceable point fails once any shape exists.
assert.equal(passesShapeFilter(null, [inc(SQUARE)]), false);
assert.equal(passesShapeFilter(null, [exc(SQUARE)]), false);

// ---- ring builders --------------------------------------------------------
const RING = circleRing({ lng: -97, lat: 49.6 }, 2);
assert.equal(RING.length, 65, '64 segments close back to the start');
assert.deepEqual(RING[0], RING[RING.length - 1]);
// Every ring vertex sits ~2 km from the centre (local-tangent approx:
// allow a loose ±5% band).
import { haversineKm } from '../src/lib/routeSolver.js';
for (const [lng, lat] of RING) {
  const d = haversineKm({ lng: -97, lat: 49.6 }, { lng, lat });
  assert.ok(d > 1.9 && d < 2.1, `ring vertex ${d.toFixed(3)} km from centre`);
}
const RECT = rectRing({ lng: 0, lat: 0 }, { lng: 2, lat: 1 });
assert.equal(RECT.length, 5);
assert.deepEqual(RECT[0], RECT[4]);
assert.equal(pointInRing({ lng: 1, lat: 0.5 }, RECT), true);

// ---- shapesToFc -----------------------------------------------------------
const fc = shapesToFc([
  { id: 1, ...CIRCLE },
  { id: 2, kind: 'polygon', mode: 'exclude', ring: SQUARE },
]);
assert.equal(fc.features.length, 2);
assert.equal(fc.features[0].properties.mode, 'include');
assert.equal(fc.features[1].properties.mode, 'exclude');
// Polygon coordinates are closed for rendering even when the source
// ring was open.
const polyCoords = fc.features[1].geometry.coordinates[0];
assert.deepEqual(polyCoords[0], polyCoords[polyCoords.length - 1]);

console.log('shapeFilter.test.js: all assertions passed');
