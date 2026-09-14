// Unit tests for lib/muniLabel.js — how a municipality reads on screen in
// the two places the app lists them: the Property Search picker and the
// Sales tab's municipality checkboxes.
//
// They share this module so they cannot drift apart: same separator, same
// order (name first), same silence when the number is unknown.
//
// Run: cd web && node test/muniLabel.test.js

import assert from 'node:assert/strict';
import {
  formatMuniWithNumber,
  muniNumberIndex,
  muniOptionLabel,
  muniMatchesFilter,
} from '../src/lib/muniLabel.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}
    ${err.message}`);
  }
}

console.log('municipality numbers on the labels');

const MANIFEST = {
  snapshot_date: '2026-09-06',
  munis: {
    'ARBORG (TOWN)': { file: 'ARBORG_TOWN.json', count: 656, muni_no: 300 },
    'ALEXANDER (RM)': { file: 'ALEXANDER_RM.json', count: 7242, muni_no: 600 },
  },
};

test('the number comes off the snapshot manifest, keyed by picker name', () => {
  const numbers = muniNumberIndex(MANIFEST);
  assert.equal(numbers.get('ARBORG (TOWN)'), 300);
  assert.equal(numbers.get('ALEXANDER (RM)'), 600);
  assert.equal(numbers.size, 2);
});

test('no manifest, or a shape we do not recognise, yields no numbers', () => {
  for (const bad of [null, undefined, {}, { munis: null }, { munis: 'x' }]) {
    assert.equal(muniNumberIndex(bad).size, 0);
  }
});

test('an entry without a usable muni_no is skipped, not stored as NaN', () => {
  const numbers = muniNumberIndex({ munis: {
    'GOOD (TOWN)': { muni_no: 12 },
    'NO NUMBER (RM)': { count: 5 },
    'JUNK (RM)': { muni_no: 'not a number' },
  } });
  assert.deepEqual([...numbers], [['GOOD (TOWN)', 12]]);
});

test('muni_no 0 survives — it is a number, not an absence', () => {
  assert.equal(muniNumberIndex({ munis: { 'ZERO (RM)': { muni_no: 0 } } }).get('ZERO (RM)'), 0);
  assert.equal(muniOptionLabel('ZERO (RM)', muniNumberIndex({ munis: { 'ZERO (RM)': { muni_no: 0 } } })), 'ZERO (RM) - 0');
});

test('the label appends the number: "ARBORG (TOWN) - 300"', () => {
  assert.equal(muniOptionLabel('ARBORG (TOWN)', muniNumberIndex(MANIFEST)), 'ARBORG (TOWN) - 300');
});

test('the name leads, so the select type-ahead still matches on it', () => {
  // Typing "ARB" in a focused <select> jumps to the first option whose text
  // STARTS with it; a leading number would break that and the sort order.
  assert.ok(muniOptionLabel('ARBORG (TOWN)', muniNumberIndex(MANIFEST)).startsWith('ARBORG (TOWN)'));
});

test('an unknown municipality reads as its bare name', () => {
  const numbers = muniNumberIndex(MANIFEST);
  assert.equal(muniOptionLabel('SOMEWHERE (RM)', numbers), 'SOMEWHERE (RM)');
});

test('no numbers at all (manifest never landed) reads as bare names', () => {
  assert.equal(muniOptionLabel('ARBORG (TOWN)', new Map()), 'ARBORG (TOWN)');
  assert.equal(muniOptionLabel('ARBORG (TOWN)', null), 'ARBORG (TOWN)');
  assert.equal(muniOptionLabel('ARBORG (TOWN)'), 'ARBORG (TOWN)');
});

console.log('the shared name-and-number formatter');

test('the Sales tab formats straight from its own muni_no', () => {
  // The sales manifest is keyed BY number, so there is no lookup — but the
  // result has to be character-for-character what the picker shows.
  assert.equal(formatMuniWithNumber('ARBORG (TOWN)', '300'), 'ARBORG (TOWN) - 300');
  assert.equal(
    formatMuniWithNumber('ARBORG (TOWN)', '300'),
    muniOptionLabel('ARBORG (TOWN)', muniNumberIndex(MANIFEST)),
  );
});

test('a number-shaped string and a number read the same', () => {
  assert.equal(formatMuniWithNumber('X (RM)', '42'), formatMuniWithNumber('X (RM)', 42));
});

test('no number, empty string or junk gives the bare name', () => {
  for (const n of [null, undefined, '', 'not a number', NaN]) {
    assert.equal(formatMuniWithNumber('X (RM)', n), 'X (RM)');
  }
});

console.log('the Sales tab filter box');

const ARBORG = { label: 'ARBORG (TOWN)', no: '300' };
const ALONSA = { label: 'ALONSA (RM)', no: '601' };

test('an empty filter matches everything', () => {
  assert.equal(muniMatchesFilter('', ARBORG), true);
  assert.equal(muniMatchesFilter('   ', ARBORG), true);
  assert.equal(muniMatchesFilter(null, ARBORG), true);
});

test('the name still matches, case-insensitively', () => {
  assert.equal(muniMatchesFilter('arb', ARBORG), true);
  assert.equal(muniMatchesFilter('ARB', ARBORG), true);
  assert.equal(muniMatchesFilter('alon', ARBORG), false);
});

test('the muni number matches — it is on screen, so it must be findable', () => {
  assert.equal(muniMatchesFilter('300', ARBORG), true);
  assert.equal(muniMatchesFilter('300', ALONSA), false);
  assert.equal(muniMatchesFilter('601', ALONSA), true);
});

test('a partial number matches, the same way a partial name does', () => {
  assert.equal(muniMatchesFilter('30', ARBORG), true);
  assert.equal(muniMatchesFilter('60', ALONSA), true);
});

test('a municipality with no number is still filtered by name', () => {
  const noNumber = { label: 'SOMEWHERE (RM)' };
  assert.equal(muniMatchesFilter('some', noNumber), true);
  assert.equal(muniMatchesFilter('300', noNumber), false);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`
${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
