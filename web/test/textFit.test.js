// lib/textFit.js — exhibit labels wrap before they shrink, and never run
// past their width (the Addenda zoning map's CentrePort label ran off the
// image, 2026-11-05). Also the legend's long-label wrap in mapLegend.js.
//
// Run: cd web && node test/textFit.test.js

import assert from 'node:assert/strict';
import { fitText, balancedWrap, greedyWrap, phrases } from '../src/lib/textFit.js';
import { layoutMapLegends, paintMapLegends, LEGEND_MAX_WIDTH_RATIO } from '../src/lib/mapLegend.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// Every character is 0.51 em wide: what the 600-weight system sans measured
// on the real Rosser 91418.300 zoning map (about 17 px a character at 33 px).
const measure = (t, px) => t.length * px * 0.51;

const CENTREPORT = 'Zoning Map — Inland Port Special Planning Area (CentrePort), Manitoba Regulation 48/2016 '
  + '(registered March 8, 2016), as amended by 10/2021';
const PINEY = 'Zoning Map — Rural Municipality of Piney By-law 7-2019 (effective March 4, 2019)';

// The corner label on a 1950 px Addenda map: 33 px type, about 1,740 px
// between the left edge and the north arrow, and a 1,364 px wrap target.
const W = 1740;
const WRAP = 1364;

test('a label that fits stays on one line at full size', () => {
  assert.deepEqual(fitText(PINEY, { font: 33, maxWidth: W, measure }), { font: 33, lines: [PINEY], fits: true });
});

test('a label slightly too long shrinks a little and stays on one line', () => {
  const t = 'x'.repeat(108); // 108 * 33 * .51 = 1818 > 1740, at 29 px = 1597
  const fit = fitText(t, { font: 33, maxWidth: W, measure });
  assert.equal(fit.lines.length, 1);
  assert.ok(fit.font < 33 && fit.font >= 29, `font ${fit.font}`);
});

test('the CentrePort label wraps into two balanced lines at full size', () => {
  const fit = fitText(CENTREPORT, { font: 33, maxWidth: W, wrapWidth: WRAP, measure });
  assert.equal(fit.font, 33);
  assert.equal(fit.lines.length, 2);
  assert.equal(fit.lines.join(' '), CENTREPORT, 'no words lost or reordered');
  for (const l of fit.lines) assert.ok(measure(l, 33) <= WRAP, `line too wide: ${l}`);
  // Broken at the clause, not inside "Manitoba Regulation".
  assert.equal(fit.lines[0], 'Zoning Map — Inland Port Special Planning Area (CentrePort),');
  assert.ok(fit.lines[1].startsWith('Manitoba Regulation 48/2016'));
});

test('phrase breaks: after a clause comma or before a dash, never inside a date', () => {
  assert.deepEqual(phrases(CENTREPORT), [
    'Zoning Map',
    '— Inland Port Special Planning Area (CentrePort),',
    'Manitoba Regulation 48/2016 (registered March 8, 2016),',
    'as amended by 10/2021',
  ]);
});

test('phrase breaks give way when they would cost an extra line', () => {
  const narrow = 1200; // "Manitoba Regulation … 10/2021" (78 chars) no longer fits on one line
  const fit = fitText(CENTREPORT, { font: 33, maxWidth: W, wrapWidth: narrow, measure });
  assert.equal(fit.lines.length, 2);
  assert.equal(fit.font, 33);
  for (const l of fit.lines) assert.ok(measure(l, 33) <= narrow, l);
});

test('a phrase too long for the width falls back to word wrap', () => {
  const fit = fitText(CENTREPORT, { font: 33, maxWidth: 700, measure });
  for (const l of fit.lines) assert.ok(measure(l, fit.font) <= 700, l);
  assert.equal(fit.lines.join(' '), CENTREPORT);
});

test('text needing more than maxLines shrinks until it fits', () => {
  const t = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const fit = fitText(t, { font: 33, maxWidth: 600, measure, maxLines: 3 });
  assert.ok(fit.lines.length <= 3 || !fit.fits);
  assert.ok(fit.font >= Math.floor(33 * 0.7), 'never below the floor');
});

test('when even the floor does not fit, fits is false (caller condenses)', () => {
  const t = Array.from({ length: 200 }, () => 'word').join(' ');
  const fit = fitText(t, { font: 33, maxWidth: 300, measure, maxLines: 2 });
  assert.equal(fit.fits, false);
  assert.equal(fit.font, Math.floor(33 * 0.7));
});

test('empty text lays out to nothing', () => {
  assert.deepEqual(fitText('  ', { font: 20, maxWidth: 100, measure }).lines, []);
  assert.deepEqual(balancedWrap('', 100, measure, 20), []);
});

test('greedy wrap keeps an over-long word on its own line', () => {
  assert.deepEqual(greedyWrap(['a', 'b'.repeat(50), 'c'], 100, measure, 10), ['a', 'b'.repeat(50), 'c']);
});

test('balanced wrap avoids a one-word orphan', () => {
  const words = 'one two three four five six seven eight nine ten eleven';
  const greedy = greedyWrap(words.split(' '), measure(words, 10) * 0.92, measure, 10);
  const balanced = balancedWrap(words, measure(words, 10) * 0.92, measure, 10);
  assert.equal(greedy.length, 2);
  assert.equal(balanced.length, 2);
  assert.ok(greedy[1].split(' ').length === 1, 'greedy leaves an orphan (premise)');
  assert.ok(balanced[1].split(' ').length > 3, `balanced spreads it: ${balanced[1]}`);
});

// ---- legend rows -------------------------------------------------------------

const lMeasure = (t) => t.length * 7;
const lopts = { width: 1000, height: 800, bottomY: 760, font: 12, measure: lMeasure };
const longLabel = 'RRE – Residential - Rural Residential Zone - Escarpment and a long qualifier for the test';

test('a legend label wider than the box wraps onto a second row', () => {
  const [box] = layoutMapLegends([{ title: 'Zoning code', items: [
    { color: 'rgb(1,1,1)', label: 'AG – Agricultural' },
    { color: 'rgb(2,2,2)', label: longLabel },
  ] }], lopts);
  assert.equal(box.items[1].lines.length, 2);
  assert.equal(box.items[1].lines.join(' '), longLabel);
  assert.ok(box.w <= Math.ceil(1000 * LEGEND_MAX_WIDTH_RATIO));
  const { rowH, padY } = box.metrics;
  assert.equal(box.h, padY * 2 + rowH * (1 + 1 + 2), 'title + one row + two rows');
});

test('wrapped rows are painted line by line, inside the box', () => {
  const boxes = layoutMapLegends([{ title: '', items: [{ color: 'rgb(2,2,2)', label: longLabel }] }], lopts);
  const calls = [];
  const ctx = { set font(v) {}, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set textBaseline(v) {},
    fillRect() {}, strokeRect() {}, fillText(...a) { calls.push(a); } };
  paintMapLegends(ctx, boxes, { font: 12, bodyFont: 'b', titleFont: 't' });
  assert.equal(calls.length, 2);
  for (const [, x, , maxW] of calls) assert.ok(x + maxW <= boxes[0].x + boxes[0].w, 'line stays inside the box');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
