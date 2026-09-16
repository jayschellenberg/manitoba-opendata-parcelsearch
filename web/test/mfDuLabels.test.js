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

const LABEL_LAYERS = ['du-label', 'muni-parcels-du-label'];

// --- the labels are registered, on both sources ------------------------------

test('a label layer is registered for each source the overlays paint', () => {
  const spec = fnBody(mapJs, 'duLabelLayer');
  assert.ok(spec, 'duLabelLayer() is gone from map.js');
  for (const id of LABEL_LAYERS) {
    assert.ok(mapJs.includes(`duLabelLayer('${id}'`),
      `${id} is never added — the overlays paint two sources (search results `
      + 'and the muni-wide fabric) and a label layer on only one of them '
      + 'leaves half the highlighted parcels unlabelled');
  }
  assert.match(mapJs, /duLabelLayer\('du-label', 'parcels'\)/);
  assert.match(mapJs, /duLabelLayer\('muni-parcels-du-label', 'muni-parcels'\)/);
});

test('ONE layer carries both multi-family overlays, not one each', () => {
  // The standing inventory and New Multi-Family largely paint the same rolls,
  // and these labels never yield (allow-overlap). A layer each would print the
  // same number twice, on top of itself.
  const spec = fnBody(mapJs, 'duLabelLayer');
  assert.match(spec, /'text-field':[^\n]*coalesce[^\n]*_mfInvDu[^\n]*_mfnbDu/,
    'the label must coalesce both stamps, inventory first');
  assert.match(spec, /filter:\s*\['any', \['has', '_mfInvDu'\], \['has', '_mfnbDu'\]\]/,
    'without the filter every parcel in the fabric carries a label slot, '
    + 'and unhighlighted parcels get an empty one');
  assert.match(spec, /'text-allow-overlap':\s*true/,
    'a count dropped for want of room reads as "no units here"');
  assert.match(spec, /'text-ignore-placement':\s*false/,
    'the counts must still displace roll-number labels rather than be '
    + 'overprinted by them');
});

test('both label layers use a fontstack the glyph server actually serves', () => {
  // Shipped once with 'Open Sans Bold' and drew nothing: the glyphs endpoint
  // in BASEMAP_STYLE 404s on that stack, and a missing fontstack is silent —
  // no error, no text, indistinguishable from an overlay with no data. The
  // roll-number labels are the proof of what resolves.
  const rollLabel = mapJs.slice(mapJs.indexOf("id: 'muni-parcels-label'"));
  const rollFont = /'text-font':\s*\[([^\]]*)\]/.exec(rollLabel);
  assert.ok(rollFont, 'muni-parcels-label no longer names a font to copy');
  for (const fn of ['duLabelLayer', 'condoDuLabelLayer']) {
    const font = /'text-font':\s*\[([^\]]*)\]/.exec(fnBody(mapJs, fn) || '');
    assert.ok(font, `${fn} must name a font stack`);
    assert.equal(font[1].trim(), rollFont[1].trim(),
      `${fn} must use the same stack as the roll-number labels — that one is `
      + "known to resolve against the style's glyph endpoint");
  }
});

test('the parcel labels follow EITHER multi-family overlay', () => {
  // One layer, two toggles: turning one off while the other is still on must
  // not take the numbers with it — and turning BOTH off must.
  const apply = fnBody(mapJs, 'applyDuLabels');
  assert.ok(apply, 'applyDuLabels() is gone from map.js');
  for (const id of LABEL_LAYERS) {
    assert.ok(apply.includes(`'${id}'`),
      `${id} is not in applyDuLabels — it is registered with visibility 'none' `
      + 'and nothing would ever show it');
  }
  // Nobody else may flip them, or the layer can disagree with the overlays.
  for (const other of ['setMfInventoryVisible', 'setMfNewbuildVisible']) {
    const b = fnBody(mapJs, other) || '';
    for (const id of LABEL_LAYERS) {
      assert.ok(!b.includes(`'${id}'`),
        `${other} must not switch ${id} — that is applyDuLabels' job, because `
        + 'the layer belongs to both overlays');
    }
  }
  const sync = fnBody(main, 'syncActiveOverlays');
  assert.ok(sync, 'syncActiveOverlays() is gone from main.js');
  assert.match(sync, /mfInvOverlayOn/);
  assert.match(sync, /mfnbOverlayOn/);
  // Every place either overlay changes state has to re-ask.
  const calls = [...main.matchAll(/syncActiveOverlays\(\)/g)].length;
  assert.ok(calls >= 6,
    `expected the six on/off transitions (three overlays x on and off) to `
    + `re-ask; found ${calls}`);
});

