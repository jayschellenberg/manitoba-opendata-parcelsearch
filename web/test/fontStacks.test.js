// Every symbol layer in map.js must name a font stack the style's glyph
// endpoint actually serves.
//
// WHY THIS EXISTS. A missing fontstack is the quietest failure MapLibre has.
// BASEMAP_STYLE points `glyphs` at demotiles.maplibre.org, which serves
// "Open Sans Semibold" and 404s on "Open Sans Bold". There is no console
// error and no thrown exception — but the 404 fails the tile parse in the
// worker, so the tile lands `errored` with no buckets at all. Every layer on
// that source goes with it: on 2026-09-15 `route-stop-rank` asked for
// "Open Sans Bold" and took `route-stop-pt` down with it, so a calculated
// route drew its polyline and its green Start pin and simply had no numbered
// stop badges anywhere — no number AND no circle.
//
// mfDuLabels.test.js pins this for one layer, because that layer shipped the
// same bug. One layer is not the contract: the next symbol layer someone adds
// is the one that will be typed from memory. This asserts it for all of them,
// against the roll-number labels as the known-good reference — that stack is
// on screen at every municipal zoom, so a regression in it is impossible to
// miss, which is exactly what makes it the right thing to copy.
//
// Run: cd web && node test/fontStacks.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** Comments stripped — a test that matches its own documentation proves
 *  nothing, and the prose above names the wrong stack on purpose. Same
 *  helper as rowSelection.test.js / mfDuLabels.test.js. */
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

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const FONT_RE = /'text-font':\s*\[([^\]]*)\]/g;

/** The layer id a match belongs to: the nearest `id: '...'` above it. Layer
 *  literals are written id-first throughout map.js. */
function layerAbove(index) {
  const before = mapJs.slice(0, index);
  const at = before.lastIndexOf("id: '");
  if (at < 0) return '(unattributed)';
  return before.slice(at + 5, before.indexOf("'", at + 5));
}

/** Every declared stack, as `{ layer, stack }` with the stack normalised to
 *  its source text minus whitespace. */
function declaredStacks() {
  FONT_RE.lastIndex = 0;
  const out = [];
  for (let m = FONT_RE.exec(mapJs); m; m = FONT_RE.exec(mapJs)) {
    out.push({ layer: layerAbove(m.index), stack: m[1].replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/** The reference: whatever the roll-number labels use. */
function referenceStack() {
  const at = mapJs.indexOf("id: 'muni-parcels-label'");
  assert.ok(at >= 0, 'muni-parcels-label is gone from map.js — pick a new reference layer');
  const m = /'text-font':\s*\[([^\]]*)\]/.exec(mapJs.slice(at));
  assert.ok(m, 'muni-parcels-label no longer names a font stack to copy');
  return m[1].replace(/\s+/g, ' ').trim();
}

console.log('map.js — font stacks');

test('the regex sees every text-font in the file', () => {
  // A stack written as an expression would have nested brackets and this
  // regex would capture a fragment of it. If that ever happens the assertion
  // below is silently weakened, so count the keys instead of trusting it.
  const keys = (mapJs.match(/'text-font':/g) || []).length;
  assert.ok(keys > 0, "no 'text-font' found in map.js at all — the scan is broken");
  assert.equal(declaredStacks().length, keys,
    `${keys} text-font keys but ${declaredStacks().length} parsed stacks — one is `
    + 'written in a shape this test cannot read, so it is not being checked');
});

test('every symbol layer uses the same stack as the roll-number labels', () => {
  const want = referenceStack();
  const wrong = declaredStacks().filter((d) => d.stack !== want);
  assert.deepEqual(wrong, [],
    `these layers name a stack the glyph endpoint may not serve (want ${want}):\n`
    + wrong.map((d) => `  ${d.layer}: ${d.stack}`).join('\n'));
});

test('the reference stack is a single named font, not a fallback chain', () => {
  // MapLibre concatenates a multi-font stack into one glyph request
  // ("A,B/0-255.pbf"); demotiles has no such composite, so a "fallback" is
  // not a fallback — it 404s the pair and loses both.
  assert.match(referenceStack(), /^'[^',]+'$/,
    'the roll-number labels must name exactly one font');
});

test('the Protomaps basemap layers are remapped onto that same stack', () => {
  // protomapsLayers() ships "Noto Sans Medium", which demotiles also 404s;
  // map.js rewrites it at style-build time. That rewrite is a font stack
  // too, it just is not spelled as a text-font key.
  const want = referenceStack().replace(/'/g, '"');
  assert.ok(mapJs.includes(`.replaceAll('"Noto Sans Medium"', '${want}')`),
    `the Noto Sans Medium rewrite must target ${want} — the basemap's own `
    + 'labels go silent otherwise, and they are most of the map');
  assert.ok(!/'Noto Sans Medium'/.test(mapJs.replace(/replaceAll\([^)]*\)/g, '')),
    'Noto Sans Medium must not survive anywhere except as the rewrite input');
});

test('the glyph endpoint this contract is written against has not moved', () => {
  // If the app ever self-hosts glyphs, more stacks become available and the
  // one-stack rule above is worth revisiting rather than working around.
  assert.match(mapJs, /glyphs: 'https:\/\/demotiles\.maplibre\.org\/font\/\{fontstack\}\/\{range\}\.pbf'/,
    'the glyph endpoint changed — re-check which font stacks it serves before '
    + 'relaxing or keeping these assertions');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
