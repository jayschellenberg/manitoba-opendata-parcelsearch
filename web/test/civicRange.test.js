// Characterization tests for lib/civicRange.js — the civic-number range
// filter behind the address search. The expected key values come
// straight from the functions' documented examples.
//
// Run: cd web && node test/civicRange.test.js

import assert from 'node:assert/strict';
import {
  parseCivicAddressKey,
  parseCivicBound,
  applyCivicNumberRange,
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
  assert.equal(parseCivicBound('100 MAIN', 'lower'), null);  // anchored, no spaces
});

console.log('\napplyCivicNumberRange');

function fc(...addresses) {
  return { type: 'FeatureCollection', features: addresses.map((a) => ({ properties: { Property_Address: a } })) };
}
const addrs = (collection) => collection.features.map((f) => f.properties.Property_Address);

test('filters to the numeric range and drops non-civic rows', () => {
  const c = fc('100 MAIN', '150 MAIN', '200A MAIN', '250 MAIN', 'NE1-1-3E');
  applyCivicNumberRange(c, '100', '200');
  // 200A kept (upper "200" spans suffixes); 250 dropped; NE… dropped.
  assert.deepEqual(addrs(c), ['100 MAIN', '150 MAIN', '200A MAIN']);
});

test('letter-bounded range is inclusive and exact', () => {
  const c = fc('100 MAIN', '100A MAIN', '100B MAIN', '100C MAIN', '100D MAIN');
  applyCivicNumberRange(c, '100A', '100C');
  assert.deepEqual(addrs(c), ['100A MAIN', '100B MAIN', '100C MAIN']);
});

test('open-ended bounds (blank from or to)', () => {
  const lower = fc('50 X', '100 X', '300 X');
  applyCivicNumberRange(lower, '100', '');     // no upper
  assert.deepEqual(addrs(lower), ['100 X', '300 X']);

  const upper = fc('50 X', '100 X', '300 X');
  applyCivicNumberRange(upper, '', '100');     // no lower
  assert.deepEqual(addrs(upper), ['50 X', '100 X']);
});

test('both bounds blank leaves the FC untouched (non-civic rows kept)', () => {
  const c = fc('100 MAIN', 'NE1-1-3E');
  applyCivicNumberRange(c, '', '');
  assert.deepEqual(addrs(c), ['100 MAIN', 'NE1-1-3E']);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