// --- the counts sit on a disc ----------------------------------------------

test('the count rides a badge, and the badge is an icon', () => {
  // A circle LAYER on these sources would draw one circle per polygon vertex —
  // a necklace round the parcel, not a badge on it. The disc has to be the
  // symbol's own icon, which is why there are images at all.
  const spec = fnBody(mapJs, 'duLabelLayer');
  assert.match(spec, /'icon-image':\s*duBadgeImageExpr\(/,
    'the label layer draws no disc');
  assert.match(spec, /'icon-size':\s*DU_BADGE_SIZE_EXPR/,
    'the disc must scale off the same zoom ramp as the digits, or the number '
    + 'grows out of its badge');
  assert.match(spec, /'icon-allow-overlap':\s*true/,
    'the text is allow-overlap; an icon culled on its own leaves digits '
    + 'floating off their disc');
  assert.ok(!/'text-halo-width'/.test(spec),
    'white digits on a slate disc need no halo — a white halo inside a dark '
    + 'badge reads as a printing error');
  assert.match(spec, /'text-color':\s*'#ffffff'/);
});

test('the discs are registered, not merely defined', () => {
  // The failure this repo has paid for twice: a thing that is fully built and
  // never called. A missing icon-image is silent — MapLibre draws the text and
  // no badge, which looks like a design decision.
  const add = fnBody(mapJs, 'addDuBadgeImages');
  assert.ok(add, 'addDuBadgeImages() is gone from map.js');
  assert.match(add, /map\.addImage\(/, 'it must actually register the images');
  assert.match(add, /hasImage/,
    'addImage throws on a duplicate id, and style setup can run twice');
  const calls = [...mapJs.matchAll(/addDuBadgeImages\(map\)/g)].length;
  assert.ok(calls >= 1,
    'addDuBadgeImages() is never called — every badge would be a blank');
  // Before the layers that name the images.
  const at = mapJs.indexOf('addDuBadgeImages(map)');
  assert.ok(at > 0 && at < mapJs.indexOf("duLabelLayer('"),
    'the images have to exist before a layer asks for one');
});

test('every image the expression names is one the registrar makes', () => {
  const expr = fnBody(mapJs, 'duBadgeImageExpr');
  const widths = /DU_BADGE_PX\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(mapJs);
  assert.ok(widths, 'DU_BADGE_PX is gone — the radii the discs are drawn at');
  const count = widths[1].split(',').filter((s) => s.trim()).length;
  const named = [...expr.matchAll(/\$\{prefix\}-(\d)/g)].map((m) => Number(m[1]));
  assert.deepEqual(named, [1, 2, 3],
    'one disc per digit-width, and the step must name them in order');
  assert.equal(count, named.length,
    `the expression names ${named.length} discs and DU_BADGE_PX draws ${count}`);
  // Both families come off the same list of radii, so they cannot drift.
  const add = fnBody(mapJs, 'addDuBadgeImages');
  assert.match(add, /DU_BADGE_PX\.forEach/);
  assert.match(add, /\['du-badge', DU_BADGE_COLOR\], \['condo-du-badge', CONDO_BADGE_COLOR\]/,
    'the parcel count and the condo total are the two badge families');
});

test('the disc follows the field, not the stamp it was built with', () => {
  // applyDuLabels re-points text-field at whichever overlay is painting. A
  // disc still sized from the other overlay's stamp would put a two-digit
  // count on a one-digit badge.
  const apply = fnBody(mapJs, 'applyDuLabels');
  assert.match(apply, /'icon-image', duBadgeImageExpr\(field\)/,
    'the badge must be re-pointed in the same pass as the text');
  assert.match(apply, /field !== ''/,
    "nothing to point at when no overlay is painting — an empty icon-image is "
    + 'not a valid image name');
});

test('the condo total keeps its own colour', () => {
  // Both are badges now, so the colour is the only thing left that says
  // "this is a development total, not this parcel's own count".
  const spec = fnBody(mapJs, 'condoDuLabelLayer');
  assert.match(spec, /duBadgeImageExpr\(\[[^\]]*'du'\]\], 'condo-du-badge'\)/,
    'the condo total must draw from the condo badge family');
  assert.match(mapJs, /CONDO_BADGE_COLOR = '#4a1486'/,
    'the purple the condo totals have always been drawn in');
});

