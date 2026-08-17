// Unit tests for lib/salesDedupe.js — the reconciliation that decides
// which sales-CSV rows are the SAME sale (collapse) and which are a
// parcel's separate transactions (keep both). Regression cover for the
// bug where a Map<roll, record> silently kept only the last sale of any
// repeat-sold parcel, and the count line compared parcels against rows.
//
// Run: cd web && node test/salesDedupe.test.js

import assert from 'node:assert/strict';
import {
  dedupeSalesByRoll, saleSignature, parcelKey,
  expandFeaturesBySale, unmatchedSales,
  uniqueParcelFeatures, dedupeParcelFeaturesForMap,
} from '../src/lib/salesDedupe.js';

// Faithful copies of the main.js / arcgis.js helpers the module injects.
function canonicalRoll(input) {
  if (input == null) return '';
  const s = String(input).trim();
  if (s === '') return '';
  const m = s.match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return s;
  return `${m[1]}.${(m[2] || '').padEnd(3, '0').slice(0, 3)}`;
}
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
function saleDateValue(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  const m = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  let year = parseInt(m[3], 10);
  if (m[3].length === 2) year = (year < 50 ? 2000 : 1900) + year;
  return new Date(year, MONTHS[m[2].toLowerCase()], parseInt(m[1], 10));
}
const helpers = { canonicalRoll, saleDateValue };

