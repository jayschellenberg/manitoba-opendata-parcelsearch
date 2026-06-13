// Characterization tests for lib/cellFormat.js — pin the existing
// behaviour of the pure cell/value formatters extracted from main.js's
// renderTable, so the extraction is provably byte-for-byte equivalent.
//
// Run: cd web && node test/cellFormat.test.js

import assert from 'node:assert/strict';
import {
  realStr,
  legalDisplay,
  parseTitleNumbers,
  dominantCliLabel,
  dominantSoilTypeLabel,
} from '../src/lib/cellFormat.js';

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

console.log('realStr');

test('treats null / empty / sentinels as no-value', () => {
  assert.equal(realStr(null), null);
  assert.equal(realStr(undefined), null);
  assert.equal(realStr(''), null);
  assert.equal(realStr('   '), null);
  assert.equal(realStr('<Null>'), null);
  assert.equal(realStr('null'), null);
  assert.equal(realStr('NULL'), null);   // case-insensitive
});

test('returns the trimmed string for real content', () => {
  assert.equal(realStr('  PCL G  '), 'PCL G');
  assert.equal(realStr(42), '42');
  assert.equal(realStr('nullish'), 'nullish');  // only exact "null" is a sentinel
});

console.log('\nlegalDisplay');

test('prefers the full legal description', () => {
  assert.equal(legalDisplay({ _legalDescription: 'PCL G PLAN 1234' }), 'PCL G PLAN 1234');
});

test('falls back to L/B/P summary joined with " · "', () => {
  assert.equal(legalDisplay({ _lot: '5', _block: '2', _plan: '900' }), 'L 5 · B 2 · P 900');
  assert.equal(legalDisplay({ _lot: '5', _plan: '900' }), 'L 5 · P 900');
});

test('falls back to legal detail, then null', () => {
  assert.equal(legalDisplay({ _legalDetail: 'see plan' }), 'see plan');
  assert.equal(legalDisplay({}), null);
  assert.equal(legalDisplay(), null);
});

test('ignores <Null> sentinels in every field', () => {
  assert.equal(legalDisplay({ _legalDescription: '<Null>', _lot: '5' }), 'L 5');
});

console.log('\nparseTitleNumbers');

test('extracts numbers from a single and multi title string', () => {
  assert.deepEqual(parseTitleNumbers('3317402 / WINNIPEG'), ['3317402']);
  assert.deepEqual(parseTitleNumbers('2464089 / WINNIPEG; 2464090 / BRANDON'), ['2464089', '2464090']);
});

test('handles alphanumeric prefix forms and stray whitespace', () => {
  assert.deepEqual(parseTitleNumbers('  D15630 / X ;  D15631 / Y '), ['D15630', 'D15631']);
});

test('empty / nullish input yields an empty array', () => {
  assert.deepEqual(parseTitleNumbers(''), []);
  assert.deepEqual(parseTitleNumbers(null), []);
  assert.deepEqual(parseTitleNumbers(';;'), []);
});

console.log('\ndominantCliLabel / dominantSoilTypeLabel');

test('read the top soil-composition entry', () => {
  const p = { _soilComposition: [{ agriCap: '2', soilName: 'Red River' }] };
  assert.equal(dominantCliLabel(p), '2');
  assert.equal(dominantSoilTypeLabel(p), 'Red River');
});

test('fall back to alternate keys', () => {
  const p = { _soilComposition: [{ agcapCls: '3', soilCode: 'RDR' }] };
  assert.equal(dominantCliLabel(p), '3');
  assert.equal(dominantSoilTypeLabel(p), 'RDR');
});

test('null when no composition is stamped', () => {
  assert.equal(dominantCliLabel({}), null);
  assert.equal(dominantCliLabel({ _soilComposition: [] }), null);
  assert.equal(dominantSoilTypeLabel(null), null);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
