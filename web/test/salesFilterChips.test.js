// Tests for lib/salesFilterChips.js — the "which Additional filters are
// set" snapshot behind the Sales Analysis warning badge and count-line
// note. One chip per control that is away from its default; `active`
// says whether it is narrowing results right now.
//
// Run: cd web && node test/salesFilterChips.test.js

import assert from 'node:assert/strict';
import {
  salesFilterChips,
  salesFilterChipText,
  rangeLabel,
  VACANT_THRESHOLD_DEFAULT_PCT,
} from '../src/lib/salesFilterChips.js';

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

/** The controls exactly as a fresh page has them. */
function defaults(overrides = {}) {
  return {
    plan: '', streetName: '',
    sizeUom: 'acres', sizeLow: '', sizeHigh: '',
    ppaLow: '', ppaHigh: '', priceLow: '', priceHigh: '',
    zoning: [], zoneCat: [],
    groupSize: 'any', n1: 'any',
    vacantImproved: 'all',
    vacantThreshold: String(VACANT_THRESHOLD_DEFAULT_PCT), vacantMode: 'pct',
    saleAsmtMax: '',
    farFlungKm: '30', farFlungExclude: false,
    subjectRoll: '', hasSubject: false, distanceMax: '',
    ...overrides,
  };
}

const keys = (chips) => chips.map((c) => c.key);

test('a fresh page has nothing set — the default Far-Flung threshold is not a filter', () => {
  assert.deepEqual(salesFilterChips(defaults()), []);
  assert.deepEqual(salesFilterChips({}), []);
  assert.deepEqual(salesFilterChips(), []);
});

test('whitespace-only text inputs are not set', () => {
  assert.deepEqual(salesFilterChips(defaults({ plan: '   ', streetName: '\t' })), []);
});

test('Plan # and Street name each make a chip carrying the typed value', () => {
  const chips = salesFilterChips(defaults({ plan: ' 66600 ', streetName: 'MAIN' }));
  assert.deepEqual(keys(chips), ['plan', 'street']);
  assert.equal(chips[0].label, 'Plan 66600');
  assert.match(chips[0].detail, /contains "66600"/);
  assert.equal(chips[1].label, 'Street MAIN');
  assert.ok(chips.every((c) => c.active));
});

test('size bounds read in the lit unit; both empty is not a filter in Ac or SF', () => {
  assert.deepEqual(salesFilterChips(defaults({ sizeUom: 'sf' })), []);
  const ac = salesFilterChips(defaults({ sizeLow: '10', sizeHigh: '20' }));
  assert.equal(ac[0].label, 'Size 10–20 ac');
  const lo = salesFilterChips(defaults({ sizeLow: '5' }));
  assert.equal(lo[0].label, 'Size ≥ 5 ac');
  const sf = salesFilterChips(defaults({ sizeUom: 'sf', sizeHigh: '8000' }));
  assert.equal(sf[0].label, 'Size ≤ 8000 SF');
  assert.match(sf[0].detail, /square feet/);
});

test('FF is a filter on its own — it drops the area-stated parcels before any bound', () => {
  const bare = salesFilterChips(defaults({ sizeUom: 'ff' }));
  assert.deepEqual(keys(bare), ['size']);
  assert.equal(bare[0].label, 'Frontage (FF) only');
  assert.match(bare[0].detail, /63%/);
  const bounded = salesFilterChips(defaults({ sizeUom: 'ff', sizeLow: '50', sizeHigh: '100' }));
  assert.equal(bounded[0].label, 'Frontage 50–100 ft');
});

test('junk in a number box is treated as empty', () => {
  assert.deepEqual(salesFilterChips(defaults({ sizeLow: 'abc', ppaHigh: '-', priceLow: 'x' })), []);
});

test('$/Ac and Sale Price bounds format as money', () => {
  const chips = salesFilterChips(defaults({ ppaLow: '3000', priceHigh: '2000000' }));
  assert.deepEqual(keys(chips), ['ppa', 'price']);
  assert.equal(chips[0].label, '$/Ac ≥ $3,000');
  assert.equal(chips[1].label, 'Price ≤ $2,000,000');
  const both = salesFilterChips(defaults({ priceLow: '250000', priceHigh: '500000' }));
  assert.equal(both[0].label, 'Price $250,000–$500,000');
});

test('zoning pickers list the ticked values, truncated past three', () => {
  const chips = salesFilterChips(defaults({ zoning: ['R1', 'C2'], zoneCat: ['Commercial'] }));
  assert.deepEqual(keys(chips), ['zoning', 'zoneCat']);
  assert.equal(chips[0].label, 'Zoning R1, C2');
  assert.equal(chips[1].label, 'Zoning type Commercial');
  const many = salesFilterChips(defaults({ zoning: ['A', 'B', 'C', 'D', 'E'] }));
  assert.equal(many[0].label, 'Zoning A, B, C +2');
  assert.match(many[0].detail, /A, B, C, D, E/);
});

test('an empty or non-array picker selection is not set', () => {
  assert.deepEqual(salesFilterChips(defaults({ zoning: null, zoneCat: '' })), []);
  assert.deepEqual(salesFilterChips(defaults({ zoning: ['', '  '] })), []);
});

