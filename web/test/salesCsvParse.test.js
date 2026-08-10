// Unit tests for lib/salesCsvParse.js — the sales-export parser behind
// the Sales Analysis dropzone and the "Paste data…" modal.
//
// Regression cover for the bug where a paste whose multi-parcel sales
// stack several values inside one UNQUOTED cell lost those sales
// entirely: nothing quoted the embedded newlines, so each sale
// fractured into ragged 1-3 field rows with no Roll Number in the roll
// column, and the roll/muni guard dropped every one. A 9-sale Flin Flon
// paste plotted 4 — exactly the four single-parcel sales.
//
// Run: cd web && node test/salesCsvParse.test.js

import assert from 'node:assert/strict';
// (MAO-export column tests are appended at the end of this file.)
import { parseSalesCsv, splitStackedCell } from '../src/lib/salesCsvParse.js';

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

const HEADER = 'Sale Date\tConsideration\tMunicipality\tRoll Number\t'
             + 'Street Address\tLegal Description\tPrimary Property';

// The real Flin Flon paste, written as the PHYSICAL lines the clipboard
// carries: tabs between columns, and a multi-parcel sale's cells
// stacking several values so the cell wraps across several lines with
// nothing quoting the breaks. 9 sales, 15 parcels.
const FLIN_FLON_PASTE = [
  HEADER,
  'Mar 24, 2026\t$400,000\tCITY OF FLIN FLON',
  'CITY OF FLIN FLON',
  'CITY OF FLIN FLON\t27800.000',
  '33100.000',
  '33200.000\t29 - 31 MAIN ST',
  '12 CHURCHILL AVE ',
  '14 CHURCHILL AVE \tDESC 1/16-17-591',
  '7-20-591',
  '8-20-591\t1 STY SUPERMARKET',
  'Mar 02, 2026\t$2,400,000\tCITY OF FLIN FLON',
  'CITY OF FLIN FLON\t243600.000',
  '243700.000\t89 EAST ST',
  '99 EAST ST \t2--47790',
  '1--47790\t ',
  'Mar 07, 2025\t$720,000\tCITY OF FLIN FLON\t13400.000\t68 MAIN ST\tDESC 15/17-9-591\t1 STY C/BLK STORE/OFFICE',
  'Jun 24, 2024\t$1,806,700\tCITY OF FLIN FLON\t378180.000\t600 CLIFF LAKE RD\tA--58640\tAVERAGE FRAME WAREHOUSE',
  'May 13, 2024\t$3,950,000\tCITY OF FLIN FLON',
  'CITY OF FLIN FLON\t250000.000',
  '250010.000\t180 PTH #10A HWY',
  '200 PTH 10A HWY \t2--40833',
  '3--40833\tGOOD RETAIL',
  'Feb 29, 2024\t$235,000\tCITY OF FLIN FLON\t165200.000\t304 GREEN ST\tDESC 21/23-93-643\tHEAVY STEEL WAREHOUSE',
  'Apr 06, 2023\t$1,625,000\tCITY OF FLIN FLON\t250300.000\t190 GREEN ST\t2-6737\t2-3 STY FRAME APT W BSMT',
  'Apr 06, 2023\t$1,900,001\tCITY OF FLIN FLON',
  'CITY OF FLIN FLON\t150200.000',
  '239500.000\t2 - 8 HORACE AVE',
  '1 ADAMS ST \t1/4-639',
  'DESC -G-3087\t2-3 STY FRAME APT W BSMT',
  'Feb 09, 2023\t$430,000\tCITY OF FLIN FLON',
  'CITY OF FLIN FLON\t3300.000',
  '3500.000\t105 - 111 MAIN ST',
  '103 MAIN ST \tDESC 8/9-6-591',
  '10-6-591\t1 STY GOOD OFFICE/BANK',
].join('\n');

console.log('parseSalesCsv — unquoted stacked cells (the MAO table paste)');

test('all 9 sales survive, as 15 parcels', () => {
  const recs = parseSalesCsv(FLIN_FLON_PASTE);
  assert.equal(new Set(recs.map((r) => r.groupId)).size, 9);
  assert.equal(recs.length, 15);
});

