// Unit tests for lib/parcelDimensions.js — side lengths in feet from the
// assessment polygon (the "Dimensions" map labels and the Sides grid column).
//
// Run: cd web && node test/parcelDimensions.test.js

import assert from 'node:assert/strict';
import {
  parcelDimensions, formatSides, formatFeet, dimensionLabelFeatures, labelledSides,
  formatSidesForGrid, GRID_MAX_SIDES,
} from '../src/lib/parcelDimensions.js';

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

// Build lon/lat rings from local offsets in FEET (x east, y north) around a
// Winnipeg-latitude origin. Uses the textbook WGS84 metres-per-degree series,
// independent of the module's own copy only in that it is written out here.
const LAT0 = 49.85, LON0 = -97.15;
const FT = 0.3048;
const p = (LAT0 * Math.PI) / 180;
const mLat = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
const mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
const ll = ([xFt, yFt]) => [LON0 + (xFt * FT) / mLon, LAT0 + (yFt * FT) / mLat];
const poly = (ptsFt) => {
  const ring = ptsFt.map(ll);
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const sideFt = (g) => parcelDimensions(g).parts[0].sides.map((s) => s.ft);

// A 66 ft wide x 120 ft deep lot, frontage on the north.
const LOT = [[0, 0], [66, 0], [66, 120], [0, 120]];

test('rectangle: four sides, clockwise from the north side', () => {
  const s = sideFt(poly(LOT));
  assert.equal(s.length, 4);
  [66, 120, 66, 120].forEach((v, i) => near(s[i], v, 0.05, `side ${i}`));
  assert.equal(formatSides(parcelDimensions(poly(LOT))), '66.0 / 120.0 / 66.0 / 120.0');
});

test('counter-clockwise input reads the same as clockwise', () => {
  const cw = formatSides(parcelDimensions(poly(LOT)));
  const ccw = formatSides(parcelDimensions(poly(LOT.slice().reverse())));
  assert.equal(ccw, cw);
});

test('perimeter is the sum of the sides', () => {
  near(parcelDimensions(poly(LOT)).perimeterFt, 372, 0.1);
});

test('digitizing noise along a straight side merges into one side', () => {
  // Two extra vertices on the east side, 2 and 3 inches off the line.
  const noisy = [[0, 0], [66, 0], [66.17, 40], [65.75, 80], [66, 120], [0, 120]];
  const s = sideFt(poly(noisy));
  assert.equal(s.length, 4, `got ${s.map((v) => v.toFixed(1)).join(' / ')}`);
  near(s[1], 120, 0.2, 'east side');
});

test('a 1 m wobble in the middle of a quarter-section line still merges', () => {
  const q = 2640;
  const wob = 1 / FT;   // 1 m in feet
  const s = sideFt(poly([[0, 0], [q, 0], [q + wob, q / 2], [q, q], [0, q]]));
  assert.equal(s.length, 4);
  assert.equal(formatFeet(s[0]), '2,640');
});

test('a single real bend in a lot line stays two sides', () => {
  // East line deflects 10° halfway down — a bent lot line, not a curve.
  const dx = 60 * Math.tan((10 * Math.PI) / 180);
  const s = sideFt(poly([[0, 0], [66, 0], [66 + dx, 60], [66, 120], [0, 120]]));
  assert.equal(s.length, 5);
  assert.ok(!parcelDimensions(poly([[0, 0], [66, 0], [66 + dx, 60], [66, 120], [0, 120]])).parts[0].sides.some((x) => x.arc));
});

test('a rounded corner is one arc side; the frontage beside it stays its own side', () => {
  // Corner lot 66 x 120 with a 15 ft radius rounding the north-east corner,
  // digitized as 8 chords.
  const r = 15, cx = 66 - r, cy = 120 - r, pts = [[0, 0], [66, 0]];
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * (Math.PI / 2);
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  pts.push([0, 120]);
  const dims = parcelDimensions(poly(pts));
  const sides = dims.parts[0].sides;
  assert.equal(sides.length, 5, formatSides(dims));
  const arcs = sides.filter((s) => s.arc);
  assert.equal(arcs.length, 1);
  // Eight chords of a quarter circle: 8 · 2r·sin(π/32) = 23.53 ft (true arc 23.56).
  near(arcs[0].ft, 16 * r * Math.sin(Math.PI / 32), 0.05, 'arc length');
  // North frontage: 66 - 15 = 51 ft, east side 120 - 15 = 105 ft.
  const plain = sides.filter((s) => !s.arc).map((s) => s.ft).sort((a, b) => a - b);
  near(plain[0], 51, 0.05, 'frontage');
  near(plain[1], 66, 0.05, 'south');
  near(plain[2], 105, 0.05, 'east');
  near(plain[3], 120, 0.05, 'west');
  assert.match(formatSides(dims), /\(arc\)/);
});

test('a round parcel is a single arc', () => {
  const r = 50, pts = [];
  for (let k = 0; k < 64; k++) {
    const a = (k / 64) * 2 * Math.PI;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  const sides = parcelDimensions(poly(pts)).parts[0].sides;
  assert.equal(sides.length, 1);
  assert.ok(sides[0].arc);
  near(sides[0].ft, 2 * Math.PI * r, 0.2);
});

test('a 0.6 ft jog is digitizing noise: absorbed, not a side of its own', () => {
  const dims = parcelDimensions(poly([[0, 0], [66, 0], [66, 60], [66.6, 60], [66.6, 120], [0, 120]]));
  assert.equal(labelledSides(dims.parts[0]).length, 4, formatSides(dims));
});

test('MultiPolygon parts are measured separately and joined with |', () => {
  const a = poly(LOT).coordinates;
  const b = poly([[200, 0], [250, 0], [250, 50], [200, 50]]).coordinates;
  const dims = parcelDimensions({ type: 'MultiPolygon', coordinates: [a, b] });
  assert.equal(dims.parts.length, 2);
  assert.equal(formatSides(dims), '66.0 / 120.0 / 66.0 / 120.0 | 50.0 / 50.0 / 50.0 / 50.0');
  near(dims.perimeterFt, 372 + 200, 0.2);
});

test('points and missing geometry measure as null / blank', () => {
  assert.equal(parcelDimensions({ type: 'Point', coordinates: [LON0, LAT0] }), null);
  assert.equal(parcelDimensions(null), null);
  assert.equal(formatSides(null), '');
});

test('distance agrees with the WGS84 ellipsoid', () => {
  // 0.01° of longitude at 50°N is 716.96 m on WGS84 (geodesic, GeographicLib).
  const g = { type: 'Polygon', coordinates: [[[-97, 50], [-96.99, 50], [-96.99, 50.001], [-97, 50.001], [-97, 50]]] };
  const s = sideFt(g);
  const ew = s.filter((v) => v > 1000);
  near(ew[0] * FT, 716.96, 0.3, 'east-west side (m)');
  // 0.001° of latitude at 50°N is 111.229 m.
  const ns = s.filter((v) => v < 1000);
  near(ns[0] * FT, 111.229, 0.05, 'north-south side (m)');
});

test('label features: one Point per side, at its middle, rotated along it', () => {
  const fs = dimensionLabelFeatures([{ type: 'Feature', properties: {}, geometry: poly(LOT) }, { geometry: null }]);
  assert.equal(fs.length, 4);
  assert.ok(fs.every((f) => f.geometry.type === 'Point'));
  assert.equal(fs[0].properties.label, '66.0 ft');
  // North side runs east-west: horizontal text. East side runs north-south: vertical.
  assert.equal(Math.abs(fs[0].properties.rot), 0);
  assert.equal(Math.abs(fs[1].properties.rot), 90);
  // The north side's label sits halfway along it.
  near(fs[0].geometry.coordinates[0], ll([33, 120])[0], 1e-7);
});

test('a line shared by two result parcels (or a parcel listed twice) is labelled once', () => {
  const a = { geometry: poly(LOT) };
  const b = { geometry: poly([[66, 0], [132, 0], [132, 120], [66, 120]]) };
  assert.equal(dimensionLabelFeatures([a, b]).length, 7);
  assert.equal(dimensionLabelFeatures([a, { geometry: poly(LOT) }]).length, 4);
});

test('label rotation never reads upside down', () => {
  const tilted = poly([[0, 0], [60, -30], [120, 90], [60, 120]]);
  for (const f of dimensionLabelFeatures([{ geometry: tilted }])) {
    assert.ok(f.properties.rot >= -90 && f.properties.rot <= 90, String(f.properties.rot));
  }
});

test('grid summarises a parcel with too many sides to read', () => {
  // A zig-zag rear line: 2 + 2·k corners, all well past the noise tolerance.
  const pts = [[0, 0], [400, 0]];
  for (let k = 0; k < 10; k++) pts.push([400 - 40 * k, 100 + (k % 2) * 30]);
  pts.push([0, 100]);
  const dims = parcelDimensions(poly(pts));
  assert.ok(labelledSides(dims.parts[0]).length > GRID_MAX_SIDES);
  assert.match(formatSidesForGrid(dims), /^Irregular — \d+ sides \(.* ft perimeter\)$/);
  assert.equal(formatSidesForGrid(parcelDimensions(poly(LOT))), '66.0 / 120.0 / 66.0 / 120.0');
});

test('results are cached per geometry object', () => {
  const g = poly(LOT);
  assert.equal(parcelDimensions(g), parcelDimensions(g));
});

const failed = results.filter((r) => r.status === 'fail').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
