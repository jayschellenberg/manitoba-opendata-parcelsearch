// Characterization tests for lib/civicRange.js — the civic-number
// filter behind the address search (contains / exact / range, plus the
// spaced-number handling those all rely on). The expected key values
// come straight from the functions' documented examples; the addresses
// are real Property_Address values from the live ROLL_ENTRY service.
//
// Run: cd web && node test/civicRange.test.js

import assert from 'node:assert/strict';
import {
  parseCivicAddressKey,
  parseCivicAddressKeys,
  parseCivicBound,
  addressSearchVariants,
  addressMatchesVariants,
  civicSearchMode,
  applyCivicNumberFilter,
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

console.log('parseCivicAddressKey');

test('maps the documented examples to their keys', () => {
  assert.equal(parseCivicAddressKey('444 1ST ST'), 44400);
  assert.equal(parseCivicAddressKey('100A MAIN ST'), 10001);
  assert.equal(parseCivicAddressKey('100B MAIN ST'), 10002);
  assert.equal(parseCivicAddressKey('60158 ROAD 96W'), 6015800);
});

test('a bare number sorts before its letter variants', () => {
  assert.ok(parseCivicAddressKey('100 MAIN') < parseCivicAddressKey('100A MAIN'));
});

test('non-civic / quarter-section descriptions return null', () => {
  assert.equal(parseCivicAddressKey('DESC NE22-21-3E'), null);
  assert.equal(parseCivicAddressKey('NE1-1-3E'), null);
  assert.equal(parseCivicAddressKey(''), null);
  assert.equal(parseCivicAddressKey(null), null);
  assert.equal(parseCivicAddressKey('100'), null);  // needs trailing whitespace
});

console.log('\nparseCivicAddressKeys');

// Every address below is a real Property_Address value pulled from the
// live ROLL_ENTRY service.
test('a plain address yields the one reading', () => {
  assert.deepEqual(parseCivicAddressKeys('444 1ST ST'), [44400]);
  assert.deepEqual(parseCivicAddressKeys('60158 ROAD 96W'), [6015800]);
  assert.deepEqual(parseCivicAddressKeys('100A MAIN ST'), [10001]);
});

test('a split number yields both readings, closed-up first', () => {
  // Rosser roll 76250 — civic 1106E, the case this filter used to drop.
  assert.deepEqual(parseCivicAddressKeys('1 106 E ROAD 71 N'), [100, 110605]);
  assert.deepEqual(parseCivicAddressKeys('64 158 ROAD 2 W'), [6400, 6415800]);
  // Direction letter closed up against the number (Rockwood's style).
  assert.deepEqual(parseCivicAddressKeys('9 089E ROAD 78 N'), [900, 908905]);
  // Leading zero: "0 107" is civic 107, W the direction suffix (+23).
  assert.deepEqual(parseCivicAddressKeys('0 107 W ROAD 65 N'), [0, 10723]);
});

test('a trailing road number is not a thousands group', () => {
  // "68 016 1 RD W" is civic 68016 on 1 RD W — the "1" is one digit, so
  // it can't be a group; the road survives as street text.
  assert.deepEqual(parseCivicAddressKeys('68 016 1 RD W'), [6800, 6801600]);
});

test('civic-on-numeric-road keeps its literal reading first', () => {
  // Lac du Bonnet / Morden: same shape as Rosser, opposite meaning. The
  // correct key (32, 146) leads; the joined reading rides along.
  assert.deepEqual(parseCivicAddressKeys('32 502 RD'), [3200, 3250200]);
  assert.deepEqual(parseCivicAddressKeys('146 100 RTE'), [14600, 14610000]);
});

test('non-civic descriptions yield no keys', () => {
  assert.deepEqual(parseCivicAddressKeys('DESC NE22-21-3E'), []);
  assert.deepEqual(parseCivicAddressKeys('NE1-1-3E'), []);
  assert.deepEqual(parseCivicAddressKeys(''), []);
  assert.deepEqual(parseCivicAddressKeys(null), []);
});

console.log('\nparseCivicBound');

test('bare number: lower includes the integer, upper spans its suffixes', () => {
  assert.equal(parseCivicBound('100', 'lower'), 10000);
  assert.equal(parseCivicBound('100', 'upper'), 10099);
});

test('a typed letter is exact on both ends', () => {
  assert.equal(parseCivicBound('100A', 'lower'), 10001);
  assert.equal(parseCivicBound('100A', 'upper'), 10001);
});

test('empty / garbage returns null', () => {
  assert.equal(parseCivicBound('', 'lower'), null);
  assert.equal(parseCivicBound('abc', 'lower'), null);
  assert.equal(parseCivicBound('100 MAIN', 'lower'), null);  // street text is not a bound
});

test('a bound may be typed with the internal space', () => {
  // Pasted straight out of a Property_Address: "1 106" == 1106.
  assert.equal(parseCivicBound('1 106', 'lower'), parseCivicBound('1106', 'lower'));
  assert.equal(parseCivicBound('1 106', 'upper'), 110699);
  assert.equal(parseCivicBound('64 158', 'lower'), 6415800);
});

console.log('\naddressSearchVariants');

test('a plain street name has one variant (the SQL clause stays single)', () => {
  assert.deepEqual(addressSearchVariants('main st'), ['MAIN ST']);
  assert.deepEqual(addressSearchVariants('ROAD 71 N'), ['ROAD 71 N']);
});

test('a closed-up number also tries the split form, and vice versa', () => {
  assert.deepEqual(addressSearchVariants('1106'), ['1106', '1 106']);
  assert.deepEqual(addressSearchVariants('1 106'), ['1 106', '1106']);
  assert.deepEqual(addressSearchVariants('64158'), ['64158', '64 158']);
});

test('either form finds Rosser roll 76250', () => {
  const addr = '1 106 E ROAD 71 N';
  assert.ok(addressMatchesVariants(addr, addressSearchVariants('1106')));
  assert.ok(addressMatchesVariants(addr, addressSearchVariants('1 106')));
  assert.ok(addressMatchesVariants(addr, addressSearchVariants('road 71')));
  assert.ok(!addressMatchesVariants(addr, addressSearchVariants('1107')));
});

test('empty term matches everything (filter disabled)', () => {
  assert.deepEqual(addressSearchVariants('  '), []);
  assert.ok(addressMatchesVariants('anything', []));
});

console.log('\ncivicSearchMode');

test('how many boxes are filled picks the mode', () => {
  assert.deepEqual(civicSearchMode('', ''),          { mode: 'none',     term: '' });
  assert.deepEqual(civicSearchMode('1106', ''),      { mode: 'contains', term: '1106' });
  assert.deepEqual(civicSearchMode('', '1106'),      { mode: 'contains', term: '1106' });
  assert.deepEqual(civicSearchMode('1106', '1106'),  { mode: 'exact',    term: '1106' });
  assert.deepEqual(civicSearchMode('100', '200'),    { mode: 'range',    term: '' });
});

test('exact is judged canonically, so spacing does not matter', () => {
  assert.equal(civicSearchMode('1 106', '1106').mode, 'exact');
  assert.equal(civicSearchMode('1106', '1 106').mode, 'exact');
});

test('junk in both boxes falls to range, which no-ops downstream', () => {
  assert.equal(civicSearchMode('abc', 'abc').mode, 'range');
});

console.log('\napplyCivicNumberFilter');

function fc(...addresses) {
  return { type: 'FeatureCollection', features: addresses.map((a) => ({ properties: { Property_Address: a } })) };
}
const addrs = (collection) => collection.features.map((f) => f.properties.Property_Address);

test('filters to the numeric range and drops non-civic rows', () => {
  const c = fc('100 MAIN', '150 MAIN', '200A MAIN', '250 MAIN', 'NE1-1-3E');
  applyCivicNumberFilter(c, '100', '200');
  // 200A kept (upper "200" spans suffixes); 250 dropped; NE… dropped.
  assert.deepEqual(addrs(c), ['100 MAIN', '150 MAIN', '200A MAIN']);
});

test('letter-bounded range is inclusive and exact', () => {
  const c = fc('100 MAIN', '100A MAIN', '100B MAIN', '100C MAIN', '100D MAIN');
  applyCivicNumberFilter(c, '100A', '100C');
  assert.deepEqual(addrs(c), ['100A MAIN', '100B MAIN', '100C MAIN']);
});

test('a lone box is a contains, not an open-ended bound', () => {
  // Was ">= 100" (which kept 300 X); now "contains 100".
  const from = fc('50 X', '100 X', '300 X', '1100 X');
  applyCivicNumberFilter(from, '100', '');     // To blank
  assert.deepEqual(addrs(from), ['100 X', '1100 X']);

  // Either box alone reads the same way.
  const to = fc('50 X', '100 X', '300 X');
  applyCivicNumberFilter(to, '', '100');       // From blank
  assert.deepEqual(addrs(to), ['100 X']);
});

test('a lone box finds a split number however it is spaced', () => {
  const c = fc('1 106 E ROAD 71 N', '1 122 W ROAD 66 N', 'DESC NE13-11-1W');
  applyCivicNumberFilter(c, '1106', '');
  assert.deepEqual(addrs(c), ['1 106 E ROAD 71 N']);
});

test('contains matches mid-number, unlike exact', () => {
  // "contains 1106" legitimately catches 21106; the exact search does not.
  const loose = fc('1106 MAIN', '21106 MAIN');
  applyCivicNumberFilter(loose, '1106', '');
  assert.deepEqual(addrs(loose), ['1106 MAIN', '21106 MAIN']);

  const exact = fc('1106 MAIN', '21106 MAIN');
  applyCivicNumberFilter(exact, '1106', '1106');
  assert.deepEqual(addrs(exact), ['1106 MAIN']);
});

test('both bounds blank leaves the FC untouched (non-civic rows kept)', () => {
  const c = fc('100 MAIN', 'NE1-1-3E');
  applyCivicNumberFilter(c, '', '');
  assert.deepEqual(addrs(c), ['100 MAIN', 'NE1-1-3E']);
});

test('an exact search on a split number finds it (Rosser roll 76250)', () => {
  // The reported bug: From/To 1106 + muni ROSSER (RM) returned nothing
  // because "1 106 E ROAD 71 N" keyed as civic 1.
  const c = fc('1 106 E ROAD 71 N', '1 122 W ROAD 66 N', 'DESC NE13-11-1W');
  applyCivicNumberFilter(c, '1106', '1106');
  assert.deepEqual(addrs(c), ['1 106 E ROAD 71 N']);
});

test('the split number is also reachable as typed', () => {
  const c = fc('1 106 E ROAD 71 N', '1 122 W ROAD 66 N');
  applyCivicNumberFilter(c, '1 106', '1 106');
  assert.deepEqual(addrs(c), ['1 106 E ROAD 71 N']);
});

test('an exact search still finds civic-on-numeric-road addresses', () => {
  // The other reading of the same shape has to keep working: 32 is the
  // civic number here, not 32502.
  const c = fc('32 502 RD', '74 502 RD', '146 100 RTE');
  applyCivicNumberFilter(c, '32', '32');
  assert.deepEqual(addrs(c), ['32 502 RD']);
});

test('a direction suffix stays inside the exact-search span', () => {
  // The suffix encoding is what makes From=To=<number> work on these:
  // 1106E keys as 110605, inside "1106"'s 110600..110699 span.
  const c = fc('1 106 E ROAD 71 N', '0 107 W ROAD 65 N');
  applyCivicNumberFilter(c, '107', '107');
  assert.deepEqual(addrs(c), ['0 107 W ROAD 65 N']);
});

test('a range spanning both readings keeps the parcel once', () => {
  const c = fc('1 106 E ROAD 71 N');
  applyCivicNumberFilter(c, '1', '2000');
  assert.equal(c.features.length, 1);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
