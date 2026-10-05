// Unit tests for src/lib/salesWaterfall.js — the filtered-sales note on the
// upload status line, built from the filter waterfall.
//
// Run: cd web && node test/salesWaterfall.test.js

import assert from 'node:assert/strict';
import { buildSalesWaterfall, filteredSalesNote } from '../src/lib/salesWaterfall.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const LABELS = ['Municipality', 'Nominal sales', 'Far-flung sales'];
// Eight single-parcel sales; five nominal, one far-flung.
const rows = Array.from({ length: 8 }, (_, i) => ({ id: i }));
const stepOf = (i) => (i < 5 ? 1 : i === 5 ? 2 : -1);

test('nominal-only case names the filter and the count', () => {
  const w = buildSalesWaterfall(rows, (i) => (i < 5 ? 1 : -1), LABELS, null);
  assert.equal(filteredSalesNote(w), ' · 5 of 8 sales hidden by filters (nominal sales: 5)');
});

test('several filters are listed in evaluation order', () => {
  const w = buildSalesWaterfall(rows, stepOf, LABELS, null);
  assert.equal(filteredSalesNote(w), ' · 6 of 8 sales hidden by filters (nominal sales: 5, far-flung sales: 1)');
});

test('counts sales, not rows: a two-parcel nominal sale counts once', () => {
  const r = [{ g: 'a' }, { g: 'a' }, { g: 'b' }];
  const w = buildSalesWaterfall(r, (i) => (i < 2 ? 1 : -1), LABELS, (row) => row.g);
  assert.equal(filteredSalesNote(w), ' · 1 of 2 sales hidden by filters (nominal sales: 1)');
});

test('nothing hidden, or no waterfall yet: no note', () => {
  assert.equal(filteredSalesNote(buildSalesWaterfall(rows, () => -1, LABELS, null)), '');
  assert.equal(filteredSalesNote(null), '');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
