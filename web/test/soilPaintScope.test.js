// What the soil overlay paints, and where the municipality scope still bites.
//
// HISTORY, because this file has changed meaning once and the old meaning is
// still the obvious one to reach for.
//
// Until 2026-09-22 the overlay FETCHED soil per municipality and painted what
// it fetched, scoped from csvMatchedMunis — fixed at IMPORT time and narrowed
// by nothing afterwards. One stray far-flung sale therefore loaded and
// painted an entire RM, and kept painting it after that sale had been
// filtered off the screen. On "Macdonald and adjacent" that was six RMs:
// 4,693 polygons, ~1.58M vertices. Narrowing the scope to the visible rows
// fixed it, and this file existed to pin that narrowing.
//
// The overlay now renders from the province-wide PMTiles archive
// (rebuild-soil-tiles.ps1), which makes that whole class of bug impossible:
// there is no per-municipality payload to over-fetch, and coverage is the
// province whatever the result set is. So the narrowing is no longer what
// protects against over-painting — the tiles are.
//
// What the municipality scope still decides is the Soil Type PALETTE. The
// top-20 ranking is per municipality (r/build_soil_palette.R), so
// soilPaintMunis() picks whose ranking colours the map and titles the legend.
// Get that wrong and the legend says "top 20 in selected municipality" over
// somebody else's soils.
//
// Run: cd web && node test/soilPaintScope.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');

function stripComments(text) {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlocks.split('\n').map((line) => {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '/' && line[i + 1] === '/' && line[i - 1] !== ':') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}
const main = stripComments(read('main.js'));
const map = stripComments(read('map.js'));

function fnBody(src, name) {
  const m = new RegExp(`^(export )?(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) return null;
  const end = src.indexOf('\n}', m.index);
  return end < 0 ? null : src.slice(m.index, end + 2);
}

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('soil paint scope — tiles paint, the scope picks the palette');

const BODIES = {
  soilPaintMunis: fnBody(main, 'soilPaintMunis'),
  toggleCliOverlay: fnBody(main, 'toggleCliOverlay'),
  applyTiledIdentityPalette: fnBody(main, 'applyTiledIdentityPalette'),
};

test('every function under test still exists', () => {
  const missing = Object.entries(BODIES).filter(([, v]) => !v).map(([k]) => k);
  assert.deepEqual(missing, [], `renamed or removed: ${missing.join(', ')}`);
});

test('the soil layers render from the tile archive, not a GeoJSON source', () => {
  // The thing that makes over-painting impossible. A layer pointed back at a
  // per-municipality GeoJSON source reintroduces the entire 2026-09-22 bug:
  // a fetch per muni, a scope to get wrong, and megabytes of polygons for
  // ground nobody asked about.
  const fill = /id: 'cli-agr-fill',[\s\S]{0,200}?source: '([^']+)'/.exec(map);
  const label = /id: 'cli-agr-label',[\s\S]{0,200}?source: '([^']+)'/.exec(map);
  assert.ok(fill && label, 'soil fill/label layers not found');
  assert.equal(fill[1], 'soil-tiles', 'the soil fill must read the tile archive');
  assert.equal(label[1], 'soil-tiles', 'the soil labels must read the tile archive');
  assert.match(map, /addSource\('soil-tiles',\s*\{\s*type: 'vector'/,
    'soil-tiles must be a vector (tile) source');
});

test('turning the overlay on fetches no polygons', () => {
  const body = BODIES.toggleCliOverlay;
  assert.ok(!/loadSoilSurveyFcForScope/.test(body),
    'the overlay must not fetch soil per municipality any more — that is what tiles removed');
  // It should still refuse to claim it is on when the archive is unreachable.
  assert.match(body, /probeSoilTiles/,
    'a tiled layer that cannot reach its archive renders nothing; probe and say so');
});

test('the municipality scope drives the palette', () => {
  assert.match(BODIES.toggleCliOverlay, /soilPaintMunis\s*\(/,
    'the scope still decides whose ranking colours the map');
  assert.match(BODIES.applyTiledIdentityPalette, /fetchSoilPalette/,
    'identity mode must read the precomputed per-municipality ranking');
});

test('soilPaintMunis reads the visible rows, and is stable', () => {
  const body = BODIES.soilPaintMunis;
  assert.match(body, /currentRows/, 'the scope comes from the rows on screen');
  assert.match(body, /Muni_Name_With_Typ/, 'municipality comes off each visible parcel');
  assert.match(body, /scopedOverlayMunis\s*\(/,
    'with no rows yet there is nothing else to scope to');
  // loadKey and the composition cache key are both built from this, so an
  // unsorted result would churn them on every re-render.
  assert.match(body, /\.sort\s*\(/, 'soilPaintMunis must return a stable order');
});

test('identity mode still swaps the labels to the map-unit symbol', () => {
  // Painted by soil association and labelled by capability class reads as a
  // bug. The GeoJSON path did this swap; the tiled path has to as well.
  assert.match(BODIES.applyTiledIdentityPalette, /CLI_IDENTITY_LABEL_FIELD/,
    'identity mode must set the map-unit label field');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
