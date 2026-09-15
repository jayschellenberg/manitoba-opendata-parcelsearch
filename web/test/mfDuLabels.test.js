// The multi-family dwelling-unit labels, and the legend stack they sit under.
//
// WHY THIS EXISTS. Two failures this repo has already paid for, in one place:
//
//   1. A feature that is fully built and never switched on. The Traffic Counts
//      overlay shipped with layers, legend, data join and button — and no
//      click listener (see overlayWiring.test.js). A map layer is the same
//      shape of risk: `map.addLayer` for the DU labels is invisible unless
//      setMfInventoryVisible() also flips them, and nothing throws if it does
//      not — the numbers simply never appear.
//
//   2. Two facts about one parcel written from two places. The label and the
//      fill are the same claim — "this parcel has 24 units, and it clears your
//      threshold". Stamped separately they drift on the next edit, and the map
//      shows a highlight with no count, or a count on a parcel that is no
//      longer highlighted. Both go through paintMfInvFeature or neither does.
//
// Plus the legend stack: every legend is absolutely positioned in the same
// bottom-right corner, so before restackMapLegends() any two showing at once
// landed on top of each other (Jason, 2026-09-15, the two multi-family layers).
// The stacker only works if it is actually called, and if no legend keeps a
// hand-tuned `bottom` that fights it.
//
// Source-text matching is crude, but a listener that was never written and a
// layer that was never shown look exactly like correct code to a unit test.
//
// Run: cd web && node test/mfDuLabels.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const main = stripComments(fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8'));
const mapJs = stripComments(fs.readFileSync(path.join(root, 'src', 'map.js'), 'utf8'));
const css = stripComments(fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8'));

/** A top-level function's source, or null. They close with `}` at column 0. */
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

console.log('multi-family DU labels + legend stacking');

const LABEL_LAYERS = ['mfinv-du-label', 'muni-parcels-mfinv-du-label'];

// --- the labels are registered, on both sources ------------------------------

test('a label layer is registered for each source the overlay paints', () => {
  const spec = fnBody(mapJs, 'mfInvDuLabelLayer');
  assert.ok(spec, 'mfInvDuLabelLayer() is gone from map.js');
  for (const id of LABEL_LAYERS) {
    assert.ok(mapJs.includes(`mfInvDuLabelLayer('${id}'`),
      `${id} is never added — the overlay paints two sources (search results `
      + 'and the muni-wide fabric) and a label layer on only one of them '
      + 'leaves half the highlighted parcels unlabelled');
  }
  assert.match(mapJs, /mfInvDuLabelLayer\('mfinv-du-label', 'parcels'\)/);
  assert.match(mapJs, /mfInvDuLabelLayer\('muni-parcels-mfinv-du-label', 'muni-parcels'\)/);
});

test('the label reads the stamp, and only paints where the fill does', () => {
  const spec = fnBody(mapJs, 'mfInvDuLabelLayer');
  assert.match(spec, /'text-field':[^\n]*_mfInvDu/,
    'the label must print _mfInvDu — the count main.js stamps beside the colour');
  assert.match(spec, /filter:\s*\['has', '_mfInvDu'\]/,
    'without the filter every parcel in the fabric carries a label slot, '
    + 'and unhighlighted parcels get an empty one');
  assert.match(spec, /'text-allow-overlap':\s*true/,
    'a count dropped for want of room reads as "no units here"');
  assert.match(spec, /'text-ignore-placement':\s*false/,
    'the counts must still displace roll-number labels rather than be '
    + 'overprinted by them');
});

test('the label uses a fontstack the glyph server actually serves', () => {
  // Shipped once with 'Open Sans Bold' and drew nothing: the glyphs endpoint
  // in BASEMAP_STYLE 404s on that stack, and a missing fontstack is silent —
  // no error, no text, indistinguishable from an overlay with no data. The
  // roll-number labels are the proof of what resolves.
  const spec = fnBody(mapJs, 'mfInvDuLabelLayer');
  const font = /'text-font':\s*\[([^\]]*)\]/.exec(spec);
  assert.ok(font, 'the label layer must name a font stack');
  const rollLabel = mapJs.slice(mapJs.indexOf("id: 'muni-parcels-label'"));
  const rollFont = /'text-font':\s*\[([^\]]*)\]/.exec(rollLabel);
  assert.ok(rollFont, 'muni-parcels-label no longer names a font to copy');
  assert.equal(font[1].trim(), rollFont[1].trim(),
    'use the same stack as the roll-number labels — that one is known to '
    + 'resolve against the style\'s glyph endpoint');
});

