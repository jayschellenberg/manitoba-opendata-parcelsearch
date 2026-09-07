// Behavior tests for joinTopNByArea — the browser-side area-weighted
// spatial join that assigns each parcel its top-N overlay matches
// (mirrors mao-assembly's get_multiple_by_area). Runs offline on
// synthetic rectangles near Manitoba's latitude: rectangles spanning
// the SAME latitude band have geodesic area proportional to their
// longitude width, so expected coverage ratios are exact up to
// rounding (assertions use ±0.02).
//
// Run: cd web && node test/spatialJoin.test.js

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

const { joinTopNByArea, touchOverlapJoin } = await import('../src/arcgis.js');

// All rectangles share the latitude band [50, 50.01]; x positions are
// longitude offsets (degrees) east of -97. The test parcel spans
// x ∈ [0, 0.01], so an overlay covering x ∈ [0, 0.006] is 60% coverage.
const LAT0 = 50.0;
const LAT1 = 50.01;
const LON0 = -97.0;

function rect(x0, x1, properties) {
  return {
    type: 'Feature',
    properties,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [LON0 + x0, LAT0],
        [LON0 + x1, LAT0],
        [LON0 + x1, LAT1],
        [LON0 + x0, LAT1],
        [LON0 + x0, LAT0],
      ]],
    },
  };
}

function fc(...features) {
  return { type: 'FeatureCollection', features };
}

const parcel = rect(0, 0.01, { OBJECTID: 1 });
const ovA = rect(-0.002, 0.006, { OBJECTID: 101, ZONE: 'A' }); // covers 60%
const ovB = rect(0.0055, 0.02,  { OBJECTID: 102, ZONE: 'B' }); // covers 45%
const ovC = rect(0.0095, 0.02,  { OBJECTID: 103, ZONE: 'C' }); // covers  5%
const ovX = rect(0.05, 0.06,    { OBJECTID: 104, ZONE: 'X' }); // disjoint

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

function assertClose(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol,
    `${label}: expected ≈${expected} (±${tol}), got ${actual}`);
}

console.log('joinTopNByArea');

test('orders matches by coverage and keeps only the top N', () => {
  const join = joinTopNByArea(fc(parcel), fc(ovB, ovC, ovA), 2);
  const matches = join.get(1);
  assert.equal(matches.length, 2, 'n=2 keeps two matches');
  assert.equal(matches[0].feature.properties.ZONE, 'A', 'biggest coverage first');
  assert.equal(matches[1].feature.properties.ZONE, 'B');
  assertClose(matches[0].ratio, 0.60, 0.02, 'A coverage');
  assertClose(matches[1].ratio, 0.45, 0.02, 'B coverage');
});

test('n=3 surfaces the sliver match too', () => {
  const matches = joinTopNByArea(fc(parcel), fc(ovA, ovB, ovC), 3).get(1);
  assert.equal(matches.length, 3);
  assert.equal(matches[2].feature.properties.ZONE, 'C');
  assertClose(matches[2].ratio, 0.05, 0.02, 'C coverage');
});

test('a disjoint overlay produces no match', () => {
  const matches = joinTopNByArea(fc(parcel), fc(ovX), 2).get(1);
  assert.deepEqual(matches, []);
});

test('an overlay fully containing the parcel clamps to ratio ≈ 1', () => {
  const cover = rect(-0.001, 0.011, { OBJECTID: 105, ZONE: 'FULL' });
  const matches = joinTopNByArea(fc(parcel), fc(cover), 2).get(1);
  assert.equal(matches.length, 1);
  assert.ok(matches[0].ratio > 0.99 && matches[0].ratio <= 1,
    `expected ratio in (0.99, 1], got ${matches[0].ratio}`);
});

test('a parcel without OBJECTID is skipped', () => {
  const anon = rect(0, 0.01, {});
  const join = joinTopNByArea(fc(anon), fc(ovA), 2);
  assert.equal(join.size, 0);
});

test('each parcel keys its own matches by OBJECTID', () => {
  const east = rect(0.02, 0.03, { OBJECTID: 2 });
  const ovEast = rect(0.02, 0.025, { OBJECTID: 106, ZONE: 'E' }); // 50% of east
  const join = joinTopNByArea(fc(parcel, east), fc(ovA, ovEast), 2);
  assert.equal(join.get(1)[0].feature.properties.ZONE, 'A');
  assert.equal(join.get(2)[0].feature.properties.ZONE, 'E');
  assertClose(join.get(2)[0].ratio, 0.5, 0.02, 'east coverage');
});

