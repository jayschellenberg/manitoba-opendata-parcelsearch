// A map push that lands LATE must push what is on the map now.
//
// WHY THIS EXISTS. Enrichment tails run for tens of seconds — zoning and
// dev-plan joins, the WALLAS fetch, the soil composition pass. That is plenty
// of time for the user to set a subject, type a radius or tick a filter. Any
// push that hands back the `parcelFc` captured when the work was SCHEDULED
// silently undoes that: the grid keeps the shortlist, the map goes back to
// every sale, and because these pushes use `fit: false` the camera never
// moves, so nothing on screen says the two stopped agreeing.
//
// It has now been found twice.
//
//   2026-09-13, Lac du Bonnet, ticking Exclude Nominal Sales: the map
//   correctly narrowed to 461 parcels at 6.2 s, then jumped back to 1,300 at
//   27.2 s while the status line still read "1046 of 1302 sales shown
//   (filtered)". Fixed in scheduleSoilCompositionStamp, whose comment records
//   the measurement.
//
//   2026-09-22, a 20 km radius around roll 141300: "I am seeing the shortlist
//   in the grid, but the other sales still show on the map even though
//   outside the radius." Same shape, in the two import tails the first fix
//   did not cover. Changing the km value repaired it, because that re-ran the
//   filter and pushed again — which is exactly what a stale late push looks
//   like from the outside.
//
// Nothing is lost by narrowing these pushes: a filtered view reuses the SAME
// parcel objects, so whatever the enrichment stamped is already on them.
//
// Source-text check, same idiom as searchReset/soilScope.
//
// Run: cd web && node test/latePushFilter.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');

/** Comments stripped — this file quotes the very code it asserts about. */
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

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('late map pushes — never the captured pre-filter set');

// Every setMapData call that cannot move the camera is, by definition, one
// that lands while the user is already looking at something. Those are the
// ones that must not carry a stale set.
const lateCalls = [...src.matchAll(/setMapData\(([\s\S]{0,220}?)\)\s*;/g)]
  .map((m) => m[1])
  .filter((args) => /fit:\s*false/.test(args));

test('there are late pushes to check', () => {
  assert.ok(lateCalls.length >= 3,
    `expected several fit:false pushes, found ${lateCalls.length} — the matcher probably broke`);
});

test('no late push hands back a bare captured parcelFc', () => {
  // `parcelFc` is the argument name every enrichment path captures. A late
  // push may still MENTION it as the fallback for "nothing rendered yet",
  // but it must not be the whole argument.
  const offenders = lateCalls.filter((args) => /^\s*parcelFc\s*,/.test(args));
  assert.deepEqual(offenders.map((a) => a.split('\n')[0].trim()), [],
    'a late push is handing back the set captured before the enrichment ran; '
    + 'derive it from currentRows (or lastResultFc) so a filter set in the '
    + 'meantime survives');
});

test('the late pushes derive from what is rendered', () => {
  // An explicit EMPTY_FC is a deliberate "show nothing" — a clear, not a
  // stale set — so it is exempt. Everything else that lands late has to name
  // the live view.
  const suspect = lateCalls
    .filter((args) => !/^\s*EMPTY_FC\s*,/.test(args))
    .filter((args) => !/currentRows|lastResultFc|visibleFc|livePushFc|viewFc/.test(args));
  assert.deepEqual(suspect.map((a) => a.replace(/\s+/g, ' ').trim().slice(0, 90)), [],
    'late push(es) referencing neither currentRows nor lastResultFc');
});

test('the soil stamp re-push still reads the live set, not its closure', () => {
  // The 2026-09-13 fix. Its repush deliberately prefers lastResultFc over the
  // captured parcelFc; that preference is the fix, so it is pinned.
  const m = /const defaultRepush[\s\S]*?\n  \};/.exec(src);
  assert.ok(m, 'defaultRepush not found in scheduleSoilCompositionStamp');
  assert.match(m[0], /lastResultFc\s*\?\.\s*features\s*\?\.\s*length\s*\?\s*lastResultFc/,
    'the re-push must prefer what is on the map now over its captured set');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