test('the labels are switched on and off with the overlay', () => {
  const body = fnBody(mapJs, 'setMfInventoryVisible');
  assert.ok(body, 'setMfInventoryVisible() is gone from map.js');
  for (const id of LABEL_LAYERS) {
    assert.ok(body.includes(`'${id}'`),
      `${id} is not in setMfInventoryVisible's list — it is registered with `
      + "visibility 'none' and nothing would ever show it");
  }
});

test('the labels draw above the roll numbers', () => {
  // Both are symbol layers on the same corner of the same parcels. While the
  // multi-family overlay is on, the unit count is the number being asked for.
  const ordering = mapJs.slice(mapJs.indexOf("moveLayer('muni-parcels-label')"));
  assert.ok(ordering.includes("moveLayer('mfinv-du-label')"),
    'mfinv-du-label must be re-anchored AFTER muni-parcels-label');
  assert.ok(ordering.includes("moveLayer('muni-parcels-mfinv-du-label')"),
    'muni-parcels-mfinv-du-label must be re-anchored AFTER muni-parcels-label');
});

// --- the count and the colour are one decision -------------------------------

test('colour and count are stamped in exactly one place', () => {
  const body = fnBody(main, 'paintMfInvFeature');
  assert.ok(body, 'paintMfInvFeature() is gone from main.js');
  assert.match(body, /_mfInvColor = /, 'it must set the colour');
  assert.match(body, /_mfInvDu = /, 'it must set the count');
  assert.match(body, /delete p\._mfInvColor/, 'and clear the colour');
  assert.match(body, /delete p\._mfInvDu/, 'and clear the count with it');

  // Nowhere else may write either one: that is what keeps them in step.
  const writes = [...main.matchAll(/_mfInv(?:Color|Du)\s*=\s*/g)].length;
  const inPaint = [...body.matchAll(/_mfInv(?:Color|Du)\s*=\s*/g)].length;
  assert.equal(writes, inPaint,
    `${writes - inPaint} assignment(s) to _mfInvColor/_mfInvDu outside `
    + 'paintMfInvFeature — the highlight and the number it carries have to be '
    + 'one decision, or raising the threshold un-paints a parcel that keeps '
    + 'its count');
});

