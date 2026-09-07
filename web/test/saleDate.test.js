// Tests for lib/saleDate.js — the Sale Date parse and the grid's sort key.
//
// The bug these pin: the results grid sorted the Sale Date column as the raw
// string it displays. export_sales_for_web.R writes that column as
// "Aug 06, 2026", so a string sort ordered every sale by MONTH NAME
// alphabetically — Apr, Aug, Dec, Feb, Jan… — with the year ignored entirely.
//
// Run: cd web && node test/saleDate.test.js

import assert from 'node:assert/strict';
import { parseSaleDate, saleDateSortKey } from '../src/lib/saleDate.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

/** Local-midnight y/m/d, matching what the parser is expected to build. */
const ymd = (y, m, d) => new Date(y, m - 1, d).getTime();

console.log('parseSaleDate');

test('parses the export format, "Mmm DD, YYYY"', () => {
  assert.equal(parseSaleDate('Aug 06, 2026').getTime(), ymd(2026, 8, 6));
  assert.equal(parseSaleDate('Jun 29, 2026').getTime(), ymd(2026, 6, 29));
  assert.equal(parseSaleDate('Dec 31, 2025').getTime(), ymd(2025, 12, 31));
});

test('accepts full month names, a trailing dot, and a missing comma', () => {
  assert.equal(parseSaleDate('August 6, 2026').getTime(), ymd(2026, 8, 6));
  assert.equal(parseSaleDate('Sept 3, 2020').getTime(),   ymd(2020, 9, 3));
  assert.equal(parseSaleDate('Mar. 5, 2021').getTime(),   ymd(2021, 3, 5));
  assert.equal(parseSaleDate('Jan 2 2019').getTime(),     ymd(2019, 1, 2));
});

test('parses the hand-pasted MAO format, "DD-Mmm-YY"', () => {
  assert.equal(parseSaleDate('30-Jan-26').getTime(), ymd(2026, 1, 30));
  assert.equal(parseSaleDate('1-Apr-19').getTime(),  ymd(2019, 4, 1));
});

test('two-digit years use the 50-year sliding window', () => {
  assert.equal(parseSaleDate('1-Jan-49').getTime(), ymd(2049, 1, 1));
  assert.equal(parseSaleDate('1-Jan-50').getTime(), ymd(1950, 1, 1));
  assert.equal(parseSaleDate('1-Jan-99').getTime(), ymd(1999, 1, 1));
});

test('parses ISO dates at LOCAL midnight, not UTC', () => {
  // new Date('2026-01-30') is UTC midnight, which is the 29th anywhere west
  // of Greenwich — that would put the sale-date range bounds a day out.
  assert.equal(parseSaleDate('2026-01-30').getTime(), ymd(2026, 1, 30));
});

test('returns null for empty and unparseable input', () => {
  assert.equal(parseSaleDate(null), null);
  assert.equal(parseSaleDate(undefined), null);
  assert.equal(parseSaleDate(''), null);
  assert.equal(parseSaleDate('   '), null);
  assert.equal(parseSaleDate('not a date'), null);
  assert.equal(parseSaleDate('Foo 06, 2026'), null);   // month-shaped, not a month
});

console.log('saleDateSortKey');

test('orders by the instant, not by the month name', () => {
  // The exact set that used to come out alphabetically: as strings these sort
  // Apr < Aug < Dec, which is neither their chronological order nor close to it.
  const raw = ['Dec 01, 2019', 'Apr 27, 2026', 'Aug 06, 2021'];
  const sorted = [...raw].sort((a, b) => saleDateSortKey(a) - saleDateSortKey(b));
  assert.deepEqual(sorted, ['Dec 01, 2019', 'Aug 06, 2021', 'Apr 27, 2026']);
  // …and the old behaviour, for contrast.
  assert.deepEqual([...raw].sort(), ['Apr 27, 2026', 'Aug 06, 2021', 'Dec 01, 2019']);
});

test('orders within a month by day, and across the year boundary', () => {
  const raw = ['Jan 31, 2025', 'Jan 02, 2025', 'Dec 31, 2024', 'Feb 01, 2025'];
  const sorted = [...raw].sort((a, b) => saleDateSortKey(a) - saleDateSortKey(b));
  assert.deepEqual(sorted, ['Dec 31, 2024', 'Jan 02, 2025', 'Jan 31, 2025', 'Feb 01, 2025']);
});

test('mixes the two source formats in one ordering', () => {
  // A pasted comp set and a shard-loaded region can share a grid.
  const raw = ['Aug 06, 2026', '30-Jan-26', 'Dec 01, 2025', '1-Apr-19'];
  const sorted = [...raw].sort((a, b) => saleDateSortKey(a) - saleDateSortKey(b));
  assert.deepEqual(sorted, ['1-Apr-19', 'Dec 01, 2025', '30-Jan-26', 'Aug 06, 2026']);
});

test('undated rows get the grid\'s numeric blank sentinel', () => {
  // sortRows() treats -Infinity as "blank" and parks those rows at the
  // bottom in BOTH directions — so they must not read as the oldest sale.
  assert.equal(saleDateSortKey(null), -Infinity);
  assert.equal(saleDateSortKey(''), -Infinity);
  assert.equal(saleDateSortKey('not a date'), -Infinity);
  assert.ok(saleDateSortKey('Jan 01, 1900') > -Infinity);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