function rec(municipality, rollNumber, saleDate, consideration, extra = {}) {
  return { municipality, rollNumber, saleDate, consideration, ...extra };
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

console.log('dedupeSalesByRoll');

test('a parcel sold twice keeps BOTH sales', () => {
  const { salesByRoll, duplicateRows, saleCount } = dedupeSalesByRoll([
    rec('RM OF PINEY', '18000', '08-May-25', '$185,000'),
    rec('RM OF PINEY', '18000', '01-Apr-22', '$172,500'),
  ], helpers);
  assert.equal(saleCount, 2);
  assert.equal(duplicateRows.length, 0);
  assert.deepEqual(
    salesByRoll.get('18000.000').map((r) => r.saleDate),
    ['08-May-25', '01-Apr-22'],
  );
});

test('sales are ordered newest-first regardless of CSV order', () => {
  const { salesByRoll } = dedupeSalesByRoll([
    rec('RM OF STUARTBURN', '186120', '02-Jun-21', '$120,000'),
    rec('RM OF STUARTBURN', '186120', '21-Nov-24', '$155,000'),
    rec('RM OF STUARTBURN', '186120', '02-Feb-23', '$159,000'),
  ], helpers);
  assert.deepEqual(
    salesByRoll.get('186120.000').map((r) => r.saleDate),
    ['21-Nov-24', '02-Feb-23', '02-Jun-21'],
  );
});

test('an exact re-listing collapses to one sale', () => {
  // The real MAO case: a portfolio sale block repeated three times.
  const { salesByRoll, duplicateRows, saleCount } = dedupeSalesByRoll([
    rec('RM OF LA BROQUERIE', '300', '16-Sep-25', '$10,907,000'),
    rec('RM OF LA BROQUERIE', '300', '16-Sep-25', '$10,907,000'),
    rec('RM OF LA BROQUERIE', '300', '16-Sep-25', '$10,907,000'),
  ], helpers);
  assert.equal(saleCount, 1);
  assert.equal(salesByRoll.get('300.000').length, 1);
  assert.equal(duplicateRows.length, 2);
  assert.equal(duplicateRows[0]._dupeOf.saleDate, '16-Sep-25');
});

test('a collapse never loses an N1 ID to an un-stamped first copy', () => {
  // The crosswalk stamps specific archive rows; the un-stamped duplicate can
  // arrive first, and the kept record must still end up carrying the ID.
  const bare    = rec('RM OF LA BROQUERIE', '300', '16-Sep-25', '$10,907,000');
  const stamped = { ...rec('RM OF LA BROQUERIE', '300', '16-Sep-25', '$10,907,000'), n1Id: '31337' };
  const { salesByRoll, saleCount } = dedupeSalesByRoll([bare, stamped], helpers);
  assert.equal(saleCount, 1);
  assert.equal(salesByRoll.get('300.000')[0].n1Id, '31337');
});

test('same roll in DIFFERENT municipalities stays separate', () => {
  // Roll 300.000 exists in most RMs — a bare roll key would merge them.
  const { salesByRoll, duplicateRows } = dedupeSalesByRoll([
    rec('RM OF LA BROQUERIE', '300', '16-Sep-25', '$10,907,000'),
    rec('RM OF PINEY', '300', '16-Sep-25', '$10,907,000'),
  ], helpers);
  // Both share a canonical roll, so they land in one bucket — but as
  // two sales, never collapsed into one.
  assert.equal(duplicateRows.length, 0);
  assert.equal(salesByRoll.get('300.000').length, 2);
});

test('municipality spelling/case/whitespace differences still collapse', () => {
  const { duplicateRows, saleCount } = dedupeSalesByRoll([
    rec('RM OF PINEY', '18000', '08-May-25', '$185,000'),
    rec('rm  of   piney', '18000', '08-May-25', '$185,000'),
  ], helpers);
  assert.equal(saleCount, 1);
  assert.equal(duplicateRows.length, 1);
});

test('same date, different price is two sales (not a re-listing)', () => {
  const { saleCount, duplicateRows } = dedupeSalesByRoll([
    rec('RM OF PINEY', '58700', '17-Sep-21', '$100,000'),
    rec('RM OF PINEY', '58700', '17-Sep-21', '$12,000'),
  ], helpers);
  assert.equal(saleCount, 2);
  assert.equal(duplicateRows.length, 0);
});

test('roll forms 3600 / 3600.0 / 3600.000 are one parcel', () => {
  const { salesByRoll, saleCount } = dedupeSalesByRoll([
    rec('RM OF PINEY', '3600', '08-May-25', '$185,000'),
    rec('RM OF PINEY', '3600.0', '08-May-25', '$185,000'),
    rec('RM OF PINEY', '3600.000', '01-Apr-22', '$172,500'),
  ], helpers);
  assert.equal(saleCount, 2);
  assert.equal(salesByRoll.size, 1);
  assert.equal(salesByRoll.get('3600.000').length, 2);
});

test('sub-rolls are distinct parcels', () => {
  const { salesByRoll } = dedupeSalesByRoll([
    rec('RM OF PINEY', '58700', '18-Jul-23', '$100,000'),
    rec('RM OF PINEY', '58730', '18-Jul-23', '$100,000'),
  ], helpers);
  assert.equal(salesByRoll.size, 2);
  assert.ok(salesByRoll.has('58700.000'));
  assert.ok(salesByRoll.has('58730.000'));
});

test('undated continuation rows collapse against each other', () => {
  // Multi-parcel group members carry the group's blank date+price when
  // the export omitted them; a repeated block must still collapse.
  const { saleCount, duplicateRows } = dedupeSalesByRoll([
    rec('RM OF HANOVER', '21700', '', ''),
    rec('RM OF HANOVER', '21700', '', ''),
  ], helpers);
  assert.equal(saleCount, 1);
  assert.equal(duplicateRows.length, 1);
});

test('undated sales sort after dated ones', () => {
  const { salesByRoll } = dedupeSalesByRoll([
    rec('RM OF PINEY', '900', '', '$1'),
    rec('RM OF PINEY', '900', '01-Apr-22', '$172,500'),
  ], helpers);
  assert.deepEqual(
    salesByRoll.get('900.000').map((r) => r.saleDate),
    ['01-Apr-22', ''],
  );
});

test('blank / junk rolls are skipped entirely', () => {
  const { salesByRoll, saleCount } = dedupeSalesByRoll([
    rec('RM OF PINEY', '', '08-May-25', '$185,000'),
    rec('RM OF PINEY', '   ', '08-May-25', '$185,000'),
  ], helpers);
  assert.equal(saleCount, 0);
  assert.equal(salesByRoll.size, 0);
});

test('empty input is safe', () => {
  const { salesByRoll, duplicateRows, saleCount } = dedupeSalesByRoll([], helpers);
  assert.equal(saleCount, 0);
  assert.equal(salesByRoll.size, 0);
  assert.equal(duplicateRows.length, 0);
});

test('records are returned by reference, not copied', () => {
  // main.js reads groupId / isPrimary / legalDescription off these.
  const a = rec('RM OF PINEY', '18000', '08-May-25', '$185,000', { groupId: 7, isPrimary: true });
  const { salesByRoll } = dedupeSalesByRoll([a], helpers);
  assert.equal(salesByRoll.get('18000.000')[0], a);
});

console.log('\nsaleSignature / parcelKey');

test('saleSignature ignores case and surrounding whitespace', () => {
  assert.equal(
    saleSignature({ saleDate: ' 08-may-25 ', consideration: '$185,000' }),
    saleSignature({ saleDate: '08-MAY-25', consideration: ' $185,000' }),
  );
});

test('saleSignature separates date from price unambiguously', () => {
  assert.notEqual(
    saleSignature({ saleDate: 'a', consideration: 'b|c' }),
    saleSignature({ saleDate: 'a|b', consideration: 'c' }),
  );
});

test('parcelKey includes the municipality', () => {
  assert.notEqual(
    parcelKey({ municipality: 'RM OF PINEY', rollNumber: '300' }, canonicalRoll),
    parcelKey({ municipality: 'RM OF LA BROQUERIE', rollNumber: '300' }, canonicalRoll),
  );
});

console.log('\nexpandFeaturesBySale');

// Minimal stand-in for a Roll_Entry feature.
function parcelFeat(roll, oid, geometry = { type: 'Polygon', coordinates: [[[0, 0]]] }) {
  return { type: 'Feature', geometry, properties: { Roll_No_Txt: roll, OBJECTID: oid } };
}
const stampSale = (p, sale) => { p._saleDate = sale.saleDate; p._salePrice = sale.consideration; };

test('a parcel with one sale yields one feature (the original object)', () => {
  const f = parcelFeat('100.000', 1);
  const salesByRoll = new Map([['100.000', [rec('M', '100', '01-Jan-25', '$1')]]]);
  const out = expandFeaturesBySale([f], salesByRoll, stampSale);
  assert.equal(out.features.length, 1);
  assert.equal(out.features[0], f);          // not cloned
  assert.equal(out.matchedSales, 1);
  assert.deepEqual([...out.matchedRolls], ['100.000']);
});

test('a parcel with three sales yields three features', () => {
  const f = parcelFeat('100.000', 1);
  const salesByRoll = new Map([['100.000', [
    rec('M', '100', '18-Jul-23', '$100,000'),
    rec('M', '100', '17-Sep-21', '$100,000'),
    rec('M', '100', '08-Apr-21', '$12,000'),
  ]]]);
  const out = expandFeaturesBySale([f], salesByRoll, stampSale);
  assert.equal(out.features.length, 3);
  assert.equal(out.matchedSales, 3);
  assert.deepEqual(out.features.map((x) => x.properties._saleDate),
    ['18-Jul-23', '17-Sep-21', '08-Apr-21']);
  assert.deepEqual(out.features.map((x) => x.properties._saleSeq), [0, 1, 2]);
  assert.deepEqual(out.features.map((x) => x.properties._saleCount), [3, 3, 3]);
});

test('clones share geometry but never share the properties object', () => {
  const f = parcelFeat('100.000', 1);
  const salesByRoll = new Map([['100.000', [
    rec('M', '100', '18-Jul-23', '$100,000'),
    rec('M', '100', '17-Sep-21', '$90,000'),
  ]]]);
  const [a, b] = expandFeaturesBySale([f], salesByRoll, stampSale).features;
  assert.equal(a.geometry, b.geometry);           // shared by reference
  assert.notEqual(a.properties, b.properties);    // independent
  assert.equal(a.properties._salePrice, '$100,000');
  assert.equal(b.properties._salePrice, '$90,000');
  // Both keep the parcel's identity — the map dedupes on OBJECTID.
  assert.equal(a.properties.OBJECTID, 1);
  assert.equal(b.properties.OBJECTID, 1);
});

test('the stamp callback receives the parcel full sale list', () => {
  const f = parcelFeat('100.000', 1);
  const sales = [rec('M', '100', '18-Jul-23', '$100,000'), rec('M', '100', '17-Sep-21', '$90,000')];
  const seen = [];
  expandFeaturesBySale([f], new Map([['100.000', sales]]),
    (p, sale, seq, list) => seen.push(list.length));
  assert.deepEqual(seen, [2, 2]);
});

test('parcels with no matching sale are dropped', () => {
  const out = expandFeaturesBySale(
    [parcelFeat('100.000', 1), parcelFeat('999.000', 2)],
    new Map([['100.000', [rec('M', '100', '01-Jan-25', '$1')]]]),
    stampSale,
  );
  assert.equal(out.features.length, 1);
  assert.equal(out.features[0].properties.Roll_No_Txt, '100.000');
});

test('matchedSales counts SALES while matchedRolls counts PARCELS', () => {
  // The exact distinction the old count line got wrong.
  const salesByRoll = new Map([
    ['100.000', [rec('M', '100', '18-Jul-23', '$1'), rec('M', '100', '17-Sep-21', '$2')]],
    ['200.000', [rec('M', '200', '01-Jan-25', '$3')]],
  ]);
  const out = expandFeaturesBySale(
    [parcelFeat('100.000', 1), parcelFeat('200.000', 2)], salesByRoll, stampSale);
  assert.equal(out.matchedSales, 3);
  assert.equal(out.matchedRolls.size, 2);
});

test('empty inputs are safe', () => {
  const out = expandFeaturesBySale([], new Map(), stampSale);
  assert.deepEqual(out.features, []);
  assert.equal(out.matchedSales, 0);
  assert.equal(out.matchedRolls.size, 0);
});

console.log('\nunmatchedSales');

test('reports every sale of an unmatched roll, not just the roll', () => {
  const salesByRoll = new Map([
    ['100.000', [rec('M', '100', '18-Jul-23', '$1')]],
    ['999.000', [rec('M', '999', '01-Jan-25', '$2'), rec('M', '999', '01-Jan-20', '$3')]],
  ]);
  const out = unmatchedSales(salesByRoll, new Set(['100.000']), 'not found');
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.reason === 'not found'));
  assert.deepEqual(out.map((r) => r.saleDate), ['01-Jan-25', '01-Jan-20']);
});