test('both stamping paths go through it', () => {
  for (const fn of ['recolorMfInv', 'stampMfInventoryOnFabric']) {
    const body = fnBody(main, fn);
    assert.ok(body, `${fn}() is gone from main.js`);
    assert.match(body, /paintMfInvFeature\(/,
      `${fn} must paint through paintMfInvFeature`);
  }
});

// --- the two multi-family legends -------------------------------------------

test('the legends are rendered as a pair, never one alone', () => {
  // Whether either can print its swatch list depends on what the other is
  // doing, so a lone call to one of them renders a stale answer.
  const pair = fnBody(main, 'renderMfLegends');
  assert.ok(pair, 'renderMfLegends() is gone from main.js');
  assert.match(pair, /renderMfnbLegend\(/);
  assert.match(pair, /renderMfInvLegend\(/);

  const strayNb = [...main.matchAll(/renderMfnbLegend\(/g)].length;
  const strayInv = [...main.matchAll(/renderMfInvLegend\(/g)].length;
  // Two each: the declaration and the call inside renderMfLegends.
  assert.equal(strayNb, 2, 'renderMfnbLegend is called outside renderMfLegends');
  assert.equal(strayInv, 2, 'renderMfInvLegend is called outside renderMfLegends');
});

test('the pair owns both boxes\' visibility', () => {
  const pair = fnBody(main, 'renderMfLegends');
  assert.match(pair, /\$mfnbLegend\.hidden = /);
  assert.match(pair, /\$mfinvLegend\.hidden = /);
  // A toggle handler setting `hidden = false` on its own would put the
  // duplicate box back on screen the moment the ramps matched.
  const nbHides = [...main.matchAll(/\$mfnbLegend\.hidden = /g)].length;
  const invHides = [...main.matchAll(/\$mfinvLegend\.hidden = /g)].length;
  assert.equal(nbHides, 1, '$mfnbLegend.hidden is set outside renderMfLegends');
  assert.equal(invHides, 1, '$mfinvLegend.hidden is set outside renderMfLegends');
});

test('the duplicate test is the shared one, not a restatement', () => {
  const body = fnBody(main, 'mfLegendsShareOneRamp');
  assert.ok(body, 'mfLegendsShareOneRamp() is gone from main.js');
  assert.match(body, /sameLegendSteps\(/,
    'the comparison lives in lib/mfInventory.js where it is unit-tested');
  assert.match(body, /mfnbMode === 'units'/,
    'only the Units view duplicates this ramp — Year and Type do not');
});

// --- the legend stack --------------------------------------------------------

test('the stacker is wired, not just written', () => {
  assert.ok(fnBody(main, 'restackMapLegends'), 'restackMapLegends() is gone');
  const calls = [...main.matchAll(/restackMapLegends\(\)/g)].length;
  assert.ok(calls >= 3,
    'restackMapLegends must be called from the legend MutationObserver, on '
    + `resize, and once at startup — found ${calls} call site(s)`);
  // The legend observer specifically — main.js runs more than one, so find
  // the one whose callback is the legend bookkeeping.
  const observers = [...main.matchAll(/new MutationObserver\(/g)]
    .map((m) => main.slice(m.index, m.index + 200));
  const legendObserver = observers.find((o) => o.includes('updateLegendAvailability'));
  assert.ok(legendObserver, 'the legend MutationObserver is gone from main.js');
  assert.match(legendObserver, /restackMapLegends\(\)/,
    'the observer that watches legends appear must restack them');
});

test('the stacker only writes when the value changes', () => {
  // It writes inline styles, and the observer that calls it watches `style`.
  // Writing unconditionally is an infinite loop; writing only on a difference
  // reaches a fixed point on the second pass.
  const body = fnBody(main, 'restackMapLegends');
  assert.match(body, /if \(el\.style\.bottom !== want\)/,
    'the bottom write must be guarded by a comparison');
  assert.match(body, /if \(el\.style\.maxHeight !== cap\)/,
    'the max-height write must be guarded by a comparison');
});

test('no legend keeps a hand-tuned bottom to dodge a collision', () => {
  // One `bottom` in the shared .map-legend rule, as the stack's starting
  // point. A per-legend override is the old whack-a-mole fix and would fight
  // the stacker's inline style.
  const rules = [...css.matchAll(/\.map-legend[^{]*\{[^}]*\}/g)].map((m) => m[0]);
  const withBottom = rules.filter((r) => /(^|[\s;{])bottom\s*:/.test(r));
  assert.equal(withBottom.length, 1,
    `${withBottom.length} .map-legend rules set \`bottom\`; only the shared `
    + `anchor may:\n${withBottom.join('\n')}`);
  assert.match(withBottom[0], /^\.map-legend \{/,
    'the one rule that sets bottom must be the shared .map-legend anchor');
  assert.ok(!/with-zoning/.test(css) && !/with-zoning/.test(main),
    'the .with-zoning bump was the single-pair fix the stacker replaced');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
