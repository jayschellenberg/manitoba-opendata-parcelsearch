// Unit tests for the pure helpers behind lib/multiSelect.js — the
// compact class picker that replaced the sales tab's <select multiple
// size="4"> list boxes. The DOM wiring isn't covered (no jsdom in this
// project); these are the two decisions worth pinning down: what the
// closed control says, and what survives an option-list rebuild.
//
// Run: cd web && node test/multiSelect.test.js

import assert from 'node:assert/strict';
import { summarizeSelection, retainSelection, flattenGroups } from '../src/lib/multiSelect.js';

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

const OPTS = { placeholder: 'Any class', noun: 'classes' };

console.log('summarizeSelection');

test('nothing selected reads as the placeholder', () => {
  assert.equal(summarizeSelection([], OPTS), 'Any class');
  assert.equal(summarizeSelection(null, OPTS), 'Any class');
  assert.equal(summarizeSelection(undefined, OPTS), 'Any class');
});

test('one selection names it rather than counting it', () => {
  assert.equal(summarizeSelection(['RESIDENTIAL 1'], OPTS), 'RESIDENTIAL 1');
});

test('two or more collapse to a count', () => {
  assert.equal(summarizeSelection(['RESIDENTIAL 1', 'OTHER PROPERTY'], OPTS), '2 classes');
  assert.equal(
    summarizeSelection(['A', 'B', 'C', 'D'], OPTS),
    '4 classes',
  );
});

test('blank and null entries do not inflate the count', () => {
  assert.equal(summarizeSelection(['', null, 'FARM PROPERTY'], OPTS), 'FARM PROPERTY');
  assert.equal(summarizeSelection(['', null], OPTS), 'Any class');
});

test('defaults are sane when no labels are supplied', () => {
  assert.equal(summarizeSelection([]), 'Any');
  assert.equal(summarizeSelection(['x', 'y']), '2 selected');
});

console.log('\nretainSelection');

test('selections that still exist in the new list survive', () => {
  assert.deepEqual(
    retainSelection(['RESIDENTIAL 1', 'FARM PROPERTY'], ['FARM PROPERTY', 'OTHER PROPERTY', 'RESIDENTIAL 1']),
    ['RESIDENTIAL 1', 'FARM PROPERTY'],
  );
});

test('selections the new upload no longer offers are dropped', () => {
  assert.deepEqual(
    retainSelection(['RESIDENTIAL 1', 'FARM PROPERTY'], ['OTHER PROPERTY', 'FARM PROPERTY']),
    ['FARM PROPERTY'],
  );
});

test('an empty option list clears everything', () => {
  assert.deepEqual(retainSelection(['RESIDENTIAL 1'], []), []);
});

test('empty or missing inputs are safe', () => {
  assert.deepEqual(retainSelection([], ['A']), []);
  assert.deepEqual(retainSelection(null, ['A']), []);
  assert.deepEqual(retainSelection(['A'], null), []);
});

console.log('\ngrouped mode');

// The shape setGroups() takes — the Primary Property tree, whose labels are
// NOT unique across groups ("Other" appears under two families), which is
// why a tick's value is a composite key rather than the visible text.
const GROUPS = [
  { family: 'Residential', count: 3, options: [
    { value: 'Residential|One storey', label: 'One storey', count: 2 },
    { value: 'Residential|Other',      label: 'Other',      count: 1 },
  ] },
  { family: 'ICI', count: 1, options: [
    { value: 'ICI|Other', label: 'Other', count: 1 },
  ] },
];

test('flattenGroups returns the leaves in display order', () => {
  assert.deepEqual(
    flattenGroups(GROUPS).map((o) => o.value),
    ['Residential|One storey', 'Residential|Other', 'ICI|Other'],
  );
});

test('flattenGroups is safe on empty and missing input', () => {
  assert.deepEqual(flattenGroups([]), []);
  assert.deepEqual(flattenGroups(null), []);
  assert.deepEqual(flattenGroups([{ family: 'Farm' }]), []);   // no options key
});

test('the same label under two groups stays two distinct values', () => {
  const values = flattenGroups(GROUPS).map((o) => o.value);
  assert.equal(new Set(values).size, values.length);
});

test('a single grouped selection reads as its LABEL, not its key', () => {
  // Without labelOf the closed control would read "Residential|One storey".
  const labelOf = (v) => flattenGroups(GROUPS).find((o) => o.value === v)?.label ?? v;
  assert.equal(
    summarizeSelection(['Residential|One storey'], { placeholder: 'Any type', noun: 'types', labelOf }),
    'One storey',
  );
});

test('labelOf is ignored once the summary collapses to a count', () => {
  const labelOf = () => 'never shown';
  assert.equal(
    summarizeSelection(['a', 'b'], { noun: 'types', labelOf }),
    '2 types',
  );
});

test('an unknown value falls back to itself rather than rendering undefined', () => {
  const labelOf = (v) => ({}) [v];
  assert.equal(summarizeSelection(['ICI|Ghost'], { labelOf }), 'ICI|Ghost');
});

test('retainSelection works on composite keys too', () => {
  const values = flattenGroups(GROUPS).map((o) => o.value);
  assert.deepEqual(
    retainSelection(['Residential|Other', 'Farm|Grain storage'], values),
    ['Residential|Other'],
  );
});

const fails = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length > 0) process.exit(1);
