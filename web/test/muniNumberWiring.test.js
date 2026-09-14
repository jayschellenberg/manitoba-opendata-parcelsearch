// The municipality picker must actually be painted WITH its muni numbers.
//
// WHY THIS EXISTS. lib/dropdownSources.js can produce a perfect
// "ARBORG (TOWN) - 300" label and its unit tests can all pass while the
// picker on screen still reads "ARBORG (TOWN)", because the label mapper
// is an OPTIONAL fourth argument to repaintSelect: forget it at one of the
// three sites that paint #municipality and that path silently keeps the
// old labels. The early-boot paint is the easiest one to miss — it is the
// one users see first, and it fires on a cache hit where the tests never
// look. This is the same failure mode overlayWiring.test.js was written
// for: every piece individually right, the wire between them missing.
//
// Checks, against comment-stripped main.js source:
//   1. every repaintSelect/fillSelect call that paints $municipality with
//      a non-empty list passes the muniLabel mapper;
//   2. the numbers are adopted from the snapshot manifest (setMuniNumbers
//      is called, not merely defined);
//   3. repaintSelect compares option TEXT as well as value, or the early
//      bare-name paint would be mistaken for the final numbered one and
//      never repainted.
//
// Run: cd web && node test/muniNumberWiring.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');

/**
 * Strip comments so a call that only appears in prose (this file's own
 * subject matter is heavily commented) cannot satisfy any assertion below.
 * Crude but sufficient: string and regex literals in this file never
 * contain "//" or "/*" sequences that would be mistaken for a comment
 * opener on a line of real code we care about.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(^|[^:])\/\/[^\r\n]*$/gm, '$1');
}
const main = stripComments(raw);

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** Every fillSelect/repaintSelect call whose first argument is
 *  $municipality, as its full argument text. */
function municipalityPaintCalls() {
  const calls = [];
  const re = /\b(fillSelect|repaintSelect)\(\s*\$municipality\s*,/g;
  for (const m of main.matchAll(re)) {
    let depth = 1;
    let i = main.indexOf('(', m.index) + 1;
    const start = i;
    for (; i < main.length && depth > 0; i++) {
      if (main[i] === '(') depth++;
      else if (main[i] === ')') depth--;
    }
    calls.push({ fn: m[1], args: main.slice(start, i - 1) });
  }
  return calls;
}

console.log('municipality picker is painted with its numbers');

test('main.js imports the label helpers it needs', () => {
  assert.match(main, /\bmuniNumberIndex\b/, 'muniNumberIndex is never imported/used');
  assert.match(main, /\bmuniOptionLabel\b/, 'muniOptionLabel is never imported/used');
});

test('all three paint sites are found', () => {
  const calls = municipalityPaintCalls();
  assert.ok(calls.length >= 3,
    `expected at least 3 $municipality paint calls, found ${calls.length}`);
});

test('every paint of a real muni list passes the label mapper', () => {
  for (const call of municipalityPaintCalls()) {
    // The error-path call paints an EMPTY list with a failure placeholder;
    // there is nothing to label, so it is exempt.
    if (/,\s*\[\s*\]\s*,/.test(`,${call.args},`) || /\(\s*\$municipality\s*,\s*\[\s*\]/.test(`(${call.args}`)) continue;
    if (/^\s*\$municipality\s*,\s*\[\s*\]\s*,/.test(call.args)) continue;
    assert.match(call.args, /muniLabel/,
      `${call.fn}($municipality, …) paints without muniLabel — that picker `
      + `will read bare names: ${call.args.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
});

test('the numbers are adopted from the snapshot manifest, not just defined', () => {
  const calls = [...main.matchAll(/\bsetMuniNumbers\(/g)].length;
  const defs = [...main.matchAll(/function setMuniNumbers\(/g)].length;
  assert.equal(defs, 1, 'setMuniNumbers should be defined exactly once');
  assert.ok(calls - defs >= 2,
    `setMuniNumbers is defined but called ${calls - defs} time(s); the boot `
    + 'path and the post-boot snapshot recheck both need it');
});

test('repaintSelect compares option text, so the early bare paint is replaced', () => {
  const at = main.indexOf('function repaintSelect(');
  assert.ok(at >= 0, 'repaintSelect not found');
  const body = main.slice(at, at + 900);
  assert.match(body, /textContent/,
    'repaintSelect compares values only — the early, number-less paint of '
    + 'the same muni list would count as "same" and never be repainted');
});

const failed = results.filter((r) => r === 0).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
