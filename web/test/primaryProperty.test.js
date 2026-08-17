// Unit tests for lib/primaryProperty.js — the two-layer Primary Property
// taxonomy (family -> subcategory) behind the Sales Analysis filter.
//
// The cases below are not invented: every descriptor string here is one MAO
// actually ships, taken from the 2026-08-16 archive. The ones worth pinning
// down are the collisions — strings that match two rules, where only the
// ORDER decides the answer, and where getting it wrong loses rows silently.
//
// Run: cd web && node test/primaryProperty.test.js

import assert from 'node:assert/strict';
import {
  NO_STRUCTURE,
  OTHER_SUBCATEGORY,
  UNCATEGORIZED,
  familyOf,
  inferFamily,
  subcategoryOf,
  optionKey,
  rowOptionKey,
  primaryPropertyTree,
  matchingSaleGroupIds,
  rowPassesPrimaryProperty,
} from '../src/lib/primaryProperty.js';

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

console.log('familyOf — Sale Type Group is authoritative');

test('each Sale Type Group maps to its family', () => {
  assert.equal(familyOf('RESIDENTIAL LAND AND BUILDINGS', ''), 'Residential');
  assert.equal(familyOf('RESIDENTIAL BARE LAND', ''), 'Residential');
  assert.equal(familyOf('RESIDENTIAL CONDOMINIUM UNITS', ''), 'Residential');
  assert.equal(familyOf('ICI LAND AND BUILDINGS', ''), 'ICI');
  assert.equal(familyOf('ICI BARE LAND', ''), 'ICI');
  assert.equal(familyOf('FARM LAND AND BUILDINGS', ''), 'Farm');
  assert.equal(familyOf('FARM BARE LAND', ''), 'Farm');
  assert.equal(familyOf('UNCATEGORIZED', ''), UNCATEGORIZED);
});

test('the type column beats the descriptor, even when they disagree', () => {
  // An apartment descriptor under a RESIDENTIAL sale type stays Residential.
  // Inference alone would say ICI, which is why the column has to win: the
  // Sale Type filter a few rows away in the same sidebar says Residential.
  assert.equal(familyOf('RESIDENTIAL LAND AND BUILDINGS', '2-3 STY FRAME APT NO BSMT'), 'Residential');
  // ...and the converse: MAO files apartment blocks as ICI, so a garage
  // descriptor under an ICI type is ICI.
  assert.equal(familyOf('ICI LAND AND BUILDINGS', 'GARAGE AVG QUAL DOUBL DET'), 'ICI');
});

test('case and stray whitespace do not change the family', () => {
  assert.equal(familyOf('  ici land and buildings ', ''), 'ICI');
  assert.equal(familyOf('Farm  Bare   Land', ''), 'Farm');
});

console.log('\ninferFamily — the paste path, where there is no type column');

test('apartments infer as ICI, ahead of the residential storey markers', () => {
  // "2-3 STY FRAME APT" carries STY. If the residential rule ran first this
  // would be Residential, contradicting MAO's own classification.
  assert.equal(inferFamily('2-3 STY FRAME APT NO BSMT'), 'ICI');
  assert.equal(inferFamily('4-6 STOREY APARTMENT'), 'ICI');
});

test('farm buildings infer as Farm despite carrying "STOREY"', () => {
  assert.equal(inferFamily('1 STOREY HOG BARN'), 'Farm');
  assert.equal(inferFamily('1 STOREY DAIRY BARN'), 'Farm');
  assert.equal(inferFamily('GRAIN BIN-FL BOT,STL'), 'Farm');
});

test('the two machine-shop families stay apart', () => {
  // Farm and ICI both have machine shops, spelled differently. A bare
  // /MACH/ marker would pull the ICI one into Farm.
  assert.equal(inferFamily('ARCH RIB MACHINE SHOP'), 'Farm');
  assert.equal(inferFamily('STEEL QUONSET MACH. SHED'), 'Farm');
  assert.equal(inferFamily('POLE TYPE MACHINE SHOP'), 'ICI');
});

test('"1 STOREY FRAME WORKSHOP" is not read as a store', () => {
  // STORE(?!Y): without the lookahead, "STOREY" matches the ICI store rule
  // and this farm workshop lands in the wrong family.
  assert.equal(inferFamily('1 STOREY FRAME WORKSHOP'), 'Farm');
});