test('every sale keeps its date and price', () => {
  const recs = parseSalesCsv(FLIN_FLON_PASTE);
  const byGroup = new Map();
  for (const r of recs) if (!byGroup.has(r.groupId)) byGroup.set(r.groupId, r);
  assert.deepEqual(
    [...byGroup.values()].map((r) => [r.saleDate, r.consideration]),
    [
      ['Mar 24, 2026', '$400,000'],
      ['Mar 02, 2026', '$2,400,000'],
      ['Mar 07, 2025', '$720,000'],
      ['Jun 24, 2024', '$1,806,700'],
      ['May 13, 2024', '$3,950,000'],
      ['Feb 29, 2024', '$235,000'],
      ['Apr 06, 2023', '$1,625,000'],
      ['Apr 06, 2023', '$1,900,001'],
      ['Feb 09, 2023', '$430,000'],
    ],
  );
});

test('a stacked sale expands to one record per roll, in order', () => {
  const recs = parseSalesCsv(FLIN_FLON_PASTE).filter((r) => r.groupId === 1);
  assert.equal(recs.length, 3);
  assert.deepEqual(recs.map((r) => r.rollNumber), ['27800.000', '33100.000', '33200.000']);
});

test('address and legal stay aligned with their own roll', () => {
  const recs = parseSalesCsv(FLIN_FLON_PASTE).filter((r) => r.groupId === 1);
  assert.deepEqual(
    recs.map((r) => [r.rollNumber, r.streetAddress, r.legalDescription]),
    [
      ['27800.000', '29 - 31 MAIN ST',  'DESC 1/16-17-591'],
      ['33100.000', '12 CHURCHILL AVE', '7-20-591'],
      ['33200.000', '14 CHURCHILL AVE', '8-20-591'],
    ],
  );
});

test('every member of a group carries the group date + price', () => {
  const recs = parseSalesCsv(FLIN_FLON_PASTE).filter((r) => r.groupId === 1);
  for (const r of recs) {
    assert.equal(r.saleDate, 'Mar 24, 2026');
    assert.equal(r.consideration, '$400,000');
  }
});

test('the municipality repeats onto every parcel of the sale', () => {
  const recs = parseSalesCsv(FLIN_FLON_PASTE);
  assert.ok(recs.every((r) => r.municipality === 'CITY OF FLIN FLON'));
});

test('exactly one member of each group is the primary', () => {
  const recs = parseSalesCsv(FLIN_FLON_PASTE);
  const byGroup = new Map();
  for (const r of recs) byGroup.set(r.groupId, (byGroup.get(r.groupId) || 0) + (r.isPrimary ? 1 : 0));
  assert.deepEqual([...byGroup.values()], [1, 1, 1, 1, 1, 1, 1, 1, 1]);
  // …and it's the first parcel listed.
  assert.equal(recs[0].isPrimary, true);
  assert.equal(recs[1].isPrimary, false);
});

test('the last sale in the paste is not truncated', () => {
  const recs = parseSalesCsv(FLIN_FLON_PASTE).filter((r) => r.groupId === 9);
  assert.deepEqual(recs.map((r) => r.rollNumber), ['3300.000', '3500.000']);
  assert.equal(recs[0].saleDate, 'Feb 09, 2023');
});

test('a blank Primary Property cell stays blank, not a stray space', () => {
  const recs = parseSalesCsv(FLIN_FLON_PASTE).filter((r) => r.groupId === 2);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].primaryProperty, '');
});

console.log('\nparseSalesCsv — stacked cells WITHOUT trailing columns (the Niverville paste)');

