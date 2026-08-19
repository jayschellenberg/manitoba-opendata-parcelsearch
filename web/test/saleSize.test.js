// Unit tests for src/lib/saleSize.js — resolving the MAO export's at-sale
// Parcel Size columns, and the geometry-trust banding that decides whether
// today's boundary may be drawn for a sale.
//
// The behaviour worth pinning is mostly REFUSAL: a blank size must not fall
// back to today's acreage, a frontage must not become an area, and a verdict
// this build doesn't recognise must not read as "unchanged".
//
// Run: cd web && node test/saleSize.test.js

import assert from 'node:assert/strict';
import {
  resolveSaleSize,
  geometryTrust,
  saleSizeStamp,
  saleAcres,
  saleFrontageFeet,
  saleSizeState,
} from '../src/lib/saleSize.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('saleSize.js — resolveSaleSize');

test('an acres pair yields acres and no frontage', () => {
  const r = resolveSaleSize('160.00', 'ACRES');
  assert.equal(r.acres, 160);
  assert.equal(r.frontageFt, null);
  assert.equal(r.unit, 'ACRES');
});

test('a feet pair yields frontage and no acres', () => {
  const r = resolveSaleSize('110.00', 'FEET');
  assert.equal(r.frontageFt, 110);
  assert.equal(r.acres, null);
  assert.equal(r.unit, 'FEET');
});

test('singular and abbreviated units are accepted', () => {
  assert.equal(resolveSaleSize('5', 'Acre').acres, 5);
  assert.equal(resolveSaleSize('5', 'ac').acres, 5);
  assert.equal(resolveSaleSize('66', 'ft').frontageFt, 66);
});

test('hectares are refused rather than converted', () => {
  // The app has no acreage for a hectare parcel and inventing one by
  // conversion would fabricate an assessor statement that does not exist.
  const r = resolveSaleSize('64.75', 'HECTARES');
  assert.equal(r.acres, null);
  assert.equal(r.frontageFt, null);
  assert.equal(r.unit, null);
});

test('a value without a unit is not a size', () => {
  assert.equal(resolveSaleSize('160.00', '').acres, null);
  assert.equal(resolveSaleSize('160.00', null).acres, null);
});

test('a unit without a value is not a size', () => {
  assert.equal(resolveSaleSize('', 'ACRES').acres, null);
  assert.equal(resolveSaleSize(null, 'ACRES').acres, null);
});

test('thousands separators survive', () => {
  assert.equal(resolveSaleSize('1,280.00', 'ACRES').acres, 1280);
});

test('zero and negative sizes are not sizes', () => {
  assert.equal(resolveSaleSize('0.00', 'ACRES').acres, null);
  assert.equal(resolveSaleSize('-5', 'ACRES').acres, null);
});

test('a stringified null reads as blank, not as an unknown unit', () => {
  assert.equal(resolveSaleSize('<Null>', 'ACRES').acres, null);
  assert.equal(resolveSaleSize('160', '<Null>').acres, null);
});

console.log('\nsaleSize.js — geometryTrust');

test('verified_unchanged is the only confirmed state', () => {
  assert.equal(geometryTrust('verified_unchanged'), 'confirmed');
});

test('a matching legal with no size check is provisional', () => {
  assert.equal(geometryTrust('legal_matches_size_unchecked'), 'provisional');
});

test('every changed signal withholds the boundary', () => {
  for (const sig of ['size_changed', 'legal_changed_size_same',
                     'legal_changed_size_unchecked']) {
    assert.equal(geometryTrust(sig), 'withheld', sig);
  }
});

test('unverifiable withholds — no evidence is not evidence of sameness', () => {
  assert.equal(geometryTrust('unverifiable'), 'withheld');
});

test('an unrecognised signal fails safe to withheld', () => {
  // A verdict a future pipeline emits and this build does not know must not
  // be read as "the parcel is unchanged".
  assert.equal(geometryTrust('some_future_verdict'), 'withheld');
});

