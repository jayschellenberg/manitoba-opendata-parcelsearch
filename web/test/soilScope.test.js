// Which soil fetch each consumer is wired to, and why it matters.
//
// WHY THIS EXISTS. There are two soil suppliers and they are not
// interchangeable:
//
//   whole-municipality  fetchCliAgrForMuni / loadSoilSurveyFcForScope
//                       Every polygon in the RM. The map overlay needs it —
//                       it paints soil across the whole municipality.
//   parcel-scoped       fetchSoilSurveyForParcels, via soilFcForParcels
//                       Only the ground the result parcels sit on. The grid's
//                       CLI / Soil Type columns never needed more than this.
//
// Before 2026-09-22 the GRID used the municipal fetch: filling four columns
// for a few hundred comps pulled every soil polygon in each represented
// municipality (RM of Ritchot: 805 polygons, 203,558 vertices, 8.2 MB), and a
// multi-municipality sales analysis did it once per muni.
//
// The failure mode this guards is a quiet re-wiring — someone reaching for
// the muni fetch in a column path because it is the one they found first.
// Nothing would look broken: the columns fill either way. The only visible
// symptom is the page getting heavy again, which is what took a week to
// diagnose the first time.
//
// The mirror-image mistake is just as quiet: letting the parcel-scoped set
// become `lastCliFc`. That variable is the OVERLAY's cache. A parcel-shaped
// subset sitting in it paints soil in patches around the comps the next time
// the overlay is switched on, with nothing on screen to say why.
//
// This is a source-text check. It proves what calls what, not what runs.
//
// Run: cd web && node test/soilScope.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');

/**
 * Source with comments removed — load-bearing, not tidiness. Every claim
 * below is about a CALL, and this file's own prose names all of these
 * functions. Reading the raw text would let the documentation satisfy the
 * assertions that are supposed to be checking the code.
 */
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
const arcgis = stripComments(read('arcgis.js'));

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/**
 * A top-level function's source, or null. They close with `}` at column 0.
 * `export` is part of the pattern because arcgis.js's half of this contract
 * is exported and main.js's half is not — matching only the bare form
 * returned null for the exported one, and every assertion against it then
 * passed against nothing.
 */
function fnBody(src, name) {
  const m = new RegExp(`^(export )?(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) return null;
  const end = src.indexOf('\n}', m.index);
  return end < 0 ? null : src.slice(m.index, end + 2);
}
const calls = (body, fn) => new RegExp(`\\b${fn}\\s*\\(`).test(body);

console.log('soil scope — the grid and the overlay do not share a fetch');

// Guard the guard: if any of these is renamed, the assertions below would
// silently pass against `null` bodies while checking nothing at all.
const BODIES = {
  ensureAgriculturalGridData: fnBody(main, 'ensureAgriculturalGridData'),
  enrichImportedSoilComposition: fnBody(main, 'enrichImportedSoilComposition'),
  soilFcForParcels: fnBody(main, 'soilFcForParcels'),
  toggleCliOverlay: fnBody(main, 'toggleCliOverlay'),
  loadSoilSurveyFcForScope: fnBody(main, 'loadSoilSurveyFcForScope'),
  fetchSoilSurveyForParcels: fnBody(arcgis, 'fetchSoilSurveyForParcels'),
};

test('every function under test still exists', () => {
  const missing = Object.entries(BODIES).filter(([, v]) => !v).map(([k]) => k);
  assert.deepEqual(missing, [], `renamed or removed: ${missing.join(', ')}`);
});

test('the Agricultural column preset takes the parcel-scoped path', () => {
  const body = BODIES.ensureAgriculturalGridData;
  assert.ok(calls(body, 'soilFcForParcels'),
    'the preset must ask for soil by parcel, not by municipality');
  assert.ok(!calls(body, 'loadSoilSurveyFcForScope'),
    'the preset pulled every polygon in the municipality to fill four columns');
});

test('a sales / property-list import takes the parcel-scoped path', () => {
  const body = BODIES.enrichImportedSoilComposition;
  assert.ok(calls(body, 'soilFcForParcels'),
    'an import must ask for soil by parcel');
  assert.ok(!calls(body, 'fetchCliAgrForMuni'),
    'an import fanned one whole-municipality fetch out per represented muni');
});

test('the map overlay still loads whole municipalities', () => {
  // The other half of the split, and the reason it is a split rather than a
  // replacement: the overlay paints across the RM, so patches around the
  // comps would be wrong for it.
  assert.ok(calls(BODIES.toggleCliOverlay, 'loadSoilSurveyFcForScope'),
    'the overlay must keep its municipal fetch or it paints in patches');
  assert.ok(calls(BODIES.loadSoilSurveyFcForScope, 'fetchCliAgrForMuni'),
    'the municipal path must still reach the municipal fetch');
});

test('the parcel-scoped set never becomes the overlay cache', () => {
  const body = BODIES.soilFcForParcels;
  for (const v of ['lastCliFc', 'cliLoadedFor', 'cliPushedFor']) {
    assert.ok(!new RegExp(`(^|[^.\\w])${v}\\s*=[^=]`).test(body),
      `soilFcForParcels assigns ${v} — a parcel-shaped subset must not stand in `
      + 'for the overlay\'s municipal cache');
  }
  // Reading lastCliFc is the point: when the overlay HAS loaded the munis,
  // that superset is free and the scoped fetch should be skipped entirely.
  assert.match(body, /lastCliFc/,
    'soilFcForParcels should reuse the overlay FC when it is already loaded');
});

test('the scoped fetch is two-phase: IDs under the spatial filter, then features', () => {
  const body = BODIES.fetchSoilSurveyForParcels;
  assert.match(body, /returnIdsOnly/,
    'the spatial filter must run ID-only so no geometry crosses the wire twice');
  assert.match(body, /objectIds/,
    'features must come back by OBJECTID, with no geometry filter attached');
});

test('a failed batch is reported, not silently dropped', () => {
  // An empty ID list is a real answer (unsurveyed ground), so it cannot also
  // mean "the request failed" — that is the silent blank the sales export
  // completeness guard exists to catch.
  assert.match(BODIES.fetchSoilSurveyForParcels, /_failedBatches/,
    'the scoped fetch must report how many parcel groups it could not query');
  assert.match(BODIES.enrichImportedSoilComposition, /_failedBatches/,
    'the import must treat a partial soil set as incomplete, or it exports blanks');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
