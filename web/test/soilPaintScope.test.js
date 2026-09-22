// The soil overlay paints what is on screen, not what was imported.
//
// WHY THIS EXISTS. Jason, 2026-09-22: "the soils layer still is painting a lot
// more than the main munis (but maybe this is due to far-flung sales when i
// select Macdonald and adjacent farm land from 2023 to present)". He was
// right about the cause and it was broader than far-flung.
//
// scopedOverlayMunis() returns csvMatchedMunis, which is fixed at IMPORT time
// from every municipality that had a matched parcel and is narrowed by
// nothing afterwards — not the far-flung exclude, not the date range, not any
// filter. One stray sale in a distant RM therefore made the overlay load and
// paint that entire RM, and keep painting it after the sale had been filtered
// off the screen. On "Macdonald and adjacent" that was six RMs before any
// far-flung comps: 4,693 soil polygons, ~1.58M vertices.
//
// soilPaintMunis() is the fix, and it is easy to undo by accident — reaching
// for scopedOverlayMunis() in the CLI overlay is the obvious thing to type,
// every other overlay does it, and nothing about the result looks wrong. It
// is just slow again, which is how this took three rounds to find.
//
// Source-text check: it proves which scope each caller asks for.
//
// Run: cd web && node test/soilPaintScope.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');

/** Comments stripped — this file names every function it asserts about, so
 *  reading the raw text would let the prose satisfy the assertions. */
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
const src = stripComments(raw);

function fnBody(name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) return null;
  const end = src.indexOf('\n}', m.index);
  return end < 0 ? null : src.slice(m.index, end + 2);
}

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('soil paint scope — the overlay follows the visible rows');

const BODIES = {
  soilPaintMunis: fnBody('soilPaintMunis'),
  toggleCliOverlay: fnBody('toggleCliOverlay'),
  scopedOverlayMunis: fnBody('scopedOverlayMunis'),
  extendSoilScopeToViewport: fnBody('extendSoilScopeToViewport'),
};

test('every function under test still exists', () => {
  const missing = Object.entries(BODIES).filter(([, v]) => !v).map(([k]) => k);
  assert.deepEqual(missing, [], `renamed or removed: ${missing.join(', ')}`);
});

test('soilPaintMunis reads the visible rows', () => {
  assert.match(BODIES.soilPaintMunis, /currentRows/,
    'the scope must come from the rows on screen');
  assert.match(BODIES.soilPaintMunis, /Muni_Name_With_Typ/,
    'municipality comes off each visible parcel');
});

test('soilPaintMunis falls back to the import scope when there are no rows', () => {
  // Turning the overlay on before a search still has to paint the picked
  // municipality; an empty scope would silently disable it.
  assert.match(BODIES.soilPaintMunis, /scopedOverlayMunis\s*\(/,
    'with no rows yet there is nothing else to scope to');
});

test('the CLI overlay asks for the soil scope, not the import scope', () => {
  const body = BODIES.toggleCliOverlay;
  assert.match(body, /soilPaintMunis\s*\(/,
    'toggleCliOverlay must scope to the visible rows');
  assert.ok(!/scopedOverlayMunis\s*\(/.test(body),
    'toggleCliOverlay using scopedOverlayMunis is the regression: it paints every '
    + 'municipality the import touched, including ones filtered off the screen');
});

test('panning extends the scope rather than reloading everything', () => {
  const body = BODIES.extendSoilScopeToViewport;
  assert.match(body, /cliMode\s*==\s*null/,
    'must do nothing while the overlay is off');
  assert.match(body, /municipalityAt/,
    'resolves the municipality under the map centre');
  assert.match(body, /soilPannedMunis/,
    'the panned-into municipality joins the scope');
  // A municipality already painted must not trigger a reload on every pan.
  assert.match(body, /includes\s*\(/,
    'an already-scoped municipality has to be a no-op');
});

test('the scope is sorted, so the cache key is stable', () => {
  // loadSoilSurveyFcForScope keys its cache on munis.join("|"). An unsorted
  // scope would produce a different key every time the grid re-ordered, and
  // refetch the same municipalities under a new name.
  assert.match(BODIES.soilPaintMunis, /\.sort\s*\(/,
    'soilPaintMunis must return a stable order');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
