// Tests for the land template's CMS tools on the Sales Charts tab
// (2026-09-22): the percentile trim (CMS2), the sale/assessment review
// flag, sale records carrying their grid keys and excluded state, the
// filter waterfall, and the PNG helpers.
//
// Run: cd web && node test/salesChartsCms.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  quantile7, percentileTrim, saleAsmtFlag, saleRecordsFromRows, TRIM_MIN_SALES, saleAgFacts,
} from '../src/lib/salesCharts.js';
import { buildSalesWaterfall } from '../src/lib/salesWaterfall.js';
import { wrapText, slugify } from '../src/lib/chartRender.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

console.log('quantile7 (R type 7)');
test('matches R quantile(1:10, c(.05, .5, .95))', () => {
  const xs = [10, 3, 1, 8, 2, 9, 4, 7, 6, 5];
  close(quantile7(xs, 0.05), 1.45);
  close(quantile7(xs, 0.5), 5.5);
  close(quantile7(xs, 0.95), 9.55);
});
test('ends and degenerate input', () => {
  assert.equal(quantile7([4, 2, 9], 0), 2);
  assert.equal(quantile7([4, 2, 9], 1), 9);
  assert.equal(quantile7([7], 0.3), 7);
  assert.equal(quantile7([], 0.5), null);
  // Nulls are missing, not zero.
  assert.equal(quantile7([null, 5, null], 0.5), 5);
});

