// Unit tests for lib/saleGroups.js — the multi-parcel sale rollup math
// (price/acre, price/sf, price/lot, sale-to-assessed ratio, vacancy
// roll-up) and the adjacency-position helper. This is appraisal-facing
// arithmetic that previously had zero coverage.
//
// Run: cd web && node test/saleGroups.test.js

import assert from 'node:assert/strict';
import {
  computeSaleGroups, groupPosition, maxPairwiseKm,
  isFarFlungSale, farFlungReason, DEFAULT_FAR_FLUNG_KM,
} from '../src/lib/saleGroups.js';
import { parcelCentrePoint } from '../src/lib/geometryText.js';

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

// Faithful copy of main.js's haversineKm, which takes {lat, lng}.
const distanceKm = (a, b) => {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lng - a.lng) * rad;
  const sa = Math.sin(dLat / 2);
  const sb = Math.sin(dLon / 2);
  const c = sa * sa + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * sb * sb;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(c)));
};

const helpers = {
  parsePrice, displayRoll, isVacant,
  centroid: parcelCentrePoint,
  distanceKm,
};

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
  // One member KNOWN to carry buildings makes the sale improved.
  assert.equal(oneImproved._saleGroupAnyImproved, true);
});

test('vacancy unknown when a member lacks assessment data', () => {
  const stamp = computeSaleGroups([
    feat({ _saleGroupId: 'g', OBJECTID: 1, _salePrice: '1', _acres: 1, _asmtTotal: 100, _asmtBuildings: 0 }),
    feat({ _saleGroupId: 'g', OBJECTID: 2, _salePrice: '1', _acres: 1, _asmtTotal: null, _asmtBuildings: null }),
  ], helpers).get('g');
  assert.equal(stamp._saleGroupAllVacant, false);
  assert.equal(stamp._saleGroupVacantUnknown, true);
  // [vacant, unknown] is neither known-vacant nor known-improved:
  // the improved flag must NOT be the complement of all-vacant, or
  // unknown-data sales would leak into "Improved only".
  assert.equal(stamp._saleGroupAnyImproved, false);
});

test('all-vacant group is not improved', () => {
  const stamp = computeSaleGroups([
    feat({ _saleGroupId: 'g', OBJECTID: 1, _salePrice: '1', _acres: 1, _asmtTotal: 100, _asmtBuildings: 0 }),
  ], helpers).get('g');
  assert.equal(stamp._saleGroupAllVacant, true);
  assert.equal(stamp._saleGroupAnyImproved, false);
});

test('improved + unknown member still reads improved', () => {
  // The unknown member cannot un-know the building on the other one.
  const stamp = computeSaleGroups([
    feat({ _saleGroupId: 'g', OBJECTID: 1, _salePrice: '1', _acres: 1, _asmtTotal: 100, _asmtBuildings: 60 }),
    feat({ _saleGroupId: 'g', OBJECTID: 2, _salePrice: '1', _acres: 1, _asmtTotal: null, _asmtBuildings: null }),
  ], helpers).get('g');
  assert.equal(stamp._saleGroupAllVacant, false);
  assert.equal(stamp._saleGroupVacantUnknown, true);
  assert.equal(stamp._saleGroupAnyImproved, true);
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

console.log('\nmaxPairwiseKm');

// ~1 degree of latitude ≈ 111 km; used to keep the expected values
// easy to reason about.
const at = (lat, lng) => ({ lat, lng });

test('returns the widest gap, not the first or last one', () => {
  // Deliberately ordered so a naive first-to-last or consecutive-pairs
  // implementation would return the wrong answer.
  const pts = [at(49, -97), at(50, -97), at(49.5, -97)];
  const d = maxPairwiseKm(pts, distanceKm);
  assert.ok(Math.abs(d - 111.19) < 1, `expected ~111 km, got ${d}`);
});

test('needs two points to mean anything', () => {
  assert.equal(maxPairwiseKm([], distanceKm), null);
  assert.equal(maxPairwiseKm([at(49, -97)], distanceKm), null);
  assert.equal(maxPairwiseKm(null, distanceKm), null);
});

test('two coincident parcels span zero', () => {
  assert.equal(maxPairwiseKm([at(49, -97), at(49, -97)], distanceKm), 0);
});

console.log('\nsale-group spread');

// A tiny square polygon centred on the given point, so parcelCentrePoint
// returns that point back.
function parcelAt(props, lat, lng) {
  const d = 0.001;
  return {
    properties: props,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lng - d, lat - d], [lng + d, lat - d],
        [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d],
      ]],
    },
  };
}