test('ordinary houses infer as Residential', () => {
  assert.equal(inferFamily('1 STY RES AVG QUALITY'), 'Residential');
  assert.equal(inferFamily('1STY/2STY GOOD QUAL 2X6'), 'Residential');
  assert.equal(inferFamily('BI LEV AVG GD Q 2X6 RO HS'), 'Residential');
  assert.equal(inferFamily('MOBILE HOME AVG QLTY'), 'Residential');
});

test("MAO's own catch-alls infer as Uncategorized rather than guessing", () => {
  assert.equal(inferFamily('OTHER'), UNCATEGORIZED);
  assert.equal(inferFamily('CODE/TYPE NO LONGER USED'), UNCATEGORIZED);
  assert.equal(inferFamily(''), UNCATEGORIZED);
  assert.equal(inferFamily(null), UNCATEGORIZED);
});

test('a mobile home PARK is ICI, a mobile HOME is Residential', () => {
  assert.equal(inferFamily('MOBILE HOME PARK'), 'ICI');
  assert.equal(inferFamily('MOBILE HOME AVG QLTY 2X6'), 'Residential');
});

console.log('\nsubcategoryOf — rule order is load-bearing');

test('row housing beats the storey rules', () => {
  // Every one of these also matches a storey rule. Row housing must win or
  // the townhouse rows disappear into One storey and the entry never fires.
  assert.equal(subcategoryOf('Residential', '1 STY AVG Q 2X6 ROW HSG'), 'Row housing / townhouse');
  assert.equal(subcategoryOf('Residential', '2 STY AVG Q ROW HOUSING'), 'Row housing / townhouse');
  assert.equal(subcategoryOf('Residential', '1STY/2STY AVG GD Q 2X6 RH'), 'Row housing / townhouse');
  assert.equal(subcategoryOf('Residential', 'BI LEV AVG GD Q 2X6 RO HS'), 'Row housing / townhouse');
});

test('the storey buckets split the way an appraiser reads them', () => {
  assert.equal(subcategoryOf('Residential', '1 STY RES AVG QUALITY'), 'One storey');
  assert.equal(subcategoryOf('Residential', '1 1/2 STY RES FAIR QUAL'), 'Storey and a half / 1 3/4');
  assert.equal(subcategoryOf('Residential', '1 3/4 STY RES LOW QUAL'), 'Storey and a half / 1 3/4');
  assert.equal(subcategoryOf('Residential', '2 STY RES AVG QUALITY'), 'Two storey');
  assert.equal(subcategoryOf('Residential', '1STY/2STY GOOD QUAL 2X6'), 'Two storey');
  assert.equal(subcategoryOf('Residential', 'BI LEVEL RES AVG QUAL 2X6'), 'Bi-level');
  assert.equal(subcategoryOf('Residential', '4 LEVEL RES AVG QUALITY'), 'Split level (3/4 level)');
});

test('cottages and mobiles are their own buckets, not houses', () => {
  assert.equal(subcategoryOf('Residential', 'COTTAGE AVG QUALITY'), 'Cottage / seasonal');
  assert.equal(subcategoryOf('Residential', 'MOBILE HOME FAIR QLTY 2X3'), 'Mobile / manufactured');
  assert.equal(subcategoryOf('Residential', 'TRAILERS 16 FEET OR LESS'), 'Mobile / manufactured');
  assert.equal(subcategoryOf('Residential', 'GARAGE AVG QUAL DOUBL DET'), 'Garage / outbuilding');
});

test("the truncated restaurant spellings MAO ships all match", () => {
  // MAO emits all three. A strict /RESTAURANT/ silently drops ~100 sales.
  assert.equal(subcategoryOf('ICI', '1 STY C/BLK RESTAURNT'), 'Restaurant / food');
  assert.equal(subcategoryOf('ICI', 'MULTI STY BRICK RESTAURAN'), 'Restaurant / food');
  assert.equal(subcategoryOf('ICI', '1 STY AVG FRM RESTAURANT'), 'Restaurant / food');
});

