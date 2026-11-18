// Key-fields sales export: every key column must exist in the full export by
// the same name, and the picker must keep header and cells aligned.
//
// WHY THIS EXISTS. The key file is a by-name subset of the full export
// (lib/salesKeyExport.js). Rename a full-export column — 'Group $/Acre' to
// 'Group $/ac', say — and the picker skips it: the key file just loses a
// column, with only a console warning. This test turns that into a failure.
// It reads main.js as text because exportCsv touches the DOM.
//
// Run: cd web && node test/salesKeyExport.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_SALES_COLUMNS, keyColumnIndexes, pickColumns } from '../src/lib/salesKeyExport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// The export header literal: from `const header = [` holding 'Roll #', 'Muni #'
// to the geometry tail that closes it.
const fn = src.slice(src.indexOf('function exportCsv('));
const hStart = fn.indexOf('const header = [');
const hEnd = fn.indexOf("'Lat', 'Lon', 'Geometry (WKT)',", hStart);
const block = fn.slice(hStart, hEnd + 40)
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const literals = [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
// Stand-in for csvAssessHeader(), the one computed name the list relies on.
const fullHeader = ['Map #', ...literals, 'Assess-2026 ($)'];

console.log('salesKeyExport.js — key-fields export');

test('header block was found', () => {
  assert.ok(hStart >= 0 && hEnd > hStart && literals.length > 100, `${literals.length} literals`);
});

test('every key column exists in the full export under the same name', () => {
  const { missing } = keyColumnIndexes(fullHeader);
  assert.deepEqual(missing, []);
});

test('key columns come out in list order with no duplicates', () => {
  const { idx } = keyColumnIndexes(fullHeader);
  assert.equal(idx.length, KEY_SALES_COLUMNS.length);
  assert.equal(new Set(idx).size, idx.length);
  const picked = pickColumns(fullHeader, idx);
  assert.equal(picked[0], 'Map #');
  assert.equal(picked[picked.indexOf('Asmt Class') + 1], 'Asmt Report URL');
});

test('assessment header matches with or without a year', () => {
  for (const h of ['Assess-2026 ($)', 'Assessment ($)']) {
    const { idx } = keyColumnIndexes(['Roll #', h]);
    assert.equal(idx.length, 2, h);
  }
});

test('Map # absent (numbering off) is skipped silently, cells stay aligned', () => {
  const header = ['Roll #', 'Junk', 'Sale Price'];
  const { idx, missing } = keyColumnIndexes(header, ['Map #', 'Sale Price', 'Roll #']);
  assert.deepEqual(missing, []);
  assert.deepEqual(pickColumns(['111', 'x', '500000'], idx), ['500000', '111']);
});

test('full export: sale block sits right after the legal group', () => {
  const sd = literals.indexOf('Sale Date');
  assert.equal(literals[sd - 1], 'MAO Legal Source URL');
  assert.ok(sd < literals.indexOf('Zoning 1 Code'));
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
