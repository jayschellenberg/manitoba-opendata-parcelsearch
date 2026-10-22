// Tests for the Street Type + Direction dropdowns behind the civic-
// address search (lib/civicRange.js). The addresses are real
// Property_Address shapes from the ROLL_ENTRY service; the matching
// rule under test is "type position": a type token counts only when
// everything after it is a direction / number / unit designator, so
// 'ST' finds "100 MAIN ST N" but never "123 ST MARYS RD".
//
// Run: cd web && node test/streetTypeDir.test.js

import assert from 'node:assert/strict';
import {
  addressMatchesTypeDir,
  addressMatchesVariants,
  applyStreetTypeDirFilter,
  doubledSpaceForms,
  STREET_TYPES,
  STREET_DIRECTIONS,
} from '../src/lib/civicRange.js';

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

console.log('addressMatchesTypeDir — type');

test('type matches in trailing position', () => {
  assert.ok(addressMatchesTypeDir('100 MAIN ST', 'ST', ''));
  assert.ok(addressMatchesTypeDir('444 1ST AVE', 'AVE', ''));
  assert.ok(addressMatchesTypeDir('12 ELM CRES', 'CRES', ''));
});

test('type matches when only direction / number tokens follow', () => {
  assert.ok(addressMatchesTypeDir('100 MAIN ST N', 'ST', ''));
  assert.ok(addressMatchesTypeDir('1 106 E ROAD 71 N', 'RD', ''));
  assert.ok(addressMatchesTypeDir('60158 ROAD 96W', 'RD', ''));
  assert.ok(addressMatchesTypeDir('100 MAIN ST UNIT 4', 'ST', ''));
});

test('a saint prefix is not a street type', () => {
  assert.ok(!addressMatchesTypeDir('123 ST MARYS RD', 'ST', ''));
  // …but the same address matches its actual type.
  assert.ok(addressMatchesTypeDir('123 ST MARYS RD', 'RD', ''));
});

test('long-form spellings match their MAO code', () => {
  assert.ok(addressMatchesTypeDir('2079 W ROAD 65 N', 'RD', ''));
  assert.ok(addressMatchesTypeDir('10 PEMBINA HIGHWAY', 'HWY', ''));
  assert.ok(addressMatchesTypeDir('5 OAK STREET', 'ST', ''));
});

test('missing type does not match', () => {
  assert.ok(!addressMatchesTypeDir('100 MAIN ST', 'AVE', ''));
  assert.ok(!addressMatchesTypeDir('', 'ST', ''));
});

console.log('addressMatchesTypeDir — direction');

test('direction matches standalone and glued forms', () => {
  assert.ok(addressMatchesTypeDir('100 MAIN ST N', '', 'N'));
  assert.ok(addressMatchesTypeDir('60158 ROAD 96W', '', 'W'));
  assert.ok(addressMatchesTypeDir('5 008 ROAD 39NW', '', 'NW'));
});

test('direction does not match inside words or wrong direction', () => {
  assert.ok(!addressMatchesTypeDir('100 NORTH DR', '', 'N'));
  assert.ok(!addressMatchesTypeDir('100 MAIN ST N', '', 'S'));
  // Glued NW is NOT a hit for plain W (the token is 39NW, direction NW).
  assert.ok(!addressMatchesTypeDir('5 008 ROAD 39NW', '', 'W'));
});

test('a spelled-out direction counts only as the last token', () => {
  assert.ok(addressMatchesTypeDir('97124 ROAD 75 NORTH', '', 'N'));
  assert.ok(addressMatchesTypeDir('16 PR #248 SOUTH', '', 'S'));
  assert.ok(addressMatchesTypeDir('71080 - 71090 ROAD 82 WEST', '', 'W'));
  assert.ok(!addressMatchesTypeDir('97124 ROAD 75 NORTH', '', 'S'));
  // Street names, not suffixes.
  assert.ok(!addressMatchesTypeDir('2 NORTH SHORE DR', '', 'N'));
  assert.ok(!addressMatchesTypeDir('28 EAST COVE', '', 'E'));
  assert.ok(!addressMatchesTypeDir('16 SOUTHEAST DR', '', 'SE'));
});