test('the ICI buckets separate the commercial shapes', () => {
  assert.equal(subcategoryOf('ICI', '2-3 STY FRAME APT NO BSMT'), 'Apartment / multi-res');
  assert.equal(subcategoryOf('ICI', 'AVERAGE FRAME WAREHOUSE'), 'Warehouse / storage');
  assert.equal(subcategoryOf('ICI', '1 STY AVG FRM STORE/OFFIC'), 'Store / retail');
  assert.equal(subcategoryOf('ICI', '1 STY S/O AVE'), 'Store / retail');
  assert.equal(subcategoryOf('ICI', '1 STY AVERAGE OFFICE'), 'Office / bank');
  assert.equal(subcategoryOf('ICI', 'HOTEL - FAIR'), 'Hotel / motel');
  assert.equal(subcategoryOf('ICI', 'CHURCH'), 'Institutional / community');
});

test('the farm buckets separate storage, livestock and machinery', () => {
  assert.equal(subcategoryOf('Farm', 'GRAIN BIN-FL BOT,STL'), 'Grain storage');
  assert.equal(subcategoryOf('Farm', '1 STOREY HOG BARN'), 'Livestock barn');
  assert.equal(subcategoryOf('Farm', 'STEEL QUONSET MACH. SHED'), 'Machine shed / shop');
  assert.equal(subcategoryOf('Farm', 'POTATO WHSE-STEEL QUONSET'), 'Other farm structure');
});

test('an unclaimed descriptor lands in Other, not nowhere', () => {
  assert.equal(subcategoryOf('ICI', 'CODE/TYPE NO LONGER USED'), OTHER_SUBCATEGORY);
  assert.equal(subcategoryOf('Residential', 'BOATHOUSE AVERAGE QUALITY'), OTHER_SUBCATEGORY);
});

console.log('\nblank descriptors — bare land, 56.4% of the archive');

test('a blank descriptor is NO_STRUCTURE, in whichever family it sits', () => {
  assert.equal(subcategoryOf('Farm', ''), NO_STRUCTURE);
  assert.equal(subcategoryOf('Residential', null), NO_STRUCTURE);
  assert.equal(subcategoryOf('ICI', '   '), NO_STRUCTURE);
});

test('blank rows keep their family, so bare land stays separable by type', () => {
  // The whole reason NO_STRUCTURE is per-family: 96% of Farm sales are blank
  // against 45% of Residential, and they are not the same population.
  assert.equal(rowOptionKey('FARM BARE LAND', ''), optionKey('Farm', NO_STRUCTURE));
  assert.equal(rowOptionKey('RESIDENTIAL BARE LAND', ''), optionKey('Residential', NO_STRUCTURE));
  assert.notEqual(
    rowOptionKey('FARM BARE LAND', ''),
    rowOptionKey('RESIDENTIAL BARE LAND', ''),
  );
});

console.log('\noptionKey — subcategory names are not unique across families');

test('the same subcategory name under two families is two distinct keys', () => {
  // "Other" exists under both Residential and ICI. Ticking one must not
  // silently tick the other.
  assert.notEqual(
    optionKey('Residential', OTHER_SUBCATEGORY),
    optionKey('ICI', OTHER_SUBCATEGORY),
  );
});

console.log('\nprimaryPropertyTree');

const row = (saleTypeGroup, primaryProperty, groupId) =>
  ({ saleTypeGroup, primaryProperty, groupId });

const SAMPLE = [
  row('RESIDENTIAL LAND AND BUILDINGS', '1 STY RES AVG QUALITY', 1),
  row('RESIDENTIAL LAND AND BUILDINGS', '1 STY RES FAIR QUAL', 2),
  row('RESIDENTIAL LAND AND BUILDINGS', 'COTTAGE AVG QUALITY', 3),
  row('RESIDENTIAL BARE LAND', '', 4),
  row('ICI LAND AND BUILDINGS', 'AVERAGE FRAME WAREHOUSE', 5),
  row('FARM BARE LAND', '', 6),
  row('FARM LAND AND BUILDINGS', 'GRAIN BIN-FL BOT,STL', 7),
];

test('families come back in FAMILY_ORDER, not alphabetically', () => {
  const tree = primaryPropertyTree(SAMPLE);
  assert.deepEqual(tree.map((g) => g.family), ['Residential', 'ICI', 'Farm']);
});

test('only families and subcategories the rows contain are offered', () => {
  const tree = primaryPropertyTree(SAMPLE);
  // No Uncategorized group — nothing in SAMPLE is uncategorized.
  assert.equal(tree.find((g) => g.family === UNCATEGORIZED), undefined);
  const ici = tree.find((g) => g.family === 'ICI');
  assert.deepEqual(ici.options.map((o) => o.label), ['Warehouse / storage']);
});

