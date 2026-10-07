// A frontage-stated sale with a verified boundary must reach the SIZE COLUMNS
// with its measured area, not just the popup.
//
// WHY THIS EXISTS. saleSize.showMeasuredArea() was written for exactly this
// row, and its unit tests passed, but only map.js's popup called it. The
// grid's Acres / SF cells, the CSV export and the sale-group totals all went
// through saleAcres(), which returns null for a frontage, so those columns
// stayed blank on about a quarter of all export sales. Found 2026-10-07 on
// Town of Lac du Bonnet rolls 500 + 600 (50 ft lots, sold 2026-05-25). Every
// piece was individually right and the wire between them was missing, the
// same failure overlayWiring.test.js and muniNumberWiring.test.js guard.
//
// Checks, against comment-stripped source:
//   1. main.js rowSizeAcres() resolves through saleSizeAcres(), not saleAcres();
//   2. saleGroups.js totals acres through saleSizeAcres();
//   3. the export's size-source cell uses areaSourceLabel(), so a measured
//      acreage is never attributed to the property-sales report;
//   4. markMeasuredSize() is called on the grid's Acres cells AND its SF cell.
//
// Run: cd web && node test/measuredSizeWiring.test.js

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
const groups = stripComments(read('lib', 'saleGroups.js'));

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

console.log('measured-size wiring');

test('rowSizeAcres resolves through saleSizeAcres', () => {
  const body = functionBody(main, 'rowSizeAcres');
  assert.match(body, /\bsaleSizeAcres\(/);
  assert.doesNotMatch(body, /\bsaleAcres\(/);
});

test('sale-group totals use saleSizeAcres', () => {
  const body = functionBody(groups, 'computeSaleGroups');
  assert.match(body, /\bsaleSizeAcres\(/);
  assert.doesNotMatch(body, /\bsaleAcres\(/);
});

test('the export names a measured acreage as measured', () => {
  assert.match(main, /\bareaSourceLabel\(p\)/);
  assert.doesNotMatch(main, /\bsizeSourceLabel\(/,
    'sizeSourceLabel() in main.js would attribute a measured acreage to the sales report');
});

test('grid Acres and SF cells are marked when measured', () => {
  assert.match(main, /markMeasuredSize\(acresSalesCell, p\)/);
  assert.match(main, /markMeasuredSize\(acresBasicCell, p\)/);
  assert.match(main, /markMeasuredSize\(sfCell, p\)/);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
