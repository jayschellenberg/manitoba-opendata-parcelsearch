// Unit tests for src/lib/withheldGeometry.js — replacing the boundary of a
// parcel that changed after its sale with a pin, so the map never asserts an
// extent that isn't what sold.
//
// The behaviour worth pinning is what it leaves ALONE: a pasted comp set with
// no change signal, a parcel already redrawn to a real historical boundary,
// and the result collection itself (which the grid and export still read).
//
// Run: cd web && node test/withheldGeometry.test.js

import assert from 'node:assert/strict';
import { withholdChangedGeometry, withheldNote } from '../src/lib/withheldGeometry.js';
import { parcelCentrePoint } from '../src/lib/geometryText.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// A unit square from (0,0) to (2,2) — centroid (1,1).
const square = () => ({
  type: 'Polygon',
  coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
});

const feat = (props, geometry = square()) => ({ type: 'Feature', properties: props, geometry });
const fcOf = (...features) => ({ type: 'FeatureCollection', features });
const opts = { centroid: parcelCentrePoint };

console.log('withheldGeometry.js — withholdChangedGeometry');

test('a withheld parcel becomes a Point at its centroid', () => {
  const fc = fcOf(feat({ _geomTrust: 'withheld', Roll_No_Txt: '100.000' }));
  const r = withholdChangedGeometry(fc, opts);
  assert.equal(r.withheld, 1);
  assert.equal(r.fc.features[0].geometry.type, 'Point');
  assert.deepEqual(r.fc.features[0].geometry.coordinates, [1, 1]);
  assert.equal(r.fc.features[0].properties._geomWithheld, true);
});

test('confirmed and provisional keep their polygons', () => {
  const fc = fcOf(
    feat({ _geomTrust: 'confirmed' }),
    feat({ _geomTrust: 'provisional' }),
  );
  const r = withholdChangedGeometry(fc, opts);
  assert.equal(r.withheld, 0);
  for (const f of r.fc.features) assert.equal(f.geometry.type, 'Polygon');
});

test('an unknown trust keeps its polygon — a pasted comp set is not a claim', () => {
  // Turning every pasted comp into a pin would be a regression dressed as
  // caution: no evidence was offered about those rows either way.
  const fc = fcOf(feat({ _geomTrust: 'unknown' }), feat({}));
  const r = withholdChangedGeometry(fc, opts);
  assert.equal(r.withheld, 0);
  assert.equal(r.fc, fc, 'unchanged collection should come back by reference');
});

test('an as-of boundary outranks a pin and is left alone', () => {
  // applyHistoricalGeometry already swapped in a real extent for the snapshot
  // date, which is a better answer than "somewhere around here".
  const fc = fcOf(feat({ _geomTrust: 'withheld', _asOfGeom: true, _asOfDate: '2025-02-12' }));
  const r = withholdChangedGeometry(fc, opts);
  assert.equal(r.withheld, 0);
  assert.equal(r.fc.features[0].geometry.type, 'Polygon');
});

test('a withheld parcel with no usable geometry is counted, not dropped', () => {
  const fc = fcOf(feat({ _geomTrust: 'withheld' }, null));
  const r = withholdChangedGeometry(fc, opts);
  assert.equal(r.withheld, 0);
  assert.equal(r.unplaceable, 1);
  assert.equal(r.fc.features.length, 1);
});

test('the input collection is never mutated', () => {
  const original = feat({ _geomTrust: 'withheld' });
  const fc = fcOf(original);
  withholdChangedGeometry(fc, opts);
  assert.equal(original.geometry.type, 'Polygon');
  assert.equal(original.properties._geomWithheld, undefined);
});

test('untouched features pass through by reference', () => {
  const keep = feat({ _geomTrust: 'confirmed' });
  const drop = feat({ _geomTrust: 'withheld' });
  const r = withholdChangedGeometry(fcOf(keep, drop), opts);
  assert.equal(r.fc.features[0], keep);
  assert.notEqual(r.fc.features[1], drop);
});

test('a mixed set withholds only the changed parcels', () => {
  const r = withholdChangedGeometry(fcOf(
    feat({ _geomTrust: 'withheld' }),
    feat({ _geomTrust: 'confirmed' }),
    feat({ _geomTrust: 'withheld' }),
  ), opts);
  assert.equal(r.withheld, 2);
  assert.deepEqual(r.fc.features.map((f) => f.geometry.type),
    ['Point', 'Polygon', 'Point']);
});

test('an empty or centroid-less call is a no-op, not a throw', () => {
  assert.equal(withholdChangedGeometry(null, opts).withheld, 0);
  assert.equal(withholdChangedGeometry(fcOf(), opts).withheld, 0);
  assert.equal(withholdChangedGeometry(fcOf(feat({ _geomTrust: 'withheld' })), {}).withheld, 0);
});

console.log('\nwithheldGeometry.js — withheldNote');

test('says nothing when nothing was withheld', () => {
  assert.equal(withheldNote({ withheld: 0, unplaceable: 0 }), '');
  assert.equal(withheldNote(null), '');
});

test('singular and plural both read correctly', () => {
  assert.match(withheldNote({ withheld: 1 }), /1 parcel shown as a pin — it changed/);
  assert.match(withheldNote({ withheld: 3 }), /3 parcels shown as a pin — they changed/);
});

test('unplaceable parcels are reported separately', () => {
  const note = withheldNote({ withheld: 2, unplaceable: 1 });
  assert.match(note, /2 parcels shown as a pin/);
  assert.match(note, /1 changed parcel could not be placed/);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