test('condo counts are per DEVELOPMENT, not per unit roll', () => {
  // Row housing is condo-titled — one roll per unit, dwelling_units = 1 — so
  // labelling the parcels prints "1" forty times across one project.
  assert.ok(fnBody(mapJs, 'condoDuLabelLayer'), 'condoDuLabelLayer() is gone');
  assert.match(mapJs, /addSource\('condo-du-labels'/,
    'the plan totals need their own point source: a development has no polygon');
  assert.match(mapJs, /condoDuLabelLayer\('condo-du-label', 'condo-du-labels'\)/);
  const vis = fnBody(mapJs, 'setCondoDevVisible');
  assert.ok(vis.includes("'condo-du-label'"),
    'the plan totals must switch with the condo overlay that explains them');
  const refresh = fnBody(main, 'refreshCondoDuLabels');
  assert.ok(refresh, 'refreshCondoDuLabels() is gone from main.js');
  assert.match(refresh, /condoDuLabelPoints\(/,
    'the grouping lives in lib/condoDev.js where it is unit-tested');
  assert.match(refresh, /_condoColor/,
    'only painted rolls may contribute — the labels must match the map');
  assert.ok([...main.matchAll(/refreshCondoDuLabels\(\)/g)].length >= 3,
    'rebuild on turning the overlay on and on every recolour, or the totals '
    + 'describe the last municipality');
});

test('the labels draw above the roll numbers', () => {
  // Both are symbol layers on the same corner of the same parcels. While a
  // multi-family overlay is on, the unit count is the number being asked for.
  const ordering = mapJs.slice(mapJs.indexOf("moveLayer('muni-parcels-label')"));
  for (const id of [...LABEL_LAYERS, 'condo-du-label']) {
    assert.ok(ordering.includes(`moveLayer('${id}')`),
      `${id} must be re-anchored AFTER muni-parcels-label`);
  }
});

// --- the Assessment Parcels fabric stays the user's choice -------------------

test('no multi-family overlay switches the parcel fabric on', () => {
  // It used to, so a coloured parcel would answer a click — but each of these
  // overlays also puts what it paints into the results, which have their own
  // click handling, so nothing was at risk. Forcing the fabric on just buried
  // the highlight under every other parcel in the municipality (Jason,
  // 2026-09-15). Crop History is the exception and keeps it: it paints the
  // whole fabric and does not fill the grid.
  for (const fn of ['toggleMfInventoryOverlay', 'toggleMfNewbuildOverlay',
                    'toggleCondoDevOverlay']) {
    const body = fnBody(main, fn);
    assert.ok(body, `${fn}() is gone from main.js`);
    assert.ok(!/toggleAuxOverlay\(\s*'muniParcels'\s*\)/.test(body),
      `${fn} switches the Assessment Parcels layer on — that is the user's `
      + 'choice, and forcing it buries the highlight it just drew');
  }
  const landfacts = fnBody(main, 'toggleLandfactsOverlay') || '';
  assert.match(landfacts, /toggleAuxOverlay\(\s*'muniParcels'\s*\)/,
    'Crop History still needs the fabric: it paints every parcel and puts '
    + 'none of them in the grid, so the fabric answers the only click there is');
});

// --- the count and the colour are one decision -------------------------------

// Each overlay's colour and count are one decision, written in one place.
// A highlight with no count, or a count on a parcel that is no longer
// highlighted, is the map saying two things about the same roll.
for (const [paint, prefix, why] of [
  ['paintMfInvFeature', '_mfInv',
   'or raising the "DU \u2265" threshold un-paints a parcel that keeps its count'],
  ['paintMfnbFeature', '_mfnb',
   'or switching view repaints the roll and leaves the old count behind'],
]) {
  test(`${prefix} colour and count are stamped in exactly one place`, () => {
    const body = fnBody(main, paint);
    assert.ok(body, `${paint}() is gone from main.js`);
    assert.ok(body.includes(`${prefix}Color = `), 'it must set the colour');
    assert.ok(body.includes(`${prefix}Du = `), 'it must set the count');
    assert.ok(body.includes(`delete p.${prefix}Color`), 'and clear the colour');
    assert.ok(body.includes(`delete p.${prefix}Du`), 'and clear the count with it');

    // Nowhere else may write either one: that is what keeps them in step.
    const rx = new RegExp(`${prefix}(?:Color|Du)\\s*=\\s*`, 'g');
    const writes = [...main.matchAll(rx)].length;
    const inPaint = [...body.matchAll(rx)].length;
    assert.equal(writes, inPaint,
      `${writes - inPaint} assignment(s) to ${prefix}Color/${prefix}Du outside `
      + `${paint} \u2014 the highlight and the number it carries have to be one `
      + `decision, ${why}`);
  });
}

test('every stamping path goes through those', () => {
  for (const [fn, paint] of [
    ['recolorMfInv', 'paintMfInvFeature'],
    ['stampMfInventoryOnFabric', 'paintMfInvFeature'],
    ['recolorMfnb', 'paintMfnbFeature'],
    ['stampMfNewbuildOnFabric', 'paintMfnbFeature'],
  ]) {
    const body = fnBody(main, fn);
    assert.ok(body, `${fn}() is gone from main.js`);
    assert.ok(body.includes(`${paint}(`), `${fn} must paint through ${paint}`);
  }
});

// --- one threshold, both layers ---------------------------------------------

test('the "DU >=" box filters New Multi-Family too', () => {
  // It used to filter only the standing inventory, so with both layers on the
  // map showed 20+ unit buildings in one and 3+ in the other (Jason,
  // 2026-09-15).
  const colorFor = fnBody(main, 'mfnbColorFor');
  assert.ok(colorFor, 'mfnbColorFor() is gone from main.js');
  assert.match(colorFor, /mfnbPasses\(hit, mfMinDu\(\)\)/,
    'New Multi-Family must gate on the shared threshold before colouring');
  const invColorFor = fnBody(main, 'mfInvColorFor');
  assert.match(invColorFor, /mfMinDu\(\)/,
    'and the inventory must read the same box, not a second one');
  // One reader of the input, so the two can never diverge.
  const readers = [...main.matchAll(/\$mfinvMinDu\??\.value/g)].length;
  const inMinDu = [...(fnBody(main, 'mfMinDu') || '').matchAll(/\$mfinvMinDu\??\.value/g)].length;
  const inHandler = [...(fnBody(main, 'onMfThresholdChange') || '').matchAll(/\$mfinvMinDu\??\.value/g)].length;
  assert.equal(readers, inMinDu + inHandler,
    'the threshold input is read outside mfMinDu() and its change handler');
});

test('moving the bar repaints whichever layers are on', () => {
  const h = fnBody(main, 'onMfThresholdChange');
  assert.ok(h, 'onMfThresholdChange() is gone from main.js');
  // Widened when the context outline landed: the inventory stamps are also
  // re-stamped while that overlay is off but drawing context under the
  // new-build layer.
  assert.match(h, /if \(mfInvOverlayOn \|\| inventoryContextWanted\(\)\) recolorMfInv\(\)/);
  assert.match(h, /if \(mfnbOverlayOn\) recolorMfnb\(\)/,
    'a bar that governs both layers has to repaint both');
  assert.match(h, /!mfInvOverlayOn && !mfnbOverlayOn/,
    'and do nothing while neither is on');
  assert.match(h, /showMfNewbuildResults\(munis\)/,
    'the grid has to follow too when New Multi-Family is the layer on');
});

test('the bar moves both ways', () => {
  // A roll below the current bar must still be stamped, or lowering the bar
  // could not bring it back without a refetch.
  const stamp = fnBody(main, 'stampMfNewbuildOnFabric');
  assert.match(stamp, /if \(hit\) p\._mfnb = hit;/,
    'every hit is stamped, painted or not');
  const grid = fnBody(main, 'showMfNewbuildResults');
  assert.match(grid, /_mfnbColor/,
    'and the grid lists what is PAINTED, not what is stamped, or rolls below '
    + 'the bar stay in the list after they leave the map');
  assert.ok(!/properties\?\._mfnb\b(?!Color)/.test(grid),
    'the grid must not filter on the raw stamp any more');
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
