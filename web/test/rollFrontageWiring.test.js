// The roll frontage must reach EVERY place the Dimensions figures are shown,
// not just the function that computes it.
//
// WHY THIS EXISTS. lib/parcelDimensions.js featureDimensions() applies the
// assessment roll's frontage (Jason, 2026-10-22: a side within 1 ft of the
// roll figure takes it, the rest scale by the ratio). The plain polygon
// measurement, parcelDimensions(), is still exported and still correct, so a
// consumer left calling it would quietly show the uncorrected numbers and
// every unit test would stay green — the "code that exists and is never
// called" failure measuredSizeWiring.test.js and overlayWiring.test.js guard.
// The grid, the CSV and the map labels must agree, so all three are checked.
//
// Checks, against comment-stripped source:
//   1. main.js rowDimensions() (grid Sides / Perimeter, sort, CSV) resolves
//      through featureDimensions(), and main.js never measures a polygon
//      with parcelDimensions() directly;
//   2. the grid's Sides tooltip carries rollFrontageNote();
//   3. lib dimensionLabelFeatures() (the map labels, and with them the
//      Addenda Pack site map) uses featureDimensions();
//   4. map.js setParcelDimensionData() builds its labels with
//      dimensionLabelFeatures().
//
// Run: cd web && node test/rollFrontageWiring.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', 'src', ...p), 'utf8');

// Strip comments so a call that only appears in prose cannot satisfy a check.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(^|[^:])\/\/[^\r\n]*$/gm, '$1');
}
const main = stripComments(read('main.js'));
const map = stripComments(read('map.js'));
const dims = stripComments(read('lib', 'parcelDimensions.js'));

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** The body of a top-level `function name(...) { ... }`, by brace counting. */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  // The body opens at the first `) {`, so destructured params are skipped.
  const m = /\)\s*\{/.exec(src.slice(start));
  assert.ok(m, `body of ${name} not found`);
  const open = start + m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

console.log('roll-frontage wiring');

test('rowDimensions resolves through featureDimensions', () => {
  const body = functionBody(main, 'rowDimensions');
  assert.match(body, /\bfeatureDimensions\(/);
  assert.doesNotMatch(body, /\bparcelDimensions\(/);
});

test('main.js never measures a polygon with parcelDimensions directly', () => {
  // assert.ok, not doesNotMatch: a failure should not print all of main.js.
  assert.ok(!/\bparcelDimensions\(/.test(main), 'main.js calls parcelDimensions() — use featureDimensions() / rowDimensions()');
});

test('the grid Sides tooltip carries the roll-frontage note', () => {
  assert.ok(/sidesCell\.title\s*=[^;]*\brollFrontageNote\(dims\)/.test(main), 'sidesCell.title does not include rollFrontageNote(dims)');
});

test('map labels resolve through featureDimensions', () => {
  const body = functionBody(dims, 'dimensionLabelFeatures');
  assert.match(body, /\bfeatureDimensions\(/);
  assert.doesNotMatch(body, /\bparcelDimensions\(/);
});

test('setParcelDimensionData builds its labels with dimensionLabelFeatures', () => {
  assert.match(functionBody(map, 'setParcelDimensionData'), /\bdimensionLabelFeatures\(features\)/);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
