// Validate the traffic-count station layers against the MapLibre style spec.
//
// WHY THIS IS A TEST AND NOT A CODE REVIEW. An invalid paint or filter
// expression does not fail loudly: map.js's setup wraps addLayer in a
// try/catch that treats any throw as "the style isn't ready yet" and retries
// forever, so the only symptom is a map that never finishes loading. A bad
// `line-width` did exactly that on 2026-08-12 and took a style-spec
// validator to find. This runs that validator in CI instead.
//
// The layer objects are read out of src/map.js rather than restated here, so
// the thing under test is the shipped source. Both are pure literals, which
// is what makes that safe to evaluate.
//
// Run: cd web && node test/stationLayers.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'map.js'), 'utf8');

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** The addLayer({...}) object literal declaring `id`, as source text. */
function grabLayer(id) {
  const at = src.indexOf(`id: '${id}',`);
  assert.ok(at >= 0, `layer ${id} not found in map.js`);
  const start = src.lastIndexOf('{', at);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${id}`);
}

const LAYER_IDS = ['traffic-circle', 'traffic-circle-town'];
const layers = LAYER_IDS.map((id) => eval(`(${grabLayer(id)})`));

// The two count-label layers: one along each flow segment, one under each
// town station dot. Validated together because they must agree on the
// zoom-gated text-field, and because a bad symbol expression fails exactly
// as silently as a bad circle one.
const LABEL_IDS = ['traffic-flow-label', 'traffic-town-label'];
const labelLayers = LABEL_IDS.map((id) => eval(`(${grabLayer(id)})`));

console.log('map.js — traffic station layers');

test('both station layers are declared', () => {
  assert.deepEqual(layers.map((l) => l.id).sort(), [...LAYER_IDS].sort());
});

test('the style spec accepts them', () => {
  const errors = validateStyleMin({
    version: 8,
    sources: {
      traffic: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers,
  });
  assert.deepEqual(errors.map((e) => e.message), [], 'style-spec validation errors');
});

test('their filters partition the source, so no station draws twice', () => {
  // One source feeds both layers. If the filters ever overlap, a station
  // renders as both a highway dot and a town dot stacked on each other; if
  // they ever leave a gap, a station silently disappears from the map.
  const town = layers.find((l) => l.id === 'traffic-circle-town');
  const hwy = layers.find((l) => l.id === 'traffic-circle');
  assert.deepEqual(town.filter, ['==', ['get', '_town'], 1]);
  assert.deepEqual(hwy.filter, ['!=', ['get', '_town'], 1]);
});

test('both start hidden and share the traffic source', () => {
  for (const l of layers) {
    assert.equal(l.source, 'traffic', `${l.id} source`);
    assert.equal(l.layout.visibility, 'none', `${l.id} starts hidden`);
  }
});

test('the two markers are visually distinguishable', () => {
  // The whole point of a second layer is that a town count cannot be
  // mistaken for the highway count beside it — they differ by 2-3x at the
  // same place. Swapped fill/stroke is what makes them tellable apart, and
  // index.html's legend swatches restate these exact colours.
  const town = layers.find((l) => l.id === 'traffic-circle-town').paint;
  const hwy = layers.find((l) => l.id === 'traffic-circle').paint;
  assert.notEqual(town['circle-color'], hwy['circle-color']);
  assert.equal(town['circle-color'], hwy['circle-stroke-color']);
  assert.equal(town['circle-stroke-color'], hwy['circle-color']);
});

console.log('\nmap.js — count label layers');

test('the style spec accepts both label layers', () => {
  const errors = validateStyleMin({
    version: 8,
    // A symbol layer with a text-field is only valid in a style that
    // declares glyphs; the real basemap style supplies them.
    glyphs: 'https://example.invalid/{fontstack}/{range}.pbf',
    sources: {
      traffic: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      'traffic-flow': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: labelLayers,
  });
  assert.deepEqual(errors.map((e) => e.message), [], 'style-spec validation errors');
});

test('both gate the year on zoom 11, and agree on how', () => {
  // "2,110 (2024)" is ~50% wider than "2,110", and with text-allow-overlap
  // false a wider label means fewer labels survive — so the year is spent
  // only where the reader is looking at one property. The two layers must
  // switch at the same zoom or the map contradicts itself mid-scroll.
  const expected = [
    'step', ['zoom'],
    ['coalesce', ['get', '_label'], ''],
    11, ['coalesce', ['get', '_labelYear'], ['get', '_label'], ''],
  ];
  for (const l of labelLayers) {
    assert.deepEqual(l.layout['text-field'], expected, `${l.id} text-field`);
  }
});

test('the town label is filtered to town stations and held back at low zoom', () => {
  // It shares the station source with both circle layers, so without the
  // filter every rural station would get a label restating its segment's.
  const town = labelLayers.find((l) => l.id === 'traffic-town-label');
  assert.deepEqual(town.filter, ['==', ['get', '_town'], 1]);
  assert.equal(town.minzoom, 9, '328 labels do not belong on a province-wide view');
  assert.equal(town.source, 'traffic');
});

test('both label layers start hidden', () => {
  for (const l of labelLayers) {
    assert.equal(l.layout.visibility, 'none', `${l.id} starts hidden`);
  }
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