test('Parcels and N1 selects count when moved off Any', () => {
  const single = salesFilterChips(defaults({ groupSize: 'single' }));
  assert.equal(single[0].label, 'Single parcel');
  const multi = salesFilterChips(defaults({ groupSize: 'multi', n1: 'unmatched' }));
  assert.deepEqual(multi.map((c) => c.label), ['Multi-parcel', 'N1 unmatched']);
  const matched = salesFilterChips(defaults({ n1: 'matched' }));
  assert.equal(matched[0].label, 'N1 matched');
});

test('Bldg Threshold at its default is not set; away from it, it is — idle until Vacant/Improved is picked', () => {
  assert.deepEqual(salesFilterChips(defaults({ vacantThreshold: '5' })), []);
  assert.deepEqual(salesFilterChips(defaults({ vacantThreshold: '5.0' })), []);
  const idle = salesFilterChips(defaults({ vacantThreshold: '10' }));
  assert.equal(idle[0].label, 'Bldg < 10%');
  assert.equal(idle[0].active, false);
  assert.match(idle[0].detail, /no effect until/);
  const live = salesFilterChips(defaults({ vacantThreshold: '10', vacantImproved: 'vacant' }));
  assert.equal(live[0].active, true);
  assert.match(live[0].detail, /Vacant Land Only/);
  const improved = salesFilterChips(defaults({ vacantThreshold: '2', vacantImproved: 'improved' }));
  assert.match(improved[0].detail, /Improved Only/);
});

test('the $ threshold mode is always away from the default', () => {
  const chips = salesFilterChips(defaults({ vacantMode: 'dollar', vacantThreshold: '20000' }));
  assert.equal(chips[0].label, 'Bldg < $20,000');
  assert.equal(chips[0].key, 'vacantThreshold');
});

test('Max Sale/Asmt is set when picked, and only active under Vacant Land Only', () => {
  assert.deepEqual(salesFilterChips(defaults({ saleAsmtMax: '' })), []);
  const idle = salesFilterChips(defaults({ saleAsmtMax: '1.5' }));
  assert.equal(idle[0].label, 'Sale/Asmt ≤ 1.5');
  assert.equal(idle[0].active, false);
  const live = salesFilterChips(defaults({ saleAsmtMax: '1.5', vacantImproved: 'vacant' }));
  assert.equal(live[0].active, true);
});

test('Far-Flung counts only when Exclude is on with a positive threshold', () => {
  assert.deepEqual(salesFilterChips(defaults({ farFlungKm: '15' })), []);
  assert.deepEqual(salesFilterChips(defaults({ farFlungKm: '', farFlungExclude: true })), []);
  assert.deepEqual(salesFilterChips(defaults({ farFlungKm: '0', farFlungExclude: true })), []);
  const chips = salesFilterChips(defaults({ farFlungKm: '15', farFlungExclude: true }));
  assert.equal(chips[0].key, 'farFlung');
  assert.equal(chips[0].label, 'Far-Flung > 15 km excluded');
});

test('Max km with a subject is a radius; without one it is set but idle', () => {
  assert.deepEqual(salesFilterChips(defaults({ hasSubject: true, subjectRoll: '123456' })), []);
  const live = salesFilterChips(defaults({ hasSubject: true, subjectRoll: '123456', distanceMax: '2.5' }));
  assert.equal(live[0].label, 'Within 2.5 km of 123456');
  assert.equal(live[0].active, true);
  const idle = salesFilterChips(defaults({ distanceMax: '2.5' }));
  assert.equal(idle[0].label, 'Max 2.5 km (no subject)');
  assert.equal(idle[0].active, false);
  assert.deepEqual(salesFilterChips(defaults({ distanceMax: '0', hasSubject: true })), []);
});

test('chips come out in control order, top of the disclosure to bottom', () => {
  const chips = salesFilterChips(defaults({
    distanceMax: '1', hasSubject: true, farFlungExclude: true, farFlungKm: '30',
    saleAsmtMax: '2', n1: 'matched', groupSize: 'multi', zoneCat: ['Industrial'],
    zoning: ['M1'], priceLow: '1', ppaLow: '1', sizeLow: '1', streetName: 'A', plan: 'P',
  }));
  assert.deepEqual(keys(chips), [
    'plan', 'street', 'size', 'ppa', 'price', 'zoning', 'zoneCat',
    'groupSize', 'n1', 'saleAsmtMax', 'farFlung', 'distance',
  ]);
});

test('salesFilterChipText joins the labels with a middot', () => {
  const chips = salesFilterChips(defaults({ plan: '1', streetName: 'B' }));
  assert.equal(salesFilterChipText(chips), 'Plan 1 · Street B');
  assert.equal(salesFilterChipText([]), '');
  assert.equal(salesFilterChipText(null), '');
});

test('rangeLabel covers both, either, and neither bound', () => {
  assert.equal(rangeLabel(1, 2, 'ac'), '1–2 ac');
  assert.equal(rangeLabel(1, null, 'ac'), '≥ 1 ac');
  assert.equal(rangeLabel(null, 2, 'ac'), '≤ 2 ac');
  assert.equal(rangeLabel(null, null, 'ac'), '');
  assert.equal(rangeLabel(5, null), '≥ 5');
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
