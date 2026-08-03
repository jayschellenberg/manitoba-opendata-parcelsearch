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

const fails = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length > 0) process.exit(1);