test('a single-parcel sale spans 0 km', () => {
  const stamp = computeSaleGroups(
    [parcelAt({ _saleGroupId: 'g1', OBJECTID: 1, Municipality: '600 - RM OF PINEY' }, 49, -97)],
    helpers,
  ).get('g1');
  assert.equal(stamp._saleGroupSpanKm, 0);
  assert.equal(stamp._saleGroupSpanIncomplete, false);
  assert.equal(stamp._saleGroupMuniCount, 1);
});

test('a tight assembly spans a small distance', () => {
  const stamp = computeSaleGroups([
    parcelAt({ _saleGroupId: 'g1', OBJECTID: 1, Municipality: '600 - RM OF PINEY' }, 49.00, -97),
    parcelAt({ _saleGroupId: 'g1', OBJECTID: 2, Municipality: '600 - RM OF PINEY' }, 49.02, -97),
  ], helpers).get('g1');
  assert.ok(stamp._saleGroupSpanKm > 1 && stamp._saleGroupSpanKm < 4,
    `expected ~2 km, got ${stamp._saleGroupSpanKm}`);
});

test('a far-flung portfolio sale spans a large distance', () => {
  const stamp = computeSaleGroups([
    parcelAt({ _saleGroupId: 'g1', OBJECTID: 1, Municipality: '600 - RM OF PINEY' }, 49.0, -97.0),
    parcelAt({ _saleGroupId: 'g1', OBJECTID: 2, Municipality: '601 - RM OF ARMSTRONG' }, 50.5, -97.0),
  ], helpers).get('g1');
  assert.ok(stamp._saleGroupSpanKm > 150, `expected >150 km, got ${stamp._saleGroupSpanKm}`);
  assert.equal(stamp._saleGroupMuniCount, 2);
});

test('a member without geometry marks the span incomplete, not wrong', () => {
  // The span is computed from the parcels that DO have geometry, but
  // flagged so it is never treated as a trustworthy cutoff.
  const stamp = computeSaleGroups([
    parcelAt({ _saleGroupId: 'g1', OBJECTID: 1, Municipality: '600 - RM OF PINEY' }, 49.0, -97.0),
    parcelAt({ _saleGroupId: 'g1', OBJECTID: 2, Municipality: '600 - RM OF PINEY' }, 49.1, -97.0),
    { properties: { _saleGroupId: 'g1', OBJECTID: 3, Municipality: '600 - RM OF PINEY' } },
  ], helpers).get('g1');
  assert.equal(stamp._saleGroupSpanIncomplete, true);
  assert.ok(Number.isFinite(stamp._saleGroupSpanKm));
});

test('a MULTI-parcel sale with only one usable centroid spans null, not 0', () => {
  // The distinction that matters: "not spread out" and "we cannot tell"
  // must never collapse, or the eventual filter would keep a portfolio
  // sale on the strength of missing data.
  const stamp = computeSaleGroups([
    parcelAt({ _saleGroupId: 'g1', OBJECTID: 1, Municipality: '600 - RM OF PINEY' }, 49, -97),
    { properties: { _saleGroupId: 'g1', OBJECTID: 2, Municipality: '600 - RM OF PINEY' } },
  ], helpers).get('g1');
  assert.equal(stamp._saleGroupSpanKm, null);
  assert.equal(stamp._saleGroupSpanIncomplete, true);
});

test('municipality count is distinct, not a member count', () => {
  const stamp = computeSaleGroups([
    parcelAt({ _saleGroupId: 'g1', OBJECTID: 1, Municipality: '600 - RM OF PINEY' }, 49.0, -97),
    parcelAt({ _saleGroupId: 'g1', OBJECTID: 2, Municipality: '600 - RM OF PINEY' }, 49.1, -97),
    parcelAt({ _saleGroupId: 'g1', OBJECTID: 3, Municipality: '601 - RM OF HANOVER' }, 49.2, -97),
  ], helpers).get('g1');
  assert.equal(stamp._saleGroupSize, 3);
  assert.equal(stamp._saleGroupMuniCount, 2);
});

test('spread stamps are absent-safe when helpers are not injected', () => {
  // computeSaleGroups is called from one place today, but the older
  // three-helper call shape must not throw if it resurfaces.
  const stamp = computeSaleGroups(
    [parcelAt({ _saleGroupId: 'g1', OBJECTID: 1 }, 49, -97), parcelAt({ _saleGroupId: 'g1', OBJECTID: 2 }, 50, -97)],
    { parsePrice, displayRoll, isVacant },
  ).get('g1');
  assert.equal(stamp._saleGroupSpanKm, null);
  assert.equal(stamp._saleGroupMuniCount, 0);
});

console.log('\nisFarFlungSale');

test('flags a sale wider than the threshold', () => {
  assert.equal(isFarFlungSale({ _saleGroupSpanKm: 48.4 }, 30), true);
});