test('empty inputs return an empty Map', () => {
  assert.equal(joinTopNByArea(fc(), fc(ovA), 2).size, 0);
  assert.equal(joinTopNByArea(fc(parcel), fc(), 2).size, 0);
});


// ---------------------------------------------------------------------------
// Stacked-blanket correction.
//
// Manitoba's zoning layer stacks a municipality-wide backdrop UNDER the
// specific zones instead of carving it out, so the backdrop can cover a
// parcel more completely than the zone that actually applies. Modelled here
// with a wide blanket and a specific zone that nearly co-covers the parcel,
// the way RA (117,638 ha) and MG sat over Woodlands roll 15650.

// The parcel spans x in [0, 0.01]. `blanket` runs far past it in both
// directions, so it covers 100%; `specific` covers ~99% and is ~1/700th the
// size, well past the 100x ratio the correction requires.
const blanket  = rect(-3.5, 3.5,     { OBJECTID: 201, ZONE: 'RA' });
const specific = rect(-0.0001, 0.0099, { OBJECTID: 202, ZONE: 'MG' });
// Only ~4x the specific zone: a mid-sized neighbour, not a municipal backdrop.
const midsized = rect(-0.019, 0.0099,  { OBJECTID: 203, ZONE: 'AL' });

console.log('joinTopNByArea - stacked blanket');

test('the specific zone outranks a municipal blanket that covers more', () => {
  const join = joinTopNByArea(fc(parcel), fc(blanket, specific), 2);
  const m = join.get(1);
  assert.equal(m[0].feature.properties.ZONE, 'MG',
    'the zone that actually applies must come first');
  assert.equal(m[1].feature.properties.ZONE, 'RA',
    'the blanket is demoted, not dropped');
  assert.ok(m[1].ratio >= m[0].ratio,
    'and it still reports the larger share - only the ORDER changed');
});

test('a merely-larger neighbour does NOT displace the top match', () => {
  // 4x is not a blanket. This is the case that keeps ordinary municipalities
  // (and any base-zone/overlay-district pair) behaving exactly as before.
  const join = joinTopNByArea(fc(parcel), fc(midsized, specific), 2);
  assert.equal(join.get(1)[0].feature.properties.ZONE, 'AL',
    'below the area ratio, plain coverage still wins');
});

test('a genuinely split parcel is untouched', () => {
  // ovA 60% / ovB 45%: shares differ by far more than the tie epsilon, so
  // no promotion can apply however the polygon sizes compare.
  const join = joinTopNByArea(fc(parcel), fc(ovA, ovB), 2);
  assert.equal(join.get(1)[0].feature.properties.ZONE, 'A');
});

test('a blanket alone is still reported', () => {
  const join = joinTopNByArea(fc(parcel), fc(blanket), 2);
  assert.equal(join.get(1)[0].feature.properties.ZONE, 'RA',
    'with nothing more specific to promote, the blanket is the answer');
});

// ---------------------------------------------------------------------------
// touchOverlapJoin - the Changes-column fallback.
//
// It used to test bounding boxes only, which put a neighbour's amendment on
// unamended parcels: two bboxes overlap while the polygons are hundreds of
// metres apart. Woodlands roll 15650 was reported as "RG to CG" from a
// polygon 112 m away.

console.log('touchOverlapJoin');

// Shares the parcel's latitude band but sits east of it - bboxes DO overlap
// in latitude, and this one is offset only in longitude, so it is the exact
// shape of the false positive: near, bbox-overlapping, not touching.
const nearMiss = rect(0.012, 0.02, { OBJECTID: 301, ZONE: 'CG',
  AMENDMENT_DESCRIPTION: 'RG to CG' });

test('a neighbour that does not touch the parcel is not a match', () => {
  const join = touchOverlapJoin(fc(parcel), fc(nearMiss), 3);
  assert.equal(join.size, 0,
    "a nearby amendment is not this parcel's amendment");
});

test('an edge-touching polygon still matches', () => {
  // Zero area of overlap - shares only the parcel's eastern edge. This is
  // the case the fallback exists for, and @turf/intersect drops it.
  const edge = rect(0.01, 0.02, { OBJECTID: 302, ZONE: 'CG' });
  const join = touchOverlapJoin(fc(parcel), fc(edge), 3);
  assert.equal(join.get(1)?.length, 1, 'edge contact is still contact');
});

test('a real overlap matches, and n caps the result', () => {
  const join = touchOverlapJoin(fc(parcel), fc(ovA, ovB, ovC), 2);
  assert.equal(join.get(1).length, 2);
});

test('a disjoint overlay never matches', () => {
  assert.equal(touchOverlapJoin(fc(parcel), fc(ovX), 3).size, 0);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