console.log('percentileTrim (CMS2)');
const recs = (vals) => vals.map((v, i) => ({ saleId: `s${i}`, ppa: v }));
test('drops the tails of the band, inclusive of the quantiles', () => {
  const r = recs([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100]);
  const t = percentileTrim(r, 'ppa', 5, 95);
  assert.equal(t.applied, true);
  // n=11: h = 10p. q05 = 1 + 0.5·(2−1) = 1.5; q95 = 10 + 0.5·(100−10) = 55
  // (R: quantile(c(1:10, 100), c(.05, .95)) → 1.5, 55). Drops 1 and 100.
  close(t.qLo, 1.5);
  close(t.qHi, 55);
  assert.equal(t.removed, 2);
  assert.ok(!t.keep.has('s0') && !t.keep.has('s10') && t.keep.has('s1'));
});
test(`does nothing below ${TRIM_MIN_SALES} sales (the template's nrow > 5)`, () => {
  const t = percentileTrim(recs([1, 2, 3, 4, 500]), 'ppa', 5, 95);
  assert.equal(t.applied, false);
  assert.equal(t.keep.size, 5);
  assert.equal(t.removed, 0);
});
test('sales without the measure are not counted toward the minimum', () => {
  const r = [...recs([1, 2, 3, 4, 5]), { saleId: 'x', ppa: null }, { saleId: 'y' }];
  assert.equal(percentileTrim(r, 'ppa', 5, 95).applied, false);
});
test('an inverted or out-of-range band does not trim', () => {
  const r = recs([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(percentileTrim(r, 'ppa', 95, 5).applied, false);
  assert.equal(percentileTrim(r, 'ppa', -1, 95).applied, false);
  assert.equal(percentileTrim(r, 'ppa', 5, 101).applied, false);
});

console.log('saleAsmtFlag (PossibleOutlier)');
test('the template tiers, worst label wins', () => {
  assert.equal(saleAsmtFlag(0.05), 'Nominal');
  assert.equal(saleAsmtFlag(0.10), 'Very low');   // < 0.10 is Nominal; 0.10 is not
  assert.equal(saleAsmtFlag(0.2), 'Very low');
  assert.equal(saleAsmtFlag(0.25), 'Low');
  assert.equal(saleAsmtFlag(0.49), 'Low');
  assert.equal(saleAsmtFlag(0.5), '');
  assert.equal(saleAsmtFlag(1.0), '');
  assert.equal(saleAsmtFlag(2.5), '');            // > 2.50 is High; 2.50 is not
  assert.equal(saleAsmtFlag(2.51), 'High');
});
test('no ratio is "No assessment", never a grade', () => {
  for (const v of [null, undefined, '', NaN, 0, -1]) assert.equal(saleAsmtFlag(v), 'No assessment');
});

console.log('saleRecordsFromRows — keys and excluded');
const row = (props) => ({ parcel: { properties: props } });
const g = (id, seq, extra = {}) => row({
  _saleGroupId: id, _saleSeq: seq, _saleDate: '2025-01-01', _saleGroupTotalPriceNum: 100000,
  _saleGroupSize: 2, Roll_No_Txt: `R${id}${seq}`, ...extra,
});
const keyOf = (r) => `${r.parcel.properties.Roll_No_Txt}#${r.parcel.properties._saleSeq}`;
test('every member row key rides on the sale record', () => {
  const [rec] = saleRecordsFromRows([g(1, 0), g(1, 1)], { rowKey: keyOf, isSelected: () => true });
  assert.deepEqual(rec.keys, ['R10#0', 'R11#1']);
  assert.equal(rec.excluded, false);
});
test('excluded only when EVERY member row is unticked', () => {
  const off = new Set(['R10#0']);
  const sel = (r) => !off.has(keyOf(r));
  let [rec] = saleRecordsFromRows([g(1, 0), g(1, 1)], { rowKey: keyOf, isSelected: sel });
  assert.equal(rec.excluded, false, 'one member still ticked keeps the sale in');
  off.add('R11#1');
  [rec] = saleRecordsFromRows([g(1, 0), g(1, 1)], { rowKey: keyOf, isSelected: sel });
  assert.equal(rec.excluded, true);
});
test('without the new deps it behaves as before (nothing excluded)', () => {
  const [rec] = saleRecordsFromRows([g(1, 0)]);
  assert.equal(rec.excluded, false);
  assert.deepEqual(rec.keys, []);
});

console.log('saleRecordsFromRows — front feet');
test('$/FF and per-lot frontage ride through from the sale group', () => {
  const props = {
    _saleGroupId: 7, _saleSeq: 0, _saleDate: '2025-01-01', _saleGroupTotalPriceNum: 240000,
    _saleGroupSize: 2, _saleGroupTotalFrontageFt: 120, _saleGroupPpff: 2000,
  };
  const [rec] = saleRecordsFromRows([row(props), row({ ...props, _saleSeq: 1 })]);
  assert.equal(rec.ppff, 2000);
  assert.equal(rec.lotFrontFt, 60, 'per lot = group frontage / parcel count, like lotAcres');
});
test('an incomplete group frontage gives no lot frontage and no $/FF', () => {
  const [rec] = saleRecordsFromRows([row({
    _saleGroupId: 8, _saleDate: '2025-01-01', _saleGroupTotalPriceNum: 240000,
    _saleGroupSize: 2, _saleGroupTotalFrontageFt: 60, _saleGroupFrontageIncomplete: true,
    _saleGroupPpff: null,
  })]);
  assert.equal(rec.lotFrontFt, null);
  assert.equal(rec.ppff, null);
});

console.log('saleRecordsFromRows — review-flag basis');
const bare = (extra = {}) => ({
  _saleGroupId: 9, _saleDate: '2021-05-01', _saleGroupTotalPriceNum: 90000, _saleGroupSize: 1,
  _saleTypeGroup: 'RESIDENTIAL BARE LAND', _saleGroupSaleToAsmt: 0.18, _asmtLand: 100000, ...extra,
});
test('a bare-land sale is graded against the LAND assessment', () => {
  // Sold bare for $90k; today's total includes a house (ratio 0.18), land is $100k.
  const [rec] = saleRecordsFromRows([row(bare())]);
  assert.equal(rec.flagBasis, 'land');
  close(rec.flagRatio, 0.9);
  assert.equal(saleAsmtFlag(rec.flagRatio), '', 'not flagged once the house is out of the ratio');
  assert.equal(rec.saleToAsmt, 0.18, 'the grid ratio itself is untouched');
});
test('an improved sale keeps the total basis', () => {
  const [rec] = saleRecordsFromRows([row(bare({ _saleTypeGroup: 'RESIDENTIAL LAND AND BUILDINGS' }))]);
  assert.equal(rec.flagBasis, 'total');
  assert.equal(rec.flagRatio, 0.18);
});
test('a bare-land assembly missing a member land value falls back to total', () => {
  const a = bare({ _saleGroupSize: 2, _saleSeq: 0 });
  const b = bare({ _saleGroupSize: 2, _saleSeq: 1, _asmtLand: null });
  const [rec] = saleRecordsFromRows([row(a), row(b)]);
  assert.equal(rec.flagBasis, 'total');
});

console.log('saleAgFacts (the template collapses parcels to a sale)');
test('categories take the value covering the most acres; cover is acre-weighted', () => {
  const f = saleAgFacts([
    { masc: 'C', cli: '3W', soil: 'Red River', soilLoaded: true, cover: { cult: 1, past: 0, bush: 0, wet: 0, other: 0 }, coverLabel: 'Cultivated', acres: 120 },
    { masc: 'F', cli: '5T', soil: 'Osborne', soilLoaded: true, cover: { cult: 0, past: 0, bush: 1, wet: 0, other: 0 }, coverLabel: 'Bush/Treed', acres: 40 },
  ]);
  assert.equal(f.masc, 'C');
  assert.equal(f.cli, '3W');
  assert.equal(f.cliClass, '3', 'the class is the leading digit, as the template');
  assert.equal(f.soil, 'Red River');
  assert.equal(f.coverLabel, 'Cultivated');
  assert.equal(f.cover.cult, 0.75);
  assert.equal(f.cover.bush, 0.25);
  assert.equal(f.soilLoaded, true);
});
test('soil not joined on any member reads as not loaded, not as "no soil"', () => {
  const f = saleAgFacts([{ masc: 'B', soilLoaded: true, acres: 1 }, { masc: 'B', soilLoaded: false, acres: 1 }]);
  assert.equal(f.soilLoaded, false);
  assert.equal(f.cover, null);
});

console.log('buildSalesWaterfall');
const LABELS = ['Municipality', 'Size range', 'Sale date range'];
test('counts SALES, crediting each to the step its last row fell at', () => {
  // Sale A: two rows, both dropped by Size range (1).
  // Sale B: one row dropped by Municipality (0).
  // Sale C: two rows — one passes — so the sale survives.
  // Sale D: row 1 dropped at Municipality, row 2 at Sale date → gone at step 2.
  const rows = [
    { g: 'A', s: 1 }, { g: 'A', s: 1 },
    { g: 'B', s: 0 },
    { g: 'C', s: 2 }, { g: 'C', s: -1 },
    { g: 'D', s: 0 }, { g: 'D', s: 2 },
  ];
  const wf = buildSalesWaterfall(rows, (i) => rows[i].s, LABELS, (r) => r.g);
  assert.equal(wf.loaded, 4);
  assert.equal(wf.remaining, 1);
  assert.deepEqual(wf.steps, [
    { label: 'Municipality', removed: 1, remaining: 3 },
    { label: 'Size range', removed: 1, remaining: 2 },
    { label: 'Sale date range', removed: 1, remaining: 1 },
  ]);
});
test('steps that removed nothing are left out; ungrouped rows count alone', () => {
  const rows = [{ g: null, s: -1 }, { g: null, s: 2 }];
  const wf = buildSalesWaterfall(rows, (i) => rows[i].s, LABELS, (r) => r.g);
  assert.equal(wf.loaded, 2);
  assert.equal(wf.remaining, 1);
  assert.deepEqual(wf.steps.map((s) => s.label), ['Sale date range']);
});

console.log('PNG helpers');
test('slugify makes a file stem', () => {
  assert.equal(slugify('Price per acre by lot size'), 'price-per-acre-by-lot-size');
  assert.equal(slugify('Total price against assessed value (1:1)'), 'total-price-against-assessed-value-1-1');
  assert.equal(slugify(''), 'chart');
});
test('wrapText never loses a word and respects the budget', () => {
  const s = 'Rates carried to 2026-09-22 at the fitted trend (+$1.23 per day, fitted on the 5th–95th percentile set).';
  const lines = wrapText(s, 11, 200);
  assert.equal(lines.join(' '), s);
  const maxChars = Math.floor(200 / (11 * 0.55));
  for (const l of lines) assert.ok(l.length <= maxChars || !l.includes(' '), l);
});

console.log('main.js filter labels (source check)');
test('every fail(...) label in the sales filter pass is a SALES_FILTER_STEPS entry', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(dir, '../src/main.js'), 'utf8')
    // Comments out first — prose that mentions a label is not a call.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const stepsBlock = /const SALES_FILTER_STEPS = \[([\s\S]*?)\];/.exec(src);
  assert.ok(stepsBlock, 'SALES_FILTER_STEPS not found');
  const steps = new Set([...stepsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const fnStart = src.indexOf('function filterCsvRowsByOtherSearches(');
  const fnEnd = src.indexOf('function isZoningChanged(', fnStart);
  const body = src.slice(fnStart, fnEnd);
  const used = [...body.matchAll(/fail\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 25, `expected the pass to be instrumented, found ${used.length} fail() calls`);
  const unknown = used.filter((l) => !steps.has(l));
  assert.deepEqual(unknown, [], 'labels missing from SALES_FILTER_STEPS');
  // And no filter still exits without saying which one it was.
  const bare = (body.match(/return false;/g) || []).length;
  assert.equal(bare, 1, 'only fail() itself may return false');
  // The waterfall is actually built from the pass.
  assert.ok(/lastSalesWaterfall = buildSalesWaterfall\(/.test(body), 'waterfall not built in the pass');
});
test('the charts tab can reach the grid: set-excluded is handled', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(/type === 'set-excluded'\) applyChartsExclusion\(/.test(main), 'main window ignores set-excluded');
  const charts = readFileSync(path.join(dir, '../src/charts/main.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(/type: 'set-excluded'/.test(charts), 'charts tab never sends set-excluded');
  assert.ok(/onPointClick: opts\.frozen \? null : onPointClick/.test(charts), 'charts never pass the click handler');
});

console.log(`\n${passed}/${passed} passed`);