// Shape 3b: the same unquoted stacked shape, but the copy ends each
// logical row at its last non-empty cell — the blank Primary Property
// column never arrives, so no line reaches the header's width and the
// fixed-width reassembly gluing rows by delimiter count merges
// consecutive sales instead. Real capture: a 44-sale Niverville paste
// plotted only its 25 single-parcel rows. The date-anchored candidate
// exists for exactly this fixture.
const NIVERVILLE_PASTE = [
  HEADER,
  'Dec 30, 2025\t$125,000\tTOWN OF NIVERVILLE\t14400.000\t155 1ST ST S\t12-3-19956',
  'Dec 30, 2024\t$140,000\tTOWN OF NIVERVILLE',
  'TOWN OF NIVERVILLE\t35865.000',
  '35870.000\t23 MULBERRY AVE',
  '21 MULBERRY AVE \t8--66192',
  '9--66192',
  'Oct 01, 2024\t$210,000\tTOWN OF NIVERVILLE',
  'TOWN OF NIVERVILLE',
  'TOWN OF NIVERVILLE\t36075.000',
  '36130.000',
  '36240.000\t39 RIDGEMONT DR',
  '19 RIDGEMONT DR ',
  '37 MULBERRY AVE \t48--66192',
  '58--66192',
  '77--66192',
  'Sep 09, 2024\t$700,000\tTOWN OF NIVERVILLE',
  'TOWN OF NIVERVILLE',
  'TOWN OF NIVERVILLE',
  'TOWN OF NIVERVILLE',
  'TOWN OF NIVERVILLE',
  'TOWN OF NIVERVILLE',
  'TOWN OF NIVERVILLE',
  'TOWN OF NIVERVILLE',
  'TOWN OF NIVERVILLE',
  'TOWN OF NIVERVILLE\t35905.000',
  '35930.000',
  '35935.000',
  '35940.000',
  '35945.000',
  '35950.000',
  '35955.000',
  '35960.000',
  '35965.000',
  '35990.000\t300 CENTRE ST',
  '350 CENTRE ST ',
  '360 CENTRE ST ',
  '370 CENTRE ST ',
  '380 CENTRE ST ',
  '390 CENTRE ST ',
  '400 CENTRE ST ',
  '410 CENTRE ST ',
  '420 CENTRE ST ',
  '10 MULBERRY AVE \tDESC 15--66192',
  'DESC 20--66192',
  'DESC 21--66192',
  'DESC 22--66192',
  'DESC 23--66192',
  'DESC 24--66192',
  'DESC 25--66192',
  'DESC 26--66192',
  'DESC 27--66192',
  '34--66192',
  'Jan 31, 2023\t$135,000\tTOWN OF NIVERVILLE\t44820.466\t816 TURNBERRY COVE\t5-6-69042',
].join('\n');

test('all 5 sales survive, as 17 parcels', () => {
  const recs = parseSalesCsv(NIVERVILLE_PASTE);
  assert.equal(new Set(recs.map((r) => r.groupId)).size, 5);
  assert.equal(recs.length, 17);
});

test('a 2-parcel group keeps roll/address/legal aligned', () => {
  const recs = parseSalesCsv(NIVERVILLE_PASTE).filter((r) => r.groupId === 2);
  assert.deepEqual(
    recs.map((r) => [r.rollNumber, r.streetAddress, r.legalDescription]),
    [
      ['35865.000', '23 MULBERRY AVE', '8--66192'],
      ['35870.000', '21 MULBERRY AVE', '9--66192'],
    ],
  );
  assert.ok(recs.every((r) => r.saleDate === 'Dec 30, 2024'
    && r.consideration === '$140,000'));
});

test('a 3-parcel group keeps its columns aligned', () => {
  const recs = parseSalesCsv(NIVERVILLE_PASTE).filter((r) => r.groupId === 3);
  assert.deepEqual(
    recs.map((r) => [r.rollNumber, r.streetAddress, r.legalDescription]),
    [
      ['36075.000', '39 RIDGEMONT DR', '48--66192'],
      ['36130.000', '19 RIDGEMONT DR', '58--66192'],
      ['36240.000', '37 MULBERRY AVE', '77--66192'],
    ],
  );
});

test('a 10-parcel portfolio sale comes through whole', () => {
  const recs = parseSalesCsv(NIVERVILLE_PASTE).filter((r) => r.groupId === 4);
  assert.equal(recs.length, 10);
  assert.equal(recs[0].rollNumber, '35905.000');
  assert.equal(recs[0].streetAddress, '300 CENTRE ST');
  assert.equal(recs[0].legalDescription, 'DESC 15--66192');
  assert.equal(recs[9].rollNumber, '35990.000');
  assert.equal(recs[9].streetAddress, '10 MULBERRY AVE');
  assert.equal(recs[9].legalDescription, '34--66192');
  assert.ok(recs.every((r) => r.consideration === '$700,000'));
  assert.deepEqual(recs.map((r) => r.isPrimary),
    [true, false, false, false, false, false, false, false, false, false]);
});

