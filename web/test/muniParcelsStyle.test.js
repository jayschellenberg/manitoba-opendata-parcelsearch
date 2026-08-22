// Unit tests for lib/muniParcelsStyle.js — the Assessment Parcels
// boundary lines re-calibrating per basemap: light + thin over the
// light rasters (Streets / Transportation / Elevation), dark + thick
// over aerial imagery (Esri satellite, Wayback, MLI ortho).
//
// Run: cd web && node test/muniParcelsStyle.test.js

import assert from 'node:assert/strict';
import {
  MUNI_PARCELS_LINE_STYLES,
  MUNI_PARCELS_FILL_STYLES,
  applyMuniParcelsBasemapStyle,
} from '../src/lib/muniParcelsStyle.js';

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

/** Minimal stub of the MapLibre surface the helper touches. `layers`
 *  maps id → visibility; paint set-calls are recorded per property. */
function stubMap(layers) {
  const paint = {};
  return {
    paint,
    getLayer: (id) => (id in layers ? { id } : undefined),
    getLayoutProperty: (id, prop) => (prop === 'visibility' ? layers[id] : undefined),
    setPaintProperty: (id, prop, value) => { paint[`${id}/${prop}`] = value; },
  };
}

function paintOf(map) {
  return {
    color: map.paint['muni-parcels-line/line-color'],
    width: map.paint['muni-parcels-line/line-width'],
    opacity: map.paint['muni-parcels-line/line-opacity'],
  };
}

console.log('applyMuniParcelsBasemapStyle');

test('streets gets the light preset, lines and fill both', () => {
  const m = stubMap({
    'muni-parcels-line': 'none',
    'muni-parcels-fill': 'none',
    'carto-voyager': 'visible',
    'esri-imagery': 'none',
    'wayback-imagery': 'none',
  });
  applyMuniParcelsBasemapStyle(m);
  assert.deepEqual(paintOf(m), {
    color: MUNI_PARCELS_LINE_STYLES.light['line-color'],
    width: MUNI_PARCELS_LINE_STYLES.light['line-width'],
    opacity: MUNI_PARCELS_LINE_STYLES.light['line-opacity'],
  });
  assert.equal(m.paint['muni-parcels-fill/fill-opacity'],
    MUNI_PARCELS_FILL_STYLES.light['fill-opacity']);
});

test('each aerial raster triggers the imagery preset, lines and fill both', () => {
  for (const aerial of ['esri-imagery', 'wayback-imagery', 'ortho-mb']) {
    const m = stubMap({
      'muni-parcels-line': 'none',
      'muni-parcels-fill': 'none',
      'carto-voyager': 'none',
      'esri-imagery': 'none',
      'wayback-imagery': 'none',
      'ortho-mb': 'none',
      [aerial]: 'visible',
    });
    applyMuniParcelsBasemapStyle(m);
    assert.equal(paintOf(m).color, MUNI_PARCELS_LINE_STYLES.imagery['line-color'], aerial);
    assert.equal(paintOf(m).width, MUNI_PARCELS_LINE_STYLES.imagery['line-width'], aerial);
    assert.equal(m.paint['muni-parcels-fill/fill-opacity'],
      MUNI_PARCELS_FILL_STYLES.imagery['fill-opacity'], aerial);
  }
});

test('the light rasters (transportation / elevation) stay on the light preset', () => {
  const m = stubMap({
    'muni-parcels-line': 'none',
    'carto-voyager': 'none',
    'esri-imagery': 'none',
    'wayback-imagery': 'none',
    'nrcan-transportation-geometry': 'visible',
    'nrcan-elevation': 'none',
  });
  applyMuniParcelsBasemapStyle(m);
  assert.equal(paintOf(m).color, MUNI_PARCELS_LINE_STYLES.light['line-color']);
});

test('optional layers that were never added (no MLI configured) do not throw', () => {
  const m = stubMap({
    'muni-parcels-line': 'none',
    'carto-voyager': 'visible',
    // no esri/wayback/ortho keys at all
  });
  applyMuniParcelsBasemapStyle(m);
  assert.equal(paintOf(m).color, MUNI_PARCELS_LINE_STYLES.light['line-color']);
});

test('a map without the fabric layers is a no-op (snapshot-export map)', () => {
  const m = stubMap({ 'esri-imagery': 'visible' });
  applyMuniParcelsBasemapStyle(m);
  assert.deepEqual(m.paint, {});
});

test('imagery lines are white, thicker and more opaque; streets fill is more transparent', () => {
  const light = MUNI_PARCELS_LINE_STYLES.light;
  const img = MUNI_PARCELS_LINE_STYLES.imagery;
  // White on imagery — the classic cadastre-on-aerial treatment; a
  // dark slate tried first washed into the fields (Jason, 2026-08-22).
  assert.equal(img['line-color'], '#ffffff');
  assert.ok(img['line-width'] > light['line-width']);
  assert.ok(img['line-opacity'] > light['line-opacity']);
  assert.ok(MUNI_PARCELS_FILL_STYLES.light['fill-opacity']
    < MUNI_PARCELS_FILL_STYLES.imagery['fill-opacity']);
});

const fails = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length > 0) process.exit(1);
