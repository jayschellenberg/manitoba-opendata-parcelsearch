// Static check: every CSV export header name is unique, and the plain
// `Wetland %` header is the land-cover share.
//
// WHY THIS EXISTS. Until 2026-09-22 the export carried TWO columns named
// `Wetland %`: the land-cover mix share (in the Cult / Pasture / Bush /
// Wetland / Other block) and the CWIM3A wetland-inventory share from
// landfactsCsvHeaders(). Anything reading the file by name — the LandV3
// engine does, via pick(MAO, "Wetland %") — got whichever came first. That
// happened to be the right one, but only because of column order: move the
// landfacts block ahead of the land-cover block, or reorder the sheet in
// Excel, and the engine silently reads a different measure under the same
// heading. Nothing throws and the number is plausible either way.
//
// Readers key on names, so names must be unique. The second test pins which
// family keeps the plain name: downstream code asks for `Wetland %` meaning
// the land-cover share, so renaming THAT one (instead of the CWIM one) would
// flip every reader to the wrong measure with unique names and no error.
//
// Like csvColumns.test.js this reads main.js as text, because exportCsv
// touches the DOM. Header helpers that are spread into the list are expanded
// by importing them (or, for soilCsvHeaders, which lives in main.js, by
// rebuilding it from its source); a NEW spread fails the test until it is
// added below, so an unexpanded helper cannot hide a duplicate.
//
// Run: cd web && node test/csvHeaderNames.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { landfactsCsvHeaders } from '../src/lib/landfacts.js';
import { mfnbCsvHeaders } from '../src/lib/mfNewbuild.js';
import { condoCsvHeaders } from '../src/lib/condoDev.js';

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

/** Text of the array literal whose '[' sits at `open`, brackets included. */
function arrayText(s, open) {
  let depth = 0, inS = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inS) { if (c === '\\') i++; else if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') { depth--; if (depth === 0) return s.slice(open, i + 1); }
  }
  throw new Error('unbalanced array literal');
}

const clean = stripComments(fs.readFileSync(MAIN, 'utf8'));

// The export's header literal is the `const header = [` that opens Roll #, Muni #
// (downloadUnmatchedCsv has its own, shorter one).
const headerStarts = [...clean.matchAll(/const header = \[/g)]
  .map((m) => m.index + m[0].length - 1)
  .filter((i) => /'Roll #', 'Muni #'/.test(arrayText(clean, i)));

// soilCsvHeaders() rebuilt from its own source: the fixed per-soil labels in
// its body plus the labels of SOIL_CSV_DOMAINS_PER_SOIL.
function soilHeadersFromSource() {
  const body = clean.match(/function soilCsvHeaders\(\) \{([\s\S]*?)\n\}/)?.[1];
  const domains = clean.match(/SOIL_CSV_DOMAINS_PER_SOIL = \[([\s\S]*?)\n\];/)?.[1];
  assert.ok(body && domains, 'could not find soilCsvHeaders / SOIL_CSV_DOMAINS_PER_SOIL in main.js');
  const fixed = [...body.matchAll(/`Soil \$\{idx\} ([^`]+)`/g)].map((m) => m[1]);
  const labels = [...domains.matchAll(/\[\s*'[^']*',\s*'([^']+)'\s*\]/g)].map((m) => m[1]);
  assert.ok(fixed.length && labels.length, 'soil header source parsed as empty');
  const out = [];
  for (const idx of ['1', '2', '3']) for (const l of [...fixed, ...labels]) out.push(`Soil ${idx} ${l}`);
  return out;
}

const SPREADS = {
  soilCsvHeaders: soilHeadersFromSource,
  landfactsCsvHeaders,
  mfnbCsvHeaders,
  condoCsvHeaders,
};

console.log('csvHeaderNames.js — export header names');

test('exportCsv has exactly one header literal', () => {
  assert.equal(headerStarts.length, 1, `found ${headerStarts.length}`);
});

const block = headerStarts.length === 1 ? arrayText(clean, headerStarts[0]) : '[]';

// Every name the export can emit: literals from both branches of the
// sales-mode ternary (they are concatenated, never alternatives) plus the
// expanded helpers. csvAssessHeader() yields `Assess-YYYY ($)`, which cannot
// collide with any other name, so it is the one call left unexpanded.
function allNames() {
  const lits = [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  const spreads = [...block.matchAll(/\.\.\.(\w+)\(\)/g)].map((m) => m[1]);
  const names = [...lits];
  for (const fn of spreads) {
    assert.ok(fn in SPREADS,
      `header spreads ${fn}() — add it to SPREADS in this test so its names are checked too`);
    names.push(...SPREADS[fn]());
  }
  return names;
}

test('every export header name is unique', () => {
  const names = allNames();
  assert.ok(names.length > 100, `only ${names.length} names parsed — the check would be vacuous`);
  const seen = new Map();
  for (const n of names) seen.set(n, (seen.get(n) || 0) + 1);
  const dups = [...seen].filter(([, c]) => c > 1).map(([n, c]) => `'${n}' x${c}`);
  assert.deepEqual(dups, [],
    `duplicate CSV headers: ${dups.join(', ')}. A reader that looks a column up by `
    + 'name gets whichever comes first, so a column reorder silently swaps the measure.');
});

test("plain 'Wetland %' is the land-cover share, and CWIM has its own name", () => {
  assert.match(block, /'Cult %', 'Pasture %', 'Bush %', 'Wetland %', 'Other %'/,
    "the land-cover block must keep the plain 'Wetland %' name — downstream readers ask for it");
  assert.ok(!landfactsCsvHeaders().includes('Wetland %'),
    "landfactsCsvHeaders() must not reuse 'Wetland %' for the CWIM3A share");
  assert.ok(landfactsCsvHeaders().includes('CWIM Wetland %'));
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
