// Unit tests for lib/geometryText.js — the parcel centre point behind
// the grid's Lat/Lon columns, and the WKT serialiser behind the CSV
// export's geometry column.
//
// Run: cd web && node test/geometryText.test.js

import assert from 'node:assert/strict';
import {
  geometryBbox, parcelCentrePoint, parcelLat, parcelLon,
  geometryToWkt, featureToWkt,
} from '../src/lib/geometryText.js';

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

// A square degree-ish parcel, and an L-shape for the concave case.
const square = {
  type: 'Polygon',
  coordinates: [[[-96, 49], [-95, 49], [-95, 50], [-96, 50], [-96, 49]]],
};
const feat = (geometry) => ({ type: 'Feature', geometry, properties: {} });

console.log('geometryBbox / parcelCentrePoint');

test('bbox of a simple polygon', () => {
  assert.deepEqual(geometryBbox(square), [-96, 49, -95, 50]);
});

test('bbox walks MultiPolygon nesting', () => {
  const mp = {
    type: 'MultiPolygon',
    coordinates: [
      [[[-96, 49], [-95, 49], [-95, 50], [-96, 50], [-96, 49]]],
      [[[-94, 51], [-93, 51], [-93, 52], [-94, 52], [-94, 51]]],
    ],
  };
  assert.deepEqual(geometryBbox(mp), [-96, 49, -93, 52]);
});

test('centre is the bounding-box midpoint', () => {
  assert.deepEqual(parcelCentrePoint(feat(square)), { lng: -95.5, lat: 49.5 });
});

test('centre of an irregular polygon still comes from its bbox', () => {
  // Documents the accepted trade-off: this L-shape's midpoint lands in
  // the notch, outside the polygon. Chosen so the grid always agrees
  // with the popup's GPS Coordinates link and the distance calc.
  const ell = {
    type: 'Polygon',
    coordinates: [[[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 0]]],
  };
  assert.deepEqual(parcelCentrePoint(feat(ell)), { lng: 1, lat: 1 });
});

test('missing / empty geometry yields null, never a throw', () => {
  assert.equal(parcelCentrePoint(null), null);
  assert.equal(parcelCentrePoint({}), null);
  assert.equal(parcelCentrePoint(feat(null)), null);
  assert.equal(parcelCentrePoint(feat({ type: 'Polygon' })), null);
  assert.equal(parcelCentrePoint(feat({ type: 'Polygon', coordinates: [] })), null);
});

test('lat / lon render at six decimals', () => {
  assert.equal(parcelLat(feat(square)), '49.500000');
  assert.equal(parcelLon(feat(square)), '-95.500000');
});

test('lat / lon are blank without geometry, not "NaN"', () => {
  assert.equal(parcelLat(feat(null)), '');
  assert.equal(parcelLon(feat(null)), '');
});

test('lat and lon are not transposed', () => {
  // Manitoba: latitude ~49-60 positive, longitude ~-89 to -102 negative.
  const mb = { type: 'Polygon', coordinates: [[[-97.2, 49.8], [-97.1, 49.8], [-97.1, 49.9], [-97.2, 49.9], [-97.2, 49.8]]] };
  assert.ok(Number(parcelLat(feat(mb))) > 0, 'latitude should be positive in Manitoba');
  assert.ok(Number(parcelLon(feat(mb))) < 0, 'longitude should be negative in Manitoba');
});

console.log('\ngeometryToWkt');

test('polygon becomes POLYGON with lng before lat', () => {
  // WKT is X Y — longitude first, the opposite of how a human writes a
  // coordinate. Getting this backwards silently plots Manitoba in Somalia.
  assert.equal(
    geometryToWkt(square),
    'POLYGON ((-96 49, -95 49, -95 50, -96 50, -96 49))',
  );
});

test('polygon holes are preserved as extra rings', () => {
  const holed = {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
      [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
    ],
  };
  assert.equal(
    geometryToWkt(holed),
    'POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 2 1, 2 2, 1 2, 1 1))',
  );
});

test('multipolygon wraps each polygon in its own ring group', () => {
  const mp = {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      [[[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]],
    ],
  };
  assert.equal(
    geometryToWkt(mp),
    'MULTIPOLYGON (((0 0, 1 0, 1 1, 0 1, 0 0)), ((2 2, 3 2, 3 3, 2 3, 2 2)))',
  );
});

test('point and linestring are covered too', () => {
  assert.equal(geometryToWkt({ type: 'Point', coordinates: [-96.5, 49.5] }), 'POINT (-96.5 49.5)');
  assert.equal(
    geometryToWkt({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }),
    'LINESTRING (0 0, 1 1)',
  );
});

test('coordinates round to six decimals without trailing zeros', () => {
  const g = { type: 'Point', coordinates: [-96.1234567891, 49.5] };
  assert.equal(geometryToWkt(g), 'POINT (-96.123457 49.5)');
});

test('unknown / missing / malformed geometry yields an empty cell', () => {
  // A blank CSV cell is recoverable; a half-formed WKT string breaks the
  // whole file on import.
  assert.equal(geometryToWkt(null), '');
  assert.equal(geometryToWkt({}), '');
  assert.equal(geometryToWkt({ type: 'GeometryCollection', coordinates: [] }), '');
  assert.equal(geometryToWkt({ type: 'Polygon', coordinates: [] }), '');
  assert.equal(geometryToWkt({ type: 'Polygon', coordinates: [[]] }), '');
  assert.equal(geometryToWkt({ type: 'Polygon', coordinates: [[[0, 0], [1, null]]] }), '');
  assert.equal(geometryToWkt({ type: 'MultiPolygon', coordinates: [] }), '');
});

test('WKT contains no characters that would break a CSV cell unquoted', () => {
  // csvCell quotes on comma anyway; this guards against newlines, which
  // would split the row even inside quotes in some readers.
  const wkt = geometryToWkt(square);
  assert.ok(!/[\r\n"]/.test(wkt), 'no newlines or quotes in WKT output');
});

test('featureToWkt reads through the feature wrapper', () => {
  assert.equal(featureToWkt(feat(square)), geometryToWkt(square));
  assert.equal(featureToWkt(null), '');
  assert.equal(featureToWkt({}), '');
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
