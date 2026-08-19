// Static check: the CSV export's header list and cell list must stay the same
// length.
//
// WHY THIS EXISTS. exportCsv() builds its headers in one array literal and its
// cells in another, hundreds of lines apart, and both carry a
// `...(inSalesMode ? [...] : [])` block that only appears on a sales export.
// Adding a column to one and forgetting the other does not throw, does not
// fail a build, and does not look wrong on screen: every column after the
// insertion point simply shifts by one, so `Asmt Land` starts reporting the
// spread in km and a reviewer reads a plausible number under the wrong
// heading. That is the worst failure mode a comp export has.
//
// The check is STATIC — it reads main.js as text rather than importing it,
// because exportCsv touches the DOM and cannot run under node. That makes it a
// structural guard, not a behavioural one: it proves the two lists are the same
// length, not that entry N means the same thing on both sides. Column ORDER
// still has to be checked by eye when adding one.
//
// Run: cd web && node test/csvColumns.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, '..', 'src', 'main.js');

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** Remove // and /* *\/ comments without touching string contents. */
function stripComments(s) {
  let out = '', i = 0, inS = null;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (inS) {
      if (c === '\\') { out += c + (s[i + 1] ?? ''); i += 2; continue; }
      if (c === inS) inS = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { inS = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

/**
 * Count top-level entries of the array literal whose '[' sits at `open`.
 * Commas nested inside calls, sub-arrays, objects, ternaries and strings do
 * not count; a trailing comma does not inflate the total.
 */
function topLevelEntries(s, open) {
  assert.equal(s[open], '[', `expected '[' at ${open}`);
  let depth = 0, count = 0, seen = false, inS = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inS) { if (c === '\\') i++; else if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; if (depth === 1) seen = true; continue; }
    if (c === '[' || c === '(' || c === '{') { depth++; if (depth > 1) seen = true; continue; }
    if (c === ']' || c === ')' || c === '}') {
      depth--;
      if (depth === 0) return seen ? count + 1 : count;
      if (depth === 1) seen = true;
      continue;
    }
    if (c === ',' && depth === 1) { count++; seen = false; continue; }
    if (depth === 1 && !/\s/.test(c)) seen = true;
  }
  throw new Error('unbalanced array literal');
}

console.log('csvColumns.js — counter self-test');

// The counter is the thing doing the work here, so it gets pinned first. The
// trailing-comma case is not hypothetical: an earlier draft returned 0 for it,
// which would have made the real check below pass vacuously (0 === 0).
test('counts entries, including the awkward shapes this file actually contains', () => {
  const cases = [
    ["['a','b','c']", 3],
    ["['a', 'b',]", 2],                    // trailing comma
    ['[]', 0],
    ["['a', f(x, y), 'b']", 3],            // commas inside a call
    ["['a', ['b','c'], 'd']", 3],          // nested array
    ["[cond ? 'x' : 'y', 'z']", 2],        // ternary
    ["[a ?? '', b ?? '']", 2],
    ["[{ x: 1, y: 2 }, 'z']", 2],          // object literal
  ];
  for (const [src, want] of cases) {
    assert.equal(topLevelEntries(src, 0), want, `for ${src}`);
  }
});

console.log('\ncsvColumns.js — export column alignment');

const clean = stripComments(fs.readFileSync(MAIN, 'utf8'));
const marks = [...clean.matchAll(/\.\.\.\(inSalesMode[\s\S]{0,40}?\?\s*\[/g)]
  .map((m) => m.index + m[0].length - 1);

test('exportCsv has exactly two sales-only blocks (headers, then cells)', () => {
  assert.equal(marks.length, 2,
    `found ${marks.length} \`...(inSalesMode ? [...])\` blocks; this check assumes two`);
});

test('the sales-only header and cell lists are the same length', () => {
  const [headers, cells] = marks.map((i) => topLevelEntries(clean, i));
  assert.ok(headers > 0, 'header block parsed as empty — the check would be vacuous');
  assert.equal(cells, headers,
    `sales-only CSV columns are misaligned: ${headers} headers vs ${cells} cells. `
    + 'Every column after the mismatch shifts under the wrong heading.');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
