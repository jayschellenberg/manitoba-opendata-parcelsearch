// Tests for the street list behind the Street typeahead
// (lib/streetIndex.js). Every address below is a real Property_Address
// shape from the 2026-10-11 Roll Entry snapshot. The rule under test is
// that a suggestion searches as the street it names: the name kept is a
// verbatim run of the address, minus the civic number in front and a
// standalone direction behind.
//
// Run: cd web && node test/streetIndex.test.js

import assert from 'node:assert/strict';
import {
  streetOfAddress,
  buildMuniStreets,
  suggestStreets,
  suggestHint,
  suggestKey,
} from '../src/lib/streetIndex.js';

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
const street = (a) => streetOfAddress(a)?.name ?? null;
const dir = (a) => streetOfAddress(a)?.dir ?? null;

console.log('streetOfAddress — the civic number comes off the front');

test('plain civic number', () => {
  assert.equal(street('161 MAIN ST NE'), 'MAIN ST');
  assert.equal(street('444 1ST AVE'), '1ST AVE');
});

test('grouped, ranged, unit and compound numbers', () => {
  assert.equal(street('1 106 E ROAD 71 N'), 'E ROAD 71');
  assert.equal(street('71080 - 71090 ROAD 82 WEST'), 'ROAD 82');
  assert.equal(street('UNIT E1 - 477 MEADOWLARK BL'), 'MEADOWLARK BL');
  assert.equal(street('E1 - 1545 MAIN ST E'), 'MAIN ST');
  assert.equal(street('36F-20 ZEBRUN RD'), 'ZEBRUN RD');
  assert.equal(street('8-10 GLENN OAKES PL'), 'GLENN OAKES PL');
  assert.equal(street('124/130 2ND AVE SE'), '2ND AVE');
  assert.equal(street('26094+ - 26130 ROAD 25N'), 'ROAD 25N');
  assert.equal(street('27100 AND - 27110 31 RD'), '31 RD');
});

test('lettered parcels beside a separator are part of the civic', () => {
  assert.equal(street('A & B ROAD 110NE'), 'ROAD 110NE');
  assert.equal(street('A - B TRAVERSE BAY RD'), 'TRAVERSE BAY RD');
});

test('a number that names the street stays when only a type would be left', () => {
  assert.equal(street('30075E 59 HWY'), '59 HWY');
  assert.equal(street('12345 402 RD'), '402 RD');
  assert.equal(street('#30 HWY'), '#30 HWY');
});

console.log('streetOfAddress — the back');

test('a standalone trailing direction splits off into dir', () => {
  assert.equal(street('161 MAIN ST NE'), 'MAIN ST');
  assert.equal(dir('161 MAIN ST NE'), 'NE');
  assert.equal(dir('97124 ROAD 75 NORTH'), 'N');
  assert.equal(street('97124 ROAD 75 NORTH'), 'ROAD 75');
  assert.equal(dir('100 ELM AVE'), '');
});

test('a glued direction is part of the road name', () => {
  // Road 93N and Road 93W are different roads.
  assert.equal(street('44092 ROAD 93N'), 'ROAD 93N');
  assert.equal(dir('44092 ROAD 93N'), '');
});

test('the street keeps its own punctuation; a trailing period on the direction does not stop the split', () => {
  assert.equal(street('332 GRAND BEACH RD. S.'), 'GRAND BEACH RD.');
  assert.equal(dir('332 GRAND BEACH RD. S.'), 'S');
});

test('a trailing unit is not part of the street', () => {
  assert.equal(street('100 MAIN ST UNIT 4'), 'MAIN ST');
});

test('a street named for a direction is not mistaken for one', () => {
  assert.equal(street('28 EAST COVE'), 'EAST COVE');
  assert.equal(street('2 NORTH SHORE DR'), 'NORTH SHORE DR');
});

test('whitespace and case are normalised', () => {
  assert.equal(street('27 Penelope  CL'), 'PENELOPE CL');
});

console.log('streetOfAddress — no street to offer');

test('legal descriptions in the address field', () => {
  for (const a of ['NE 25-10-19-1', 'SE4-29-8W', 'DESC NW15-27-9W', 'DESC 4-7-445',
    '7/8-7-445', '1-21035', 'DESC E--12211', 'A&B&E--47171', '', null]) {
    assert.equal(streetOfAddress(a), null, String(a));
  }
});

console.log('buildMuniStreets');

test('one row per street, counted, directions most common first', () => {
  const list = buildMuniStreets([
    '161 MAIN ST NE', '30 MAIN ST NE', '12 MAIN ST N', '5 MAIN ST',
    '40 ELM AVE', 'SE4-29-8W', '',
  ]);
  assert.deepEqual(list, [
    { n: 'ELM AVE', c: 1 },
    { n: 'MAIN ST', c: 4, d: ['NE', 'N'] },
  ]);
});

console.log('suggestStreets');

const LIST = buildMuniStreets([
  ...Array(36).fill('1 MAIN ST NE'),
  '2 MAINLAND DR', '2 MAINLAND DR',
  '3 GERMAIN ST', '4 OLD MAIN RD',
  '5 GRAND BEACH RD. S.', '6 EAU-CLAIRE DR',
]);

test('tiers: whole name, prefix, word start, anywhere; more parcels first', () => {
  assert.deepEqual(suggestStreets(LIST, 'main').map((e) => e.n),
    ['MAIN ST', 'MAINLAND DR', 'OLD MAIN RD', 'GERMAIN ST']);
  // GERMAIN ST does contain "MAIN ST" — and so would the search's own
  // substring match, so offering it last is honest.
  assert.deepEqual(suggestStreets(LIST, 'MAIN ST').map((e) => e.n), ['MAIN ST', 'GERMAIN ST']);
});

test('matching folds punctuation and hyphens; the row keeps its own spelling', () => {
  assert.deepEqual(suggestStreets(LIST, 'grand beach rd').map((e) => e.n), ['GRAND BEACH RD.']);
  assert.deepEqual(suggestStreets(LIST, 'eau claire').map((e) => e.n), ['EAU-CLAIRE DR']);
  assert.equal(suggestKey(' eau-claire  dr. '), 'EAU CLAIRE DR');
});

test('nothing under two characters, nothing from an empty list', () => {
  assert.deepEqual(suggestStreets(LIST, 'm'), []);
  assert.deepEqual(suggestStreets(null, 'main'), []);
});

test('the hint names directions then the parcel count', () => {
  assert.equal(suggestHint({ n: 'MAIN ST', c: 36, d: ['NE', 'N'] }), 'NE · N · 36 parcels');
  assert.equal(suggestHint({ n: 'ELM AVE', c: 1 }), '1 parcel');
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