test('matched + unmatched sales reconcile to the deduped total', () => {
  // The arithmetic the count line now depends on.
  const records = [
    rec('M', '100', '18-Jul-23', '$1'),
    rec('M', '100', '17-Sep-21', '$2'),
    rec('M', '100', '17-Sep-21', '$2'),   // exact re-listing
    rec('M', '999', '01-Jan-25', '$3'),   // roll not in Roll_Entry
  ];
  const { salesByRoll, saleCount, duplicateRows } = dedupeSalesByRoll(records, helpers);
  const { matchedRolls, matchedSales } =
    expandFeaturesBySale([parcelFeat('100.000', 1)], salesByRoll, stampSale);
  const unmatched = unmatchedSales(salesByRoll, matchedRolls, 'x');
  assert.equal(duplicateRows.length, 1);
  assert.equal(saleCount, 3);
  assert.equal(matchedSales + unmatched.length, saleCount);
});

console.log('\nuniqueParcelFeatures / dedupeParcelFeaturesForMap');

test('collapses a repeat-sold parcel to one polygon, keeping the first', () => {
  const salesByRoll = new Map([['100.000', [
    rec('M', '100', '18-Jul-23', '$100,000'),
    rec('M', '100', '17-Sep-21', '$90,000'),
  ]]]);
  const { features } = expandFeaturesBySale([parcelFeat('100.000', 1)], salesByRoll, stampSale);
  assert.equal(features.length, 2);
  const unique = uniqueParcelFeatures(features);
  assert.equal(unique.length, 1);
  // The most recent sale is the one drawn, so the popup leads with it.
  assert.equal(unique[0].properties._saleDate, '18-Jul-23');
});

