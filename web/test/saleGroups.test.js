// Unit tests for lib/saleGroups.js — the multi-parcel sale rollup math
// (price/acre, price/sf, price/lot, sale-to-assessed ratio, vacancy
// roll-up) and the adjacency-position helper. This is appraisal-facing
// arithmetic that previously had zero coverage.
//
// Run: cd web && node test/saleGroups.test.js

import assert from 'node:assert/strict';
import { computeSaleGroups, groupPosition } from '../src/lib/saleGroups.js';

// Stand-in helpers matching main.js's real ones closely enough for the
// math under test.
// Faithful copy of main.js's parseTotalValue — note the cleaned===''
// guard, without which "N/A" would parse to 0 instead of null.
const parsePrice = (s) => {
  if (s == null || s === '') return null;
  const cleaned = String(s).replace(/[^0-9.]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};
const displayRoll = (raw) => {
  if (raw == null) return '';
  const s = String(raw);
  return s.endsWith('.000') ? s.slice(0, -4) : s;
};
// Simple vacancy stub: vacant when _asmtBuildings is 0; unknown (null)
// when assessment data is missing; otherwise not vacant.
const isVacant = (p) => {
  const total = Number(p?._asmtTotal);
  const bld = Number(p?._asmtBuildings);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(bld) || bld < 0) return null;
  return bld === 0;
};

const helpers = { parsePrice, displayRoll, isVacant };

function feat(props) {
  return { properties: props };
}

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

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

console.log('computeSaleGroups');

test('two-parcel group sums acres + assessed and derives per-unit prices', () => {
  const features = [
    feat({ _saleGroupId: 'g1', OBJECTID: 1, Roll_No_Txt: '100.000', _salePrice: '$200,000', _acres: 4, _asmtTotal: 150000, _asmtBuildings: 0 }),
    feat({ _saleGroupId: 'g1', OBJECTID: 2, Roll_No_Txt: '101.000', _salePrice: '$200,000', _acres: 6, _asmtTotal: 50000, _asmtBuildings: 0 }),
  ];
  const stamp = computeSaleGroups(features, helpers).get('g1');
  assert.equal(stamp._saleGroupSize, 2);
  assert.deepEqual(stamp._saleGroupRollIds, [1, 2]);
  assert.deepEqual(stamp._saleGroupRolls, ['100', '101']);
  assert.equal(stamp._saleGroupTotalPriceNum, 200000);
  assert.equal(stamp._saleGroupTotalAcres, 10);
  assert.ok(approx(stamp._saleGroupPpa, 20000));            // 200000 / 10
  assert.ok(approx(stamp._saleGroupPpsf, 200000 / (10 * 43560)));
  assert.equal(stamp._saleGroupPpl, 100000);               // 200000 / 2 parcels
  assert.equal(stamp._saleGroupAsmtTotal, 200000);
  assert.ok(approx(stamp._saleGroupSaleToAsmt, 1));         // 200000 / 200000
  assert.equal(stamp._saleGroupAllVacant, true);
});

test('missing acres flips acresIncomplete and nulls $/acre + $/sf but not $/lot', () => {
  const features = [
    feat({ _saleGroupId: 'g', OBJECTID: 1, _salePrice: '100000', _acres: 5, _asmtTotal: 1, _asmtBuildings: 0 }),
    feat({ _saleGroupId: 'g', OBJECTID: 2, _salePrice: '100000', _acres: null, _asmtTotal: 1, _asmtBuildings: 0 }),
  ];
  const stamp = computeSaleGroups(features, helpers).get('g');
  assert.equal(stamp._saleGroupAcresIncomplete, true);
  assert.equal(stamp._saleGroupPpa, null);
  assert.equal(stamp._saleGroupPpsf, null);
  assert.equal(stamp._saleGroupPpl, 50000);  // price/lot doesn't need acres
});