test('counts are per row and roll up to the family', () => {
  const tree = primaryPropertyTree(SAMPLE);
  const res = tree.find((g) => g.family === 'Residential');
  assert.equal(res.count, 4);
  const oneStorey = res.options.find((o) => o.label === 'One storey');
  assert.equal(oneStorey.count, 2);   // AVG QUALITY + FAIR QUAL
});

test('(no primary structure) sorts last within its family', () => {
  const tree = primaryPropertyTree(SAMPLE);
  const res = tree.find((g) => g.family === 'Residential');
  assert.equal(res.options[res.options.length - 1].label, NO_STRUCTURE);
});

test('option values are the composite keys the filter matches on', () => {
  const tree = primaryPropertyTree(SAMPLE);
  const farm = tree.find((g) => g.family === 'Farm');
  assert.ok(farm.options.some((o) => o.value === optionKey('Farm', 'Grain storage')));
});

test('accessors keep the module free of the caller row shape', () => {
  const wrapped = SAMPLE.map((r) => ({ parcel: { properties: r } }));
  const tree = primaryPropertyTree(wrapped, {
    saleTypeOf: (r) => r.parcel.properties.saleTypeGroup,
    primaryOf:  (r) => r.parcel.properties.primaryProperty,
  });
  assert.deepEqual(tree.map((g) => g.family), ['Residential', 'ICI', 'Farm']);
});

test('an empty row set yields an empty tree rather than throwing', () => {
  assert.deepEqual(primaryPropertyTree([]), []);
  assert.deepEqual(primaryPropertyTree(null), []);
});

console.log('\nmatchingSaleGroupIds — whole sales, not half of one');

test('nothing ticked is no filter at all', () => {
  assert.equal(matchingSaleGroupIds(SAMPLE, new Set()), null);
  assert.equal(matchingSaleGroupIds(SAMPLE, null), null);
});

test('a multi-parcel sale passes whole when ANY parcel matches', () => {
  // One sale (group 9), two parcels: a house and a bare-land lot. Ticking
  // "One storey" must keep BOTH rows — dropping the second would leave the
  // group $/acre describing land no longer on screen.
  const rows = [
    row('RESIDENTIAL LAND AND BUILDINGS', '1 STY RES AVG QUALITY', 9),
    row('RESIDENTIAL LAND AND BUILDINGS', '', 9),
  ];
  const selected = new Set([optionKey('Residential', 'One storey')]);
  const matching = matchingSaleGroupIds(rows, selected);
  assert.ok(rows.every((r) => rowPassesPrimaryProperty(r, matching)));
});

test('a sale no parcel of which matches drops entirely', () => {
  const rows = [
    row('FARM BARE LAND', '', 11),
    row('FARM BARE LAND', '', 11),
  ];
  const selected = new Set([optionKey('Residential', 'One storey')]);
  const matching = matchingSaleGroupIds(rows, selected);
  assert.ok(rows.every((r) => !rowPassesPrimaryProperty(r, matching)));
});

test('ticking across families keeps both', () => {
  const selected = new Set([
    optionKey('ICI', 'Warehouse / storage'),
    optionKey('Farm', 'Grain storage'),
  ]);
  const matching = matchingSaleGroupIds(SAMPLE, selected);
  const kept = SAMPLE.filter((r) => rowPassesPrimaryProperty(r, matching));
  assert.deepEqual(kept.map((r) => r.groupId), [5, 7]);
});

test('ticking a bare-land bucket finds exactly that family\'s blank rows', () => {
  const selected = new Set([optionKey('Farm', NO_STRUCTURE)]);
  const matching = matchingSaleGroupIds(SAMPLE, selected);
  const kept = SAMPLE.filter((r) => rowPassesPrimaryProperty(r, matching));
  // Group 4 is RESIDENTIAL bare land and must NOT come along.
  assert.deepEqual(kept.map((r) => r.groupId), [6]);
});

test('a row with no group id filters on its own identity', () => {
  const a = row('RESIDENTIAL LAND AND BUILDINGS', '1 STY RES AVG QUALITY', null);
  const b = row('FARM BARE LAND', '', null);
  const selected = new Set([optionKey('Residential', 'One storey')]);
  const matching = matchingSaleGroupIds([a, b], selected);
  assert.equal(rowPassesPrimaryProperty(a, matching), true);
  assert.equal(rowPassesPrimaryProperty(b, matching), false);
});

const fails = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length > 0) process.exit(1);
