// The yellow selection highlight standing down under a themed overlay.
//
// WHAT WENT WRONG (Jason, 2026-09-15). Each multi-family overlay puts the
// rolls it paints into the results, and a result parcel wears the selection
// kit: 40% #ffea00 fill plus a dashed black/yellow border. Under the DARK end
// of a ramp that is invisible; under the PALE end it is the colour you see. A
// 2016-17 parcel (#fee5d9 at 70%) over that yellow renders apricot, so next to
// a 2024-25 parcel rendering true dark red the same layer looked like two
// different things — one a layer member, one "just a search result". Older
// parcels, every time.
//
// AND THEN IT WENT WRONG A SECOND WAY, which is the more interesting half and
// the reason for the source checks below. The first fix set the paint property
// once, when the overlay turned on. Two other things rewrite that same
// property on every table render — the zone-colouring switch and the water
// overlay — so the rule was wiped by the next render and the bug came back
// looking identical. Nothing may write those opacities except the one applier
// that folds both concerns together.
//
// Run: cd web && node test/overlayHighlight.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OVERLAY_HIGHLIGHT_PROPS,
  OVERLAY_DU_PROPS,
  ownedByOverlay,
  yieldToOverlay,
  duLabelProps,
  duLabelFilter,
  duLabelTextField,
} from '../src/lib/overlayHighlight.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** Comments stripped — a test that matches its own documentation proves
 *  nothing. Same helper as rowSelection.test.js. */
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