test('the sales before and after the groups stay single-parcel', () => {
  const recs = parseSalesCsv(NIVERVILLE_PASTE);
  assert.equal(recs.filter((r) => r.groupId === 1).length, 1);
  const last = recs.filter((r) => r.groupId === 5);
  assert.equal(last.length, 1);
  assert.equal(last[0].rollNumber, '44820.466');
  assert.equal(last[0].saleDate, 'Jan 31, 2023');
});

test('mixed trailing cells — some rows carry the last column, some not', () => {
  // MAO grids emit a whitespace Primary Property cell on some rows and
  // nothing on others; both shapes appear inside ONE paste. Neither the
  // naive nor the fixed-width tokenizer survives the mix.
  const paste = [
    HEADER,
    'Dec 30, 2025\t$125,000\tTOWN OF NIVERVILLE\t14400.000\t155 1ST ST S\t12-3-19956\t ',
    'Dec 30, 2024\t$140,000\tTOWN OF NIVERVILLE',
    'TOWN OF NIVERVILLE\t35865.000',
    '35870.000\t23 MULBERRY AVE',
    '21 MULBERRY AVE \t8--66192',
    '9--66192',
  ].join('\n');
  const recs = parseSalesCsv(paste);
  assert.equal(recs.length, 3);
  assert.deepEqual(recs.map((r) => r.groupId), [1, 2, 2]);
  assert.deepEqual(recs.map((r) => r.rollNumber),
    ['14400.000', '35865.000', '35870.000']);
});

test('shape 3b reassembles under DD-Mmm-YY dates too', () => {
  const paste = [
    HEADER,
    '30-Dec-24\t$140,000\tTOWN OF NIVERVILLE',
    'TOWN OF NIVERVILLE\t35865.000',
    '35870.000\t23 MULBERRY AVE',
    '21 MULBERRY AVE \t8--66192',
    '9--66192',
  ].join('\n');
  const recs = parseSalesCsv(paste);
  assert.equal(recs.length, 2);
  assert.ok(recs.every((r) => r.saleDate === '30-Dec-24'));
});

console.log('\nparseSalesCsv — quoted stacked cells (Excel CSV export)');

test('quoted multi-line cells expand the same way', () => {
  const csv = [
    'Sale Date,Consideration,Municipality,Roll Number,Street Address,Legal Description,Primary Property',
    '"Mar 24, 2026","$400,000","CITY OF FLIN FLON',
    'CITY OF FLIN FLON","27800.000',
    '33100.000","29 - 31 MAIN ST',
    '12 CHURCHILL AVE","DESC 1/16-17-591',
    '7-20-591","1 STY SUPERMARKET"',
  ].join('\n');
  const recs = parseSalesCsv(csv);
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.rollNumber), ['27800.000', '33100.000']);
  assert.ok(recs.every((r) => r.consideration === '$400,000'));
  assert.ok(recs.every((r) => r.groupId === 1));
});

console.log('\nparseSalesCsv — one row per parcel (the original shape)');

test('continuation rows inherit the sale above them', () => {
  const csv = [
    'Sale Date,Consideration,Municipality,Roll Number,Street Address,Legal Description,Primary Property',
    '12-Mar-24,"$500,000",RM OF SPRINGFIELD,300.000,1 Main St,1-2-3,SHOP',
    ',,RM OF SPRINGFIELD,400.000,3 Main St,4-5-6,',
    '01-Feb-24,"$99,000",RM OF SPRINGFIELD,500.000,9 Main St,7-8-9,SHED',
  ].join('\n');
  const recs = parseSalesCsv(csv);
  assert.equal(recs.length, 3);
  assert.deepEqual(recs.map((r) => r.groupId), [1, 1, 2]);
  assert.deepEqual(recs.map((r) => r.isPrimary), [true, false, true]);
  assert.equal(recs[1].saleDate, '12-Mar-24');
  assert.equal(recs[1].consideration, '$500,000');
});