test('spares an assembly inside the threshold', () => {
  // The real calibration boundary: ordinary assemblies topped out at
  // 8.4 km, portfolio sales started at 48.4 km.
  assert.equal(isFarFlungSale({ _saleGroupSpanKm: 8.4 }, 30), false);
});

test('is a strict comparison at the boundary', () => {
  assert.equal(isFarFlungSale({ _saleGroupSpanKm: 30 }, 30), false);
  assert.equal(isFarFlungSale({ _saleGroupSpanKm: 30.1 }, 30), true);
});

test('a single-parcel sale (span 0) is never far-flung', () => {
  assert.equal(isFarFlungSale({ _saleGroupSpanKm: 0 }, 30), false);
});

test('FAILS OPEN on unknown spread', () => {
  // The safety property: this predicate will drive removal of comps in
  // phase 3, so missing geometry must never cause an exclusion.
  assert.equal(isFarFlungSale({ _saleGroupSpanKm: null }, 30), false);
  assert.equal(isFarFlungSale({}, 30), false);
  assert.equal(isFarFlungSale(null, 30), false);
  assert.equal(isFarFlungSale({ _saleGroupSpanKm: NaN }, 30), false);
});

test('still judges an incomplete span that already exceeds the threshold', () => {
  // An incomplete span can only UNDERSTATE the true spread, so if the
  // measurable part is already over the line, the whole sale is too.
  assert.equal(
    isFarFlungSale({ _saleGroupSpanKm: 245, _saleGroupSpanIncomplete: true }, 30),
    true,
  );
});

test('a blank / zero / negative threshold turns flagging off', () => {
  assert.equal(isFarFlungSale({ _saleGroupSpanKm: 500 }, null), false);
  assert.equal(isFarFlungSale({ _saleGroupSpanKm: 500 }, 0), false);
  assert.equal(isFarFlungSale({ _saleGroupSpanKm: 500 }, -5), false);
  assert.equal(isFarFlungSale({ _saleGroupSpanKm: 500 }, NaN), false);
});

test('the shipped default sits in the calibrated gap', () => {
  // Between the widest ordinary assembly and the tightest portfolio
  // sale seen in the source export.
  assert.ok(DEFAULT_FAR_FLUNG_KM > 8.4 && DEFAULT_FAR_FLUNG_KM < 48.4);
});

console.log('\nfarFlungReason');

test('names the span, the muni count and the threshold', () => {
  const why = farFlungReason(
    { _saleGroupSpanKm: 245.6, _saleGroupMuniCount: 5 }, 30,
  );
  assert.match(why, /246 km/);
  assert.match(why, /5 municipalities/);
  assert.match(why, /30 km/);
});

test('omits the muni clause for a single-muni sale', () => {
  const why = farFlungReason({ _saleGroupSpanKm: 60, _saleGroupMuniCount: 1 }, 30);
  assert.ok(!/municipalit/.test(why), why);
});

test('discloses when the span is only a lower bound', () => {
  const why = farFlungReason(
    { _saleGroupSpanKm: 60, _saleGroupMuniCount: 2, _saleGroupSpanIncomplete: true }, 30,
  );
  assert.match(why, /at least/);
});

test('is empty for a sale that is not flagged', () => {
  assert.equal(farFlungReason({ _saleGroupSpanKm: 5 }, 30), '');
  assert.equal(farFlungReason({ _saleGroupSpanKm: null }, 30), '');
  assert.equal(farFlungReason({ _saleGroupSpanKm: 500 }, null), '');
});

console.log('\n$/frontage foot');

// Frontage_or_Area is a hybrid field — ~63% of Manitoba parcels state an
// area and ~37% a frontage — so the interesting cases are all about
// refusing to compute a rate when the frontage only covers part of the
// land being paid for.

test('single parcel stating a frontage gets a $/FF', () => {
  const features = [
    feat({ _saleGroupId: 'g1', OBJECTID: 1, Roll_No_Txt: '1.000', _salePrice: '$220,000',
           _acres: 0.25, Frontage_or_Area: '110.00 FEET' }),
  ];
  const stamp = computeSaleGroups(features, helpers).get('g1');
  assert.equal(stamp._saleGroupTotalFrontageFt, 110);
  assert.equal(stamp._saleGroupFrontageIncomplete, false);
  assert.ok(approx(stamp._saleGroupPpff, 2000));            // 220000 / 110
});