const mapJs = stripComments(fs.readFileSync(path.join(root, 'src', 'map.js'), 'utf8'));
const main = stripComments(fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8'));

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

console.log('the selection highlight yields to a themed overlay');

// --- the expression builders ------------------------------------------------

test('no overlay painting means nothing changes', () => {
  assert.equal(ownedByOverlay([]), false);
  assert.equal(ownedByOverlay(null), false);
  assert.equal(ownedByOverlay(['nonsense']), false, 'an unknown key owns nothing');
  // and the wrapper hands the base straight back, so the selection is
  // untouched on an ordinary search.
  assert.equal(yieldToOverlay(0.75, []), 0.75);
  const base = ['case', ['boolean', ['feature-state', 'starred'], false], 0.6, 0.3];
  assert.equal(yieldToOverlay(base, []), base, 'the same object, not a copy');
});

test('one overlay, one has-check', () => {
  assert.deepEqual(ownedByOverlay(['mfnb']), ['has', '_mfnbColor']);
  assert.deepEqual(ownedByOverlay(['mfinv']), ['has', '_mfInvColor']);
  assert.deepEqual(ownedByOverlay(['condo']), ['has', '_condoColor']);
});

test('several overlays, any of them', () => {
  assert.deepEqual(ownedByOverlay(['mfinv', 'mfnb']),
    ['any', ['has', '_mfInvColor'], ['has', '_mfnbColor']]);
  assert.deepEqual(ownedByOverlay(['mfnb', 'mfnb']), ['has', '_mfnbColor'],
    'a repeated key is still one check');
  assert.equal(ownedByOverlay(['mfnb', 'bogus']).length, 2,
    'an unknown key alongside a real one drops out rather than poisoning it');
});

test('the stamps named here are the ones the overlays actually write', () => {
  // A rename on one side and not the other would leave the highlight yielding
  // to nothing — the original bug, silently back.
  for (const prop of Object.values(OVERLAY_HIGHLIGHT_PROPS)) {
    assert.ok(main.includes(`${prop} = `),
      `${prop} is never assigned in main.js — the overlay stamp was renamed`);
  }
});

test('a starred parcel keeps its marker under every overlay', () => {
  // A favourite's dark red is the user's own annotation, not a by-product of
  // what is switched on.
  const expr = yieldToOverlay(0.75, ['mfnb']);
  assert.equal(expr[0], 'case');
  assert.deepEqual(expr[1], ['boolean', ['feature-state', 'starred'], false]);
  assert.equal(expr[2], 0.75, 'starred → the selection value, unchanged');
  assert.deepEqual(expr[3], ['has', '_mfnbColor']);
  assert.equal(expr[4], 0, 'painted by the overlay → silenced');
  assert.equal(expr[5], 0.75, 'everything else → the selection value');
});

// --- the wiring, which is where this broke the first time --------------------

test('ONE applier writes the selection opacities', () => {
  const applier = fnBody(mapJs, 'applySelectionOpacity');
  assert.ok(applier, 'applySelectionOpacity() is gone from map.js');
  assert.match(applier, /yieldToOverlay\(base, activeOverlays\)/,
    'it must fold the overlay owners into whatever base the selection wants');
  for (const id of ['parcel-fill', 'parcel-line', 'parcel-line-underlay']) {
    assert.ok(applier.includes(`'${id}'`), `${id} is not in the applier's kit`);
  }

  // The regression guard: any OTHER setPaintProperty on these opacities is a
  // writer that will wipe the overlay's stand-down on the next render.
  const strays = [...mapJs.matchAll(
    /setPaintProperty\(\s*'(parcel-fill|parcel-line|parcel-line-underlay)'\s*,\s*'(fill|line)-opacity'/g,
  )];
  const inApplier = [...applier.matchAll(/setPaintProperty\(/g)].length;
  assert.equal(strays.length, inApplier > 0 ? strays.length : 0);
  assert.ok(strays.every((m) => applier.includes(m[0])),
    'something outside applySelectionOpacity writes a selection opacity — '
    + 'that is exactly how this shipped broken the first time, wiped by the '
    + 'next table render');
});

test('the other two writers set the base instead of the property', () => {
  for (const fn of ['setParcelZoneColoring', 'setWaterInfluenceVisible']) {
    const body = fnBody(mapJs, fn);
    if (!body) continue;               // renamed is fine; wiped is not
    if (!body.includes('parcelFillBase')) continue;
    assert.match(body, /parcelFillBase = /,
      `${fn} must set the base, not the paint property`);
    assert.match(body, /applySelectionOpacity\(map\)/,
      `${fn} must re-apply through the applier`);
  }
  assert.match(fnBody(mapJs, 'setParcelZoneColoring'), /parcelFillBase = /,
    'the zone-colouring switch is the writer that wiped the fix last time');
});

test('the active overlays are re-asked on every transition', () => {
  const setter = fnBody(mapJs, 'setActiveOverlays');
  assert.ok(setter, 'setActiveOverlays() is gone from map.js');
  assert.match(setter, /activeOverlays = /);
  assert.match(setter, /applySelectionOpacity\(map\)/);
  assert.match(setter, /applyDuLabels\(map\)/,
    'the unit-count labels follow the same list, or they outlive their layer');

  const sync = fnBody(main, 'syncActiveOverlays');
  assert.ok(sync, 'syncActiveOverlays() is gone from main.js');
  for (const [key, flag] of [['mfinv', 'mfInvOverlayOn'], ['mfnb', 'mfnbOverlayOn'],
                             ['condo', 'condoOverlayOn']]) {
    assert.ok(sync.includes(flag) && sync.includes(`'${key}'`),
      `${key} is missing from syncOverlayHighlight — its parcels keep the yellow`);
  }
  // Six transitions: three overlays, on and off.
  const calls = [...main.matchAll(/syncActiveOverlays\(\)/g)].length;
  assert.ok(calls >= 6,
    `expected the six on/off transitions to re-ask; found ${calls}`);
});

test('silenced, not hidden', () => {
  // parcel-fill is the hit-test layer for the result-parcel popup. Dropping it
  // to visibility:none would take the click with it; opacity 0 still answers.
  const applier = fnBody(mapJs, 'applySelectionOpacity');
  assert.ok(!/visibility/.test(applier),
    'the selection must be silenced by opacity, never by visibility — a '
    + "hidden layer stops hit-testing and the parcel's popup goes with it");
});

// --- the unit-count labels belong to the overlays that are ON ---------------

test('no overlay painting means no unit-count labels', () => {
  assert.deepEqual(duLabelProps([]), []);
  assert.equal(duLabelTextField([]), '', 'an empty field is how the layer goes dark');
  // A filter that matches nothing, not one that matches everything.
  const f = duLabelFilter([]);
  assert.deepEqual(f, ['==', ['literal', 1], 0]);
});

test('each overlay labels from its OWN stamp', () => {
  assert.deepEqual(duLabelProps(['mfnb']), ['_mfnbDu']);
  assert.deepEqual(duLabelFilter(['mfnb']), ['has', '_mfnbDu']);
  assert.deepEqual(duLabelTextField(['mfnb']), ['to-string', ['get', '_mfnbDu']]);
  assert.deepEqual(duLabelProps(['mfinv']), ['_mfInvDu']);
  assert.deepEqual(duLabelFilter(['mfinv']), ['has', '_mfInvDu']);
});

test('THE GHOST LABELS: a stamp whose overlay is off labels nothing', () => {
  // `_mfInvDu` outlives the inventory overlay on purpose — a re-toggle is a
  // repaint, not a refetch. Before this, the label layer asked only "has a DU
  // stamp", so with the inventory switched OFF and New Multi-Family on,
  // Niverville drew 10 painted parcels and 13 bare numbers floating over
  // parcels with no fill at all (Jason, 2026-09-15). Stale ones, too: nothing
  // re-stamps a roll while its overlay is off, so a raised "DU >=" left them
  // reading their old value.
  const only = duLabelFilter(['mfnb']);
  assert.ok(JSON.stringify(only).indexOf('_mfInvDu') < 0,
    'with only New Multi-Family on, the inventory stamp must not be matched');
  const both = duLabelFilter(['mfinv', 'mfnb']);
  assert.deepEqual(both, ['any', ['has', '_mfInvDu'], ['has', '_mfnbDu']]);
  assert.deepEqual(duLabelTextField(['mfinv', 'mfnb']),
    ['to-string', ['coalesce', ['get', '_mfInvDu'], ['get', '_mfnbDu']]],
    'both on: the inventory reading leads, and the two agree anyway');
  // Condo never joins: its rolls are one unit each and its count is drawn per
  // development from a separate source.
  assert.deepEqual(duLabelProps(['condo']), []);
  assert.deepEqual(duLabelProps(['condo', 'mfnb']), ['_mfnbDu']);
});

test('the DU props are the ones main.js actually stamps', () => {
  for (const prop of Object.values(OVERLAY_DU_PROPS)) {
    assert.ok(main.includes(`${prop} = `),
      `${prop} is never assigned in main.js — the stamp was renamed`);
  }
});

test('the label layer is re-pointed, not just re-shown', () => {
  const apply = fnBody(mapJs, 'applyDuLabels');
  assert.ok(apply, 'applyDuLabels() is gone from map.js');
  assert.match(apply, /setFilter\(/, 'the filter has to narrow to the active overlays');
  assert.match(apply, /'text-field'/, 'and so does the field it prints');
  for (const id of ['du-label', 'muni-parcels-du-label']) {
    assert.ok(apply.includes(`'${id}'`), `${id} is not re-pointed`);
  }
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
