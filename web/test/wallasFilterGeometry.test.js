// Geometry batching behind the water-rights search filters.
//
// The filters turn N licensed WALLAS footprints into a handful of
// spatial queries by merging each batch into ONE Esri multi-ring
// polygon. That only works if winding order is right: Esri reads
// clockwise rings as outer and counter-clockwise as holes, so a naive
// concatenation can silently punch some footprints out of their
// neighbours instead of unioning them. These tests pin that contract.
//
// Verified against the live service when this was written: batching 20
// irrigation footprints returned exactly the OBJECTID set the 20
// individual queries produced between them.
//
// Run: cd web && node test/wallasFilterGeometry.test.js

import assert from 'node:assert/strict';

function makeFakeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
}
globalThis.localStorage = makeFakeStorage();
globalThis.sessionStorage = makeFakeStorage();

const { _internals } = await import('../src/arcgis.js');
const { polygonsToEsriGeometry, orientRing, intersectSets } = _internals;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push('pass');
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push('fail');
    console.log(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

// Shoelace in lon/lat order: negative is clockwise.
function isClockwise(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a < 0;
}

const CCW_SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
const CW_SQUARE = [...CCW_SQUARE].reverse();

function poly(rings) {
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } };
}

console.log('WALLAS filter geometry tests');

test('orientRing forces the requested winding', () => {
  assert.ok(isClockwise(orientRing(CCW_SQUARE, true)), 'CCW input → CW output');
  assert.ok(isClockwise(orientRing(CW_SQUARE, true)), 'CW input stays CW');
  assert.ok(!isClockwise(orientRing(CCW_SQUARE, false)), 'CCW input stays CCW');
  assert.ok(!isClockwise(orientRing(CW_SQUARE, false)), 'CW input → CCW output');
});

test('orientRing does not mutate its input', () => {
  const original = CCW_SQUARE.map((p) => [...p]);
  orientRing(CCW_SQUARE, true);
  assert.deepEqual(CCW_SQUARE, original);
});

test('every merged exterior ring comes out clockwise', () => {
  // Mixed input windings are the realistic case — the service is not
  // consistent about it, and GeoJSON and Esri disagree by convention.
  const geom = polygonsToEsriGeometry([poly([CCW_SQUARE]), poly([CW_SQUARE]), poly([CCW_SQUARE])]);
  assert.equal(geom.rings.length, 3);
  for (const ring of geom.rings) {
    assert.ok(isClockwise(ring), 'a merged footprint must not become a hole');
  }
  assert.deepEqual(geom.spatialReference, { wkid: 4326 });
});

test('holes stay holes — counter-clockwise — through the merge', () => {
  const hole = [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4], [0.2, 0.2]];
  const geom = polygonsToEsriGeometry([poly([CCW_SQUARE, hole])]);
  assert.equal(geom.rings.length, 2);
  assert.ok(isClockwise(geom.rings[0]), 'exterior clockwise');
  assert.ok(!isClockwise(geom.rings[1]), 'interior counter-clockwise');
});

test('MultiPolygon footprints contribute every ring', () => {
  const far = [[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]];
  const multi = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPolygon', coordinates: [[CCW_SQUARE], [far]] },
  };
  const geom = polygonsToEsriGeometry([multi]);
  assert.equal(geom.rings.length, 2);
  for (const ring of geom.rings) assert.ok(isClockwise(ring));
});

test('degenerate and non-polygon inputs are skipped, not emitted', () => {
  const bad = [
    poly([[[0, 0], [1, 1], [0, 0]]]),                                  // < 4 coords
    { type: 'Feature', properties: {}, geometry: null },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
  ];
  assert.equal(polygonsToEsriGeometry(bad), null, 'nothing usable → null, not an empty ring list');
  // One good footprint among bad ones still produces a usable geometry.
  const mixed = polygonsToEsriGeometry([...bad, poly([CCW_SQUARE])]);
  assert.equal(mixed.rings.length, 1);
});

test('empty input yields null so the caller skips the request', () => {
  assert.equal(polygonsToEsriGeometry([]), null);
});

test('intersectSets ANDs the filters, and empty input is an empty Set', () => {
  const a = new Set([1, 2, 3, 4]);
  const b = new Set([3, 4, 5]);
  const c = new Set([4, 3]);
  assert.deepEqual([...intersectSets([a, b, c])].sort(), [3, 4]);
  // A single filter passes through untouched.
  assert.deepEqual([...intersectSets([a])].sort(), [1, 2, 3, 4]);
  // Disjoint filters mean no parcel qualifies — not "no filter".
  assert.equal(intersectSets([a, new Set([99])]).size, 0);
  assert.equal(intersectSets([]).size, 0);
});

const failed = results.filter((r) => r === 'fail').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
