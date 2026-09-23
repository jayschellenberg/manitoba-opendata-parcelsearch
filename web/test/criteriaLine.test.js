// Tests for lib/criteriaLine.js — the chart subtitle's criteria line.
//
// Run: cd web && node test/criteriaLine.test.js

import assert from 'node:assert/strict';
import { criteriaText } from '../src/lib/criteriaLine.js';

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMonYear = (ms) => { const d = new Date(ms); return `${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };
const fmtNum = (v) => v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 2 : 0 });
const SPAN = {
  dist: [2.5, 40],
  size: [0.3, 12],
  date: [Date.UTC(2018, 0, 5), Date.UTC(2026, 7, 1)],
};
const base = {
  adjusted: false, unitKey: 'acres', unitWord: 'acres', refTitle: 'Subject', refIsSubject: true,
  span: SPAN, fmtMonYear, fmtNum,
};

console.log('criteriaText');
test('open filters fall back to the span of the sales', () => {
  assert.equal(criteriaText({ ...base, criteria: {} }),
    'CMS; 2.5-40 km from Subject; 0.3-12 acres; Jan-2018 to Aug-2026');
});
test('set filters are stated, as the template states its CMS bounds', () => {
  assert.equal(criteriaText({
    ...base, adjusted: true,
    criteria: { dateFrom: '2021-01-01', dateTo: '2026-09-22', sizeUom: 'acres', sizeLow: '1', sizeHigh: '10', distanceMax: '35' },
  }), 'CMS (Time-Adjusted); 0-35 km from Subject; 1-10 acres; Jan-2021 to Sep-2026');
});
test('one-sided bounds', () => {
  const t = criteriaText({ ...base, criteria: { sizeUom: 'acres', sizeLow: '5', dateFrom: '2022-03-01' } });
  assert.match(t, /; 5\+ acres; /);
  assert.match(t, /Mar-2022 to Aug-2026$/, 'an open end still comes from the sales');
  assert.match(criteriaText({ ...base, criteria: { sizeUom: 'acres', sizeHigh: '2' } }), /; 0-2 acres; /);
});
test('acres convert to square feet; frontage never mixes with area', () => {
  assert.match(criteriaText({ ...base, unitKey: 'sf', unitWord: 'sq ft', criteria: { sizeUom: 'acres', sizeLow: '1', sizeHigh: '2' } }),
    /; 43,560-87,120 sq ft; /);
  // An area filter says nothing about a frontage chart: fall back to the span.
  assert.match(criteriaText({ ...base, unitKey: 'ff', unitWord: 'ft frontage', criteria: { sizeUom: 'acres', sizeLow: '1', sizeHigh: '2' } }),
    /; 0.3-12 ft frontage; /);
});
test('the distance filter is from the subject, so it is not stated for Winnipeg', () => {
  const t = criteriaText({ ...base, refTitle: 'Winnipeg', refIsSubject: false, criteria: { distanceMax: '35' } });
  assert.match(t, /^CMS; 2.5-40 km from Winnipeg; /);
});
test('no criteria object at all behaves as all-open', () => {
  assert.equal(criteriaText({ ...base, criteria: null }),
    'CMS; 2.5-40 km from Subject; 0.3-12 acres; Jan-2018 to Aug-2026');
});

console.log(`\n${passed}/${passed} passed`);