test('a trailing period on the last token is ignored, initials are not directions', () => {
  assert.ok(addressMatchesTypeDir('332 GRAND BEACH RD. S.', '', 'S'));
  assert.ok(addressMatchesTypeDir('65108 ROAD 20 W.', '', 'W'));
  assert.ok(!addressMatchesTypeDir('1145 E. S. MURRAY DR', '', 'E'));
  assert.ok(!addressMatchesTypeDir('1145 E. S. MURRAY DR', '', 'S'));
});

test('a leading quarter on a section legal is not a direction', () => {
  assert.ok(!addressMatchesTypeDir('NE 25-10-19-1', '', 'NE'));
  assert.ok(!addressMatchesTypeDir('NW 19-23-20W', '', 'NW'));
  // A real prefix direction still counts.
  assert.ok(addressMatchesTypeDir('162 E NORTHSHORE RD', '', 'E'));
});

test('type and direction AND together', () => {
  assert.ok(addressMatchesTypeDir('100 MAIN ST N', 'ST', 'N'));
  assert.ok(!addressMatchesTypeDir('100 MAIN ST N', 'ST', 'S'));
  assert.ok(!addressMatchesTypeDir('100 MAIN AVE N', 'ST', 'N'));
});

test('empty selections pass everything', () => {
  assert.ok(addressMatchesTypeDir('ANYTHING AT ALL', '', ''));
  assert.ok(addressMatchesTypeDir('', '', ''));
});

console.log('applyStreetTypeDirFilter');

function fc(...addresses) {
  return {
    type: 'FeatureCollection',
    features: addresses.map((a) => ({ properties: { Property_Address: a } })),
  };
}
function addrs(c) { return c.features.map((f) => f.properties.Property_Address); }

test('filters in place; no-op when nothing selected', () => {
  const c = fc('100 MAIN ST', '200 ELM AVE', '123 ST MARYS RD');
  applyStreetTypeDirFilter(c, '', '');
  assert.equal(c.features.length, 3);
  applyStreetTypeDirFilter(c, 'ST', '');
  assert.deepEqual(addrs(c), ['100 MAIN ST']);
});

test('direction filter on rural grid addresses', () => {
  const c = fc('60158 ROAD 96W', '60158 ROAD 96E', '1 106 E ROAD 71 N');
  applyStreetTypeDirFilter(c, '', 'W');
  assert.deepEqual(addrs(c), ['60158 ROAD 96W']);
});

console.log('doubled spaces');

test('the client-side street match sees through a doubled space', () => {
  assert.ok(addressMatchesVariants('27 Penelope  CL', ['PENELOPE CL']));
  assert.ok(!addressMatchesVariants('27 PENELOPE CL', ['ASPEN PL']));
});

test('doubledSpaceForms doubles one word gap at a time, never a civic gap', () => {
  assert.deepEqual(doubledSpaceForms('LEISURE FALLS DR'),
    ['LEISURE  FALLS DR', 'LEISURE FALLS  DR']);
  assert.deepEqual(doubledSpaceForms('MAIN'), []);
  assert.deepEqual(doubledSpaceForms('1 106'), []);
  assert.deepEqual(doubledSpaceForms('A B C D E'), []);
});

console.log('option lists');

test('the dropdown lists mirror MAO', () => {
  assert.ok(STREET_TYPES.includes('AVE'));
  assert.ok(STREET_TYPES.includes('CROS'));
  assert.equal(STREET_TYPES.length, 22);
  assert.deepEqual(STREET_DIRECTIONS, ['E', 'N', 'NE', 'NW', 'S', 'SE', 'SW', 'W']);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
