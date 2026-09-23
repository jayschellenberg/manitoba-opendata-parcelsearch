// Tests for lib/salesWater.js — the Sales Charts "Water" tab math, ported
// from the land template's water tabs. Reference values were produced in R:
//   lm(log(rate) ~ log(size) + group) + confint()   for the premium
//   quantile(x, type = 7)                            for ggplot's box
//
// Run: cd web && node test/salesWater.test.js

import assert from 'node:assert/strict';
import {
  saleWaterFacts, boxStats, olsFit, waterPremium, pairedSales, WATER_GROUPS, t95,
} from '../src/lib/salesWater.js';

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }
const close = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

console.log('saleWaterFacts');
test('any waterfront member makes the sale Waterfront', () => {
  const f = saleWaterFacts({
    waters: [{ i: 'No', c: 'Road Separated', t: 'Lake', b: 'X', d: 80 },
      { i: 'Yes', c: 'Direct', t: 'Lake', b: 'Lake Winnipeg', d: 0 }],
    waterLoaded: true, floods: [], floodLoaded: true,
  });
  assert.equal(f.group, 'Waterfront');
  assert.equal(f.cls, 'Direct frontage');
  assert.equal(f.body, 'Lake Winnipeg');
  assert.equal(f.distFt, 0);
  assert.equal(f.flood, 'None');
});
test('near water without frontage, and the three-state rule', () => {
  assert.equal(saleWaterFacts({ waters: [{ c: 'Road Separated' }], waterLoaded: true }).group, 'Near water');
  assert.equal(saleWaterFacts({ waters: [], waterLoaded: true }).group, 'No water');
  assert.equal(saleWaterFacts({ waters: [], waterLoaded: false }).group, null, 'unknown is never "no water"');
  assert.equal(saleWaterFacts({ waters: [], floodLoaded: false }).flood, null);
});
test('the most severe flood zone across members wins', () => {
  const f = saleWaterFacts({ waters: [], waterLoaded: true, floods: [{ z: { LRDFA: 100 } }, { z: { RRVDFA: 40 } }], floodLoaded: true });
  assert.equal(f.flood, 'RRV DFA');
});

console.log('boxStats (ggplot geom_boxplot)');
test('type-7 quartiles, 1.5 IQR whiskers, outliers beyond', () => {
  const b = boxStats([3, 7, 8, 5, 12, 14, 21, 13, 18, 90]);
  close(b.q1, 7.25);
  close(b.median, 12.5);
  close(b.q3, 17);
  assert.equal(b.whiskerLo, 3);
  assert.equal(b.whiskerHi, 21);
  assert.deepEqual(b.outliers, [90]);
  assert.equal(b.n, 10);
});
test('empty input', () => { assert.equal(boxStats([]), null); });

console.log('waterPremium (matches R lm + confint)');
const DATA = [
  [100, 1, 'No water'], [120, 2, 'No water'], [90, 1.5, 'No water'], [110, 3, 'No water'],
  [105, 2.5, 'No water'], [95, 1.2, 'No water'],
  [150, 1, 'Waterfront'], [170, 2, 'Waterfront'], [140, 1.5, 'Waterfront'], [160, 3, 'Waterfront'],
  [115, 1.1, 'Near water'], [125, 2.2, 'Near water'], [118, 1.8, 'Near water'],
].map(([rate, size, group]) => ({ rate, size, group }));
test('premium and 95% range per group', () => {
  const p = waterPremium(DATA);
  const wf = p.groups.find((g) => g.group === 'Waterfront');
  const nw = p.groups.find((g) => g.group === 'Near water');
  close(wf.premium, 0.502826);
  close(wf.lo, 0.346028);
  close(wf.hi, 0.677890);
  close(nw.premium, 0.167676);
  close(nw.lo, 0.034667);
  close(nw.hi, 0.317785);
  close(p.r2, 0.892557);
  assert.equal(p.baseN, 6);
  assert.equal(p.n, 13);
});
test('no dry sales → no premium (nothing to compare against)', () => {
  assert.equal(waterPremium(DATA.filter((r) => r.group !== 'No water')), null);
});
test('t95 matches R qt(0.975, df), exact to 30 and within 1e-3 beyond', () => {
  close(t95(9), 2.262157);
  close(t95(30), 2.042272);
  close(t95(40), 2.021075, 1e-3);
  close(t95(60), 2.000298, 1e-3);
  close(t95(120), 1.979930, 1e-3);
});
test('olsFit refuses a singular design', () => {
  assert.equal(olsFit([[1, 2], [1, 2], [1, 2]], [1, 2, 3]), null);
});

console.log('pairedSales');
test('closest dry sale in size, within half to double', () => {
  const pairs = pairedSales([
    { id: 'w1', size: 2, rate: 150, group: 'Waterfront' },
    { id: 'w2', size: 50, rate: 90, group: 'Waterfront' },   // no dry sale within 25-100
    { id: 'd1', size: 1.1, rate: 100, group: 'No water' },
    { id: 'd2', size: 2.4, rate: 120, group: 'No water' },
    { id: 'n1', size: 2, rate: 130, group: 'Near water' },   // never a pair
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].wet.id, 'w1');
  assert.equal(pairs[0].dry.id, 'd2');
  close(pairs[0].diff, 150 / 120 - 1);
});

test('WATER_GROUPS order is the display order', () => {
  assert.deepEqual(WATER_GROUPS, ['Waterfront', 'Near water', 'No water']);
});

console.log(`\n${passed}/${passed} passed`);