test('a CSV that omits trailing empty columns is NOT spliced together', () => {
  // Ragged for the other reason: short rows, not wrapped cells. The
  // fixed-width reassembly would merge these two sales into one, so the
  // parser must keep the naive parse here.
  const csv = [
    'Sale Date,Consideration,Municipality,Roll Number,Street Address,Legal Description,Primary Property',
    '12-Mar-24,"$500,000",RM OF SPRINGFIELD,300.000,1 Main St,1-2-3',
    '01-Feb-24,"$99,000",RM OF SPRINGFIELD,500.000,9 Main St,7-8-9,SHED',
  ].join('\n');
  const recs = parseSalesCsv(csv);
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.rollNumber), ['300.000', '500.000']);
  assert.deepEqual(recs.map((r) => r.groupId), [1, 2]);
  assert.equal(recs[0].legalDescription, '1-2-3');
  assert.equal(recs[0].primaryProperty, '');
});

test('quoted commas inside Consideration survive', () => {
  const csv = [
    'Sale Date,Consideration,Municipality,Roll Number',
    '12-Mar-24,"$1,806,700",CITY OF FLIN FLON,378180.000',
  ].join('\n');
  const recs = parseSalesCsv(csv);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].consideration, '$1,806,700');
});

console.log('\nparseSalesCsv — rejects and edge cases');

test('missing Roll Number or Municipality column yields nothing', () => {
  assert.deepEqual(parseSalesCsv('Sale Date,Consideration\n12-Mar-24,"$5"'), []);
  assert.deepEqual(parseSalesCsv('Sale Date,Roll Number\n12-Mar-24,300.000'), []);
});

test('header only, or empty input, yields nothing', () => {
  assert.deepEqual(parseSalesCsv(HEADER), []);
  assert.deepEqual(parseSalesCsv(''), []);
  assert.deepEqual(parseSalesCsv(null), []);
});

test('rows with a blank roll or blank muni are dropped', () => {
  const csv = [
    'Sale Date,Consideration,Municipality,Roll Number',
    '12-Mar-24,"$5",RM OF SPRINGFIELD,',
    '13-Mar-24,"$6",,400.000',
    '14-Mar-24,"$7",RM OF SPRINGFIELD,500.000',
  ].join('\n');
  const recs = parseSalesCsv(csv);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].rollNumber, '500.000');
});

test('a stacked cell with more munis than rolls follows the roll count', () => {
  const paste = [
    HEADER,
    'Mar 24, 2026\t$400,000\tCITY OF FLIN FLON',
    'CITY OF FLIN FLON',
    'CITY OF FLIN FLON\t27800.000',
    '33100.000\t29 - 31 MAIN ST',
    '12 CHURCHILL AVE\tDESC 1/16-17-591',
    '7-20-591\t1 STY SUPERMARKET',
  ].join('\n');
  const recs = parseSalesCsv(paste);
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.rollNumber), ['27800.000', '33100.000']);
});

console.log('\nsplitStackedCell');