test('returns the same feature objects, so later enrichment is visible', () => {
  const f = parcelFeat('100.000', 1);
  const unique = uniqueParcelFeatures([f, { ...f, properties: { ...f.properties } }]);
  assert.equal(unique[0], f);
  f.properties._acres = 12;                    // enrichment pass, after dedupe
  assert.equal(unique[0].properties._acres, 12);
});

test('features without an OBJECTID pass through rather than being dropped', () => {
  const a = { properties: { Roll_No_Txt: '1.000' } };
  const b = { properties: { Roll_No_Txt: '2.000' } };
  assert.equal(uniqueParcelFeatures([a, b]).length, 2);
});

test('an already-unique collection is returned by reference (free fast path)', () => {
  const fc = { type: 'FeatureCollection', features: [parcelFeat('1.000', 1), parcelFeat('2.000', 2)] };
  assert.equal(dedupeParcelFeaturesForMap(fc), fc);
});

test('a collection with duplicates yields a new collection, original untouched', () => {
  const f = parcelFeat('1.000', 1);
  const fc = { type: 'FeatureCollection', features: [f, { ...f, properties: { ...f.properties } }] };
  const out = dedupeParcelFeaturesForMap(fc);
  assert.notEqual(out, fc);
  assert.equal(out.features.length, 1);
  assert.equal(fc.features.length, 2);
  assert.equal(out.type, 'FeatureCollection');
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