test('a parcel stating ACRES yields no frontage and no rate', () => {
  const features = [
    feat({ _saleGroupId: 'g1', OBJECTID: 1, Roll_No_Txt: '1.000', _salePrice: '$500,000',
           _acres: 160, Frontage_or_Area: '160.00 ACRES' }),
  ];
  const stamp = computeSaleGroups(features, helpers).get('g1');
  assert.equal(stamp._saleGroupTotalFrontageFt, 0);
  assert.equal(stamp._saleGroupFrontageIncomplete, true);
  assert.equal(stamp._saleGroupPpff, null, 'an area is not a frontage');
  // The acres rates are unaffected — the two halves of the hybrid field
  // must not interfere with each other.
  assert.ok(approx(stamp._saleGroupPpa, 500000 / 160));
});

test('multi-parcel sale sums frontage when EVERY parcel states one', () => {
  const features = [
    feat({ _saleGroupId: 'g1', OBJECTID: 1, Roll_No_Txt: '1.000', _salePrice: '$300,000',
           _acres: 0.2, Frontage_or_Area: '50.00 FEET' }),
    feat({ _saleGroupId: 'g1', OBJECTID: 2, Roll_No_Txt: '2.000', _salePrice: '$300,000',
           _acres: 0.4, Frontage_or_Area: '100.00 FEET' }),
  ];
  const stamp = computeSaleGroups(features, helpers).get('g1');
  assert.equal(stamp._saleGroupTotalFrontageFt, 150);
  assert.equal(stamp._saleGroupFrontageIncomplete, false);
  assert.ok(approx(stamp._saleGroupPpff, 2000));            // 300000 / 150
});

test('MIXED sale withholds the rate rather than roughly doubling it', () => {
  // The case the strict guard exists for: half the land being paid for has
  // a knowable frontage. 300000/110 = $2,727/ft would look like a plausible
  // number and be about double the truth.
  const features = [
    feat({ _saleGroupId: 'g1', OBJECTID: 1, Roll_No_Txt: '1.000', _salePrice: '$300,000',
           _acres: 0.25, Frontage_or_Area: '110.00 FEET' }),
    feat({ _saleGroupId: 'g1', OBJECTID: 2, Roll_No_Txt: '2.000', _salePrice: '$300,000',
           _acres: 5, Frontage_or_Area: '5.00 ACRES' }),
  ];
  const stamp = computeSaleGroups(features, helpers).get('g1');
  assert.equal(stamp._saleGroupFrontageIncomplete, true);
  assert.equal(stamp._saleGroupPpff, null);
  // The total is still reported, so the export can distinguish "mixed
  // sale, rate withheld" from "no frontage anywhere".
  assert.equal(stamp._saleGroupTotalFrontageFt, 110);
});

test('a missing or junk Frontage_or_Area is not a zero-foot frontage', () => {
  for (const raw of [undefined, null, '', '<Null>', 'FEET', '0.00 FEET']) {
    const features = [
      feat({ _saleGroupId: 'g1', OBJECTID: 1, Roll_No_Txt: '1.000', _salePrice: '$100,000',
             _acres: 1, Frontage_or_Area: raw }),
    ];
    const stamp = computeSaleGroups(features, helpers).get('g1');
    assert.equal(stamp._saleGroupPpff, null, `${JSON.stringify(raw)} must not produce a rate`);
    assert.equal(stamp._saleGroupFrontageIncomplete, true);
  }
});

test('no sale price means no rate, even with a good frontage', () => {
  const features = [
    feat({ _saleGroupId: 'g1', OBJECTID: 1, Roll_No_Txt: '1.000', _salePrice: 'N/A',
           _acres: 0.25, Frontage_or_Area: '110.00 FEET' }),
  ];
  const stamp = computeSaleGroups(features, helpers).get('g1');
  assert.equal(stamp._saleGroupTotalFrontageFt, 110, 'the frontage still totals');
  assert.equal(stamp._saleGroupPpff, null);
});

test('frontage totalling is independent of the acres guard', () => {
  // Acres incomplete must not suppress $/FF, and vice versa — they are
  // separate statements about separate figures.
  const features = [
    feat({ _saleGroupId: 'g1', OBJECTID: 1, Roll_No_Txt: '1.000', _salePrice: '$200,000',
           Frontage_or_Area: '50.00 FEET' }),                 // no _acres at all
    feat({ _saleGroupId: 'g1', OBJECTID: 2, Roll_No_Txt: '2.000', _salePrice: '$200,000',
           _acres: 0.5, Frontage_or_Area: '50.00 FEET' }),
  ];
  const stamp = computeSaleGroups(features, helpers).get('g1');
  assert.equal(stamp._saleGroupAcresIncomplete, true);
  assert.equal(stamp._saleGroupPpa, null, 'acres rate correctly withheld');
  assert.equal(stamp._saleGroupFrontageIncomplete, false);
  assert.ok(approx(stamp._saleGroupPpff, 2000), 'frontage rate still computed');
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