test('splits on newlines only — a pipe is a roll JOINER, not a separator', () => {
  assert.deepEqual(splitStackedCell('a\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(splitStackedCell('83100 | 83200'), ['83100 | 83200']);
});

test('trims values and drops trailing blanks', () => {
  assert.deepEqual(splitStackedCell('12 CHURCHILL AVE \n'), ['12 CHURCHILL AVE']);
  assert.deepEqual(splitStackedCell(' '), []);
  assert.deepEqual(splitStackedCell(''), []);
  assert.deepEqual(splitStackedCell(null), []);
});

test('keeps interior blanks so columns stay aligned', () => {
  assert.deepEqual(splitStackedCell('a\n\nc'), ['a', '', 'c']);
});

// ---------------------------------------------------------------------------
// MAO sales-database export columns
//
// The export (mao-scrape/scripts/export_sales_for_web.R) adds Parcel Size,
// Parcel Size Unit, Parcel Change and Sale Type Group. Parcel Change is the one
// that matters: it reports whether the parcel was reconfigured AFTER the sale,
// which decides whether the size describes what actually sold. Drop it and a
// subdivided comparable silently yields a $/acre that can be 4x wrong.
//
// These columns must stay OPTIONAL — a hand-pasted comp set has none of them and
// must keep producing exactly the record shape it always did.
// ---------------------------------------------------------------------------

const MAO_HEADER =
  'Municipality,Roll Number,Sale Date,Consideration,Street Address,Legal Description,' +
  'Sale Type Group,Parcel Size,Parcel Size Unit,Parcel Change';

test('carries the export columns onto each record', () => {
  const csv = MAO_HEADER + '\n' +
    'TOWN OF ALTONA,132500.000,"Jul 21, 2026","$510,000",168 ELMCREST DR SE,11-2-2431,' +
    'RESIDENTIAL LAND AND BUILDINGS,82.4,FEET,legal_matches_size_unchecked\n';
  const recs = parseSalesCsv(csv);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].parcelSize, '82.4');
  assert.equal(recs[0].parcelSizeUnit, 'FEET');
  assert.equal(recs[0].parcelChange, 'legal_matches_size_unchecked');
  assert.equal(recs[0].saleTypeGroup, 'RESIDENTIAL LAND AND BUILDINGS');
});

test('a pasted comp set without those columns keeps its exact record shape', () => {
  const csv = 'Municipality,Roll Number,Sale Date,Consideration\n' +
              'TOWN OF ALTONA,132500.000,"Jul 21, 2026","$510,000"\n';
  const recs = parseSalesCsv(csv);
  assert.equal(recs.length, 1);
  for (const k of ['parcelSize', 'parcelSizeUnit', 'parcelChange', 'saleTypeGroup']) {
    assert.ok(!(k in recs[0]), `${k} must be absent, not empty, when the column is missing`);
  }
});

test('a multi-parcel sale gets its OWN size per parcel', () => {
  // One sale, three rolls, three different acreages stacked in the cell — the
  // shape parse_grid now produces after converting MAO's <br> to newlines.
  const csv = MAO_HEADER + '\n' +
    '"RM OF DE SALABERRY\nRM OF DE SALABERRY\nRM OF DE SALABERRY",' +
    '"24400.000\n24500.000\n24700.000","Jul 02, 2026","$2,000,000",' +
    '"\n\n","DESC NE9-5-3E\nDESC NW9-5-3E\nDESC SE9-5-3E",' +
    'FARM BARE LAND,"160.04\n80.00\n159.90","ACRES\nACRES\nACRES",' +
    '"verified_unchanged\nsize_changed\nverified_unchanged"\n';
  const recs = parseSalesCsv(csv);
  assert.equal(recs.length, 3, 'one record per parcel');
  assert.deepEqual(recs.map((r) => r.rollNumber), ['24400.000', '24500.000', '24700.000']);
  assert.deepEqual(recs.map((r) => r.parcelSize), ['160.04', '80.00', '159.90']);
  assert.deepEqual(recs.map((r) => r.parcelChange),
    ['verified_unchanged', 'size_changed', 'verified_unchanged'],
    'the flagged middle parcel must not inherit its neighbours verdict');
  // Sale-level values are copied to every parcel; only the first is primary.
  assert.ok(recs.every((r) => r.consideration === '$2,000,000'));
  assert.equal(new Set(recs.map((r) => r.groupId)).size, 1, 'all one sale');
  assert.deepEqual(recs.map((r) => r.isPrimary), [true, false, false]);
});

test('a single stacked value applies to every parcel', () => {
  // Sale Type Group is written once for the whole sale; it must reach all three.
  const csv = MAO_HEADER + '\n' +
    '"RM OF MORRIS\nRM OF MORRIS","10.000\n20.000","Mar 01, 2025","$1",' +
    '"\n","L1\nL2",FARM BARE LAND,"40\n40","ACRES\nACRES","verified_unchanged\nverified_unchanged"\n';
  const recs = parseSalesCsv(csv);
  assert.equal(recs.length, 2);
  assert.ok(recs.every((r) => r.saleTypeGroup === 'FARM BARE LAND'));
});

const fails = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length > 0) process.exit(1);
