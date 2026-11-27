// Assessment history: change-point expansion, reassessment rows, trend,
// summary text and the SVG. Run: cd web && node test/assessmentHistory.test.js

import assert from 'node:assert/strict';
import { expandHistory, valueInYear, changeRows, cagr, historySummary, historySvg, rollYear } from '../src/lib/assessmentHistory.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('assessment history');

// Biennial reassessments, frozen in between; last year repeats the value.
const pts = [[2008, 50000, 100000], [2010, 60000, 110000], [2012, 60000, 150000], [2014, 80000, 160000], [2017, 80000, 160000]];
const s = expandHistory(pts);

test('change points carry forward to a full yearly series', () => {
  assert.deepEqual(s.map((r) => r.year), [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017]);
  assert.equal(valueInYear(s, 2011).total, 170000);
  assert.equal(valueInYear(s, 2016).total, 240000);
  assert.equal(valueInYear(s, 2030), null);
});

test('unsorted input and junk rows are tolerated', () => {
  assert.deepEqual(expandHistory([[2010, 1, 1], null, [2008, 1, 0]]).map((r) => r.year), [2008, 2009, 2010]);
  assert.deepEqual(expandHistory(null), []);
});

test('change rows are the reassessments, with percentage change', () => {
  const rows = changeRows(s);
  assert.deepEqual(rows.map((r) => r.year), [2010, 2012, 2014]);
  assert.ok(Math.abs(rows[0].pct - 13.333) < 0.01);
});

test('compound annual change', () => {
  const g = cagr(s, 2008, 2016);
  assert.ok(Math.abs(g - 6.05) < 0.01, `got ${g}`);   // 150k -> 240k over 8 years
  assert.equal(cagr(s, 2016, 2008), null);
});

test('summary line names the latest change and the trend', () => {
  assert.equal(historySummary(s), '+14% in 2014 · +5.4%/yr since 2008');
  assert.equal(historySummary(expandHistory([[2027, 1, 1]])), '');
});

test('svg has one land and one building bar per year and no NaN', () => {
  const svg = historySvg(s);
  assert.equal((svg.match(/<rect /g) || []).length, 2 * s.length + 2);   // + 2 legend swatches
  assert.ok(!svg.includes('NaN'));
  assert.ok(historySvg(s, { compact: true }).startsWith('<svg'));
  assert.equal(historySvg([]), '');
});

test('roll year from Asmt_Roll text, else the snapshot date', () => {
  assert.equal(rollYear('2027 Spring Preliminary Assessment Roll', '2026-07-01'), 2027);
  assert.equal(rollYear('', '2025-02-12'), 2025);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