test('missing assessment on any member nulls the sale-to-assessed ratio', () => {
  const features = [
    feat({ _saleGroupId: 'g', OBJECTID: 1, _salePrice: '100000', _acres: 1, _asmtTotal: 80000, _asmtBuildings: 0 }),
    feat({ _saleGroupId: 'g', OBJECTID: 2, _salePrice: '100000', _acres: 1, _asmtTotal: null, _asmtBuildings: null }),
  ];
  const stamp = computeSaleGroups(features, helpers).get('g');
  assert.equal(stamp._saleGroupAsmtIncomplete, true);
  assert.equal(stamp._saleGroupSaleToAsmt, null);
});

test('vacancy roll-up: all-vacant true only when every member is vacant', () => {
  const allVac = computeSaleGroups([
    feat({ _saleGroupId: 'g', OBJECTID: 1, _salePrice: '1', _acres: 1, _asmtTotal: 100, _asmtBuildings: 0 }),
    feat({ _saleGroupId: 'g', OBJECTID: 2, _salePrice: '1', _acres: 1, _asmtTotal: 100, _asmtBuildings: 0 }),
  ], helpers).get('g');
  assert.equal(allVac._saleGroupAllVacant, true);
  assert.equal(allVac._saleGroupVacantUnknown, false);

  const oneImproved = computeSaleGroups([
    feat({ _saleGroupId: 'g', OBJECTID: 1, _salePrice: '1', _acres: 1, _asmtTotal: 100, _asmtBuildings: 0 }),
    feat({ _saleGroupId: 'g', OBJECTID: 2, _salePrice: '1', _acres: 1, _asmtTotal: 100, _asmtBuildings: 60 }),
  ], helpers).get('g');
  assert.equal(oneImproved._saleGroupAllVacant, false);
  assert.equal(oneImproved._saleGroupVacantUnknown, false);
});

test('vacancy unknown when a member lacks assessment data', () => {
  const stamp = computeSaleGroups([
    feat({ _saleGroupId: 'g', OBJECTID: 1, _salePrice: '1', _acres: 1, _asmtTotal: 100, _asmtBuildings: 0 }),
    feat({ _saleGroupId: 'g', OBJECTID: 2, _salePrice: '1', _acres: 1, _asmtTotal: null, _asmtBuildings: null }),
  ], helpers).get('g');
  assert.equal(stamp._saleGroupAllVacant, false);
  assert.equal(stamp._saleGroupVacantUnknown, true);
});

test('unparseable / zero price nulls every price-derived field', () => {
  const stamp = computeSaleGroups([
    feat({ _saleGroupId: 'g', OBJECTID: 1, _salePrice: 'N/A', _acres: 5, _asmtTotal: 100, _asmtBuildings: 0 }),
  ], helpers).get('g');
  assert.equal(stamp._saleGroupTotalPriceNum, null);
  assert.equal(stamp._saleGroupPpa, null);
  assert.equal(stamp._saleGroupPpsf, null);
  assert.equal(stamp._saleGroupPpl, null);
  assert.equal(stamp._saleGroupSaleToAsmt, null);
});

test('features without a sale-group id are skipped', () => {
  const stamps = computeSaleGroups([
    feat({ OBJECTID: 1, _salePrice: '100' }),
    feat({ _saleGroupId: 'g', OBJECTID: 2, _salePrice: '100', _acres: 1, _asmtTotal: 1, _asmtBuildings: 0 }),
  ], helpers);
  assert.equal(stamps.size, 1);
  assert.ok(stamps.has('g'));
});

test('empty / nullish input yields an empty map', () => {
  assert.equal(computeSaleGroups([], helpers).size, 0);
  assert.equal(computeSaleGroups(null, helpers).size, 0);
});

console.log('\ngroupPosition');

test('first / middle / last across three adjacent siblings', () => {
  assert.equal(groupPosition(null, 'g', 'g'), 'first');
  assert.equal(groupPosition('g', 'g', 'g'), 'middle');
  assert.equal(groupPosition('g', 'g', null), 'last');
});

test('solo when neither neighbour shares the group', () => {
  assert.equal(groupPosition('a', 'g', 'b'), 'solo');
  assert.equal(groupPosition(null, 'g', null), 'solo');
});

test('a different adjacent group does not count as a sibling', () => {
  assert.equal(groupPosition('other', 'g', 'g'), 'first');
  assert.equal(groupPosition('g', 'g', 'other'), 'last');
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
