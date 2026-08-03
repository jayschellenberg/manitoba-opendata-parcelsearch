// Unit tests for the pure helpers behind lib/multiSelect.js — the
// compact class picker that replaced the sales tab's <select multiple
// size="4"> list boxes. The DOM wiring isn't covered (no jsdom in this
// project); these are the two decisions worth pinning down: what the
// closed control says, and what survives an option-list rebuild.
//
// Run: cd web && node test/multiSelect.test.js

import assert from 'node:assert/strict';
import { summarizeSelection, retainSelection } from '../src/lib/multiSelect.js';

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

const fails = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length > 0) process.exit(1);