test('no signal at all is unknown, not withheld', () => {
  // The pasted-comp-set path makes no claim either way, and must not have one
  // manufactured for it.
  assert.equal(geometryTrust(null), 'unknown');
  assert.equal(geometryTrust(''), 'unknown');
});

console.log('\nsaleSize.js — saleSizeStamp');

test('a record without the column is marked not-known', () => {
  const st = saleSizeStamp({ rollNumber: '300.000' });
  assert.equal(st._saleSizeKnown, false);
  assert.equal(st._geomTrust, 'unknown');
});

test('a record with a value stamps the resolved size', () => {
  const st = saleSizeStamp({
    parcelSize: '160.00', parcelSizeUnit: 'ACRES',
    parcelChange: 'verified_unchanged',
  });
  assert.equal(st._saleSizeKnown, true);
  assert.equal(st._acresAtSale, 160);
  assert.equal(st._frontageAtSaleFt, null);
  assert.equal(st._geomTrust, 'confirmed');
});

test('a record with a BLANK value is known-but-withheld, not unknown', () => {
  // This is the whole point: the pipeline deliberately supplied no size, and
  // that verdict has to survive into the feature.
  const st = saleSizeStamp({
    parcelSize: '', parcelSizeUnit: '', parcelChange: 'size_changed',
  });
  assert.equal(st._saleSizeKnown, true);
  assert.equal(st._acresAtSale, null);
  assert.equal(st._geomTrust, 'withheld');
});

test('a null record stamps the pasted-path defaults', () => {
  const st = saleSizeStamp(null);
  assert.equal(st._saleSizeKnown, false);
  assert.equal(st._geomTrust, 'unknown');
});

console.log('\nsaleSize.js — saleAcres / saleFrontageFeet');

test('an export row uses the at-sale acreage, not today\'s', () => {
  const props = { _saleSizeKnown: true, _acresAtSale: 160, _acres: 40 };
  assert.equal(saleAcres(props), 160);
});

test('a withheld export row yields null even though today\'s acreage exists', () => {
  // The regression this guards: falling back to _acres here reinstates the
  // exact 4x price-per-acre error the pipeline blanked the cell to prevent.
  const props = { _saleSizeKnown: true, _acresAtSale: null, _acres: 40 };
  assert.equal(saleAcres(props), null);
});

test('a pasted row still falls back to today\'s acreage', () => {
  assert.equal(saleAcres({ _saleSizeKnown: false, _acres: 40 }), 40);
  assert.equal(saleAcres({ _acres: 40 }), 40);
});

test('frontage follows the same split', () => {
  assert.equal(saleFrontageFeet({ _saleSizeKnown: true, _frontageAtSaleFt: 110 }), 110);
  assert.equal(saleFrontageFeet({
    _saleSizeKnown: true, _frontageAtSaleFt: null, Frontage_or_Area: '110.00 FEET',
  }), null);
  assert.equal(saleFrontageFeet({ Frontage_or_Area: '110.00 FEET' }), 110);
});

test('the legacy frontage branch still refuses an area row', () => {
  assert.equal(saleFrontageFeet({ Frontage_or_Area: '160.00 ACRES' }), null);
});

test('an acres export row reports no frontage', () => {
  const props = saleSizeStamp({ parcelSize: '160', parcelSizeUnit: 'ACRES' });
  assert.equal(saleFrontageFeet(props), null);
  assert.equal(saleAcres(props), 160);
});

console.log('\nsaleSize.js — saleSizeState');

test('three states, one per source situation', () => {
  assert.equal(saleSizeState({ _acres: 40 }), 'legacy');
  assert.equal(saleSizeState({ _saleSizeKnown: true, _acresAtSale: 160 }), 'resolved');
  assert.equal(saleSizeState({ _saleSizeKnown: true, _frontageAtSaleFt: 110 }), 'resolved');
  assert.equal(saleSizeState({ _saleSizeKnown: true, _acresAtSale: null }), 'withheld');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
