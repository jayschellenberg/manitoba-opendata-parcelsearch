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
  dominantSlopeCode,
  slopeSortRank,
  slopeClassBounds,
  parcelSlopeRange,
  slopeRangeText,
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

// ---- Slope column (Manitoba Soil Survey TOPO) ----

test('dominantSlopeCode reads TOPO from the top-share soil', () => {
  const p = { _soilComposition: [{ topo: 'd' }, { topo: 'x' }] };
  assert.equal(dominantSlopeCode(p), 'd');
});

test('dominantSlopeCode is null with no composition or no TOPO', () => {
  assert.equal(dominantSlopeCode({}), null);
  assert.equal(dominantSlopeCode({ _soilComposition: [] }), null);
  assert.equal(dominantSlopeCode(null), null);
  assert.equal(dominantSlopeCode({ _soilComposition: [{ soilName: 'Red River' }] }), null);
});

test('slopeSortRank orders by steepness, not alphabetically', () => {
  // x is the FLATTEST class but the last letter alphabetically — the whole
  // reason this ranking exists rather than sorting the code or the label.
  const codes = ['j', 'x', 'd', 'b'];
  const sorted = codes.slice().sort((a, b) => slopeSortRank(a) - slopeSortRank(b));
  assert.deepEqual(sorted, ['x', 'b', 'd', 'j']);
});

test('slopeSortRank covers every real class in ascending order', () => {
  const order = ['x', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const ranks = order.map(slopeSortRank);
  assert.deepEqual(ranks, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('slopeSortRank is case- and whitespace-insensitive', () => {
  assert.equal(slopeSortRank(' D '), slopeSortRank('d'));
  assert.equal(slopeSortRank('X'), slopeSortRank('x'));
});

test('slopeSortRank puts non-slope specials after every real class', () => {
  const steepest = slopeSortRank('j');
  for (const special of ['$ML', '$UL', '$UR', '$ZZ', '$MH']) {
    assert.ok(slopeSortRank(special) > steepest, `${special} must rank after 'j'`);
  }
});

test('slopeSortRank puts missing codes last of all', () => {
  const special = slopeSortRank('$ZZ');
  for (const empty of [null, undefined, '', '   ']) {
    assert.ok(slopeSortRank(empty) > special, `${JSON.stringify(empty)} must rank last`);
  }
});

// ---- Slope range aggregation ----

const soil = (topo, parcelPct, soilName = 'S') => ({ topo, parcelPct, soilName });

test('slopeClassBounds covers every class; specials return null', () => {
  assert.deepEqual(slopeClassBounds('x'), { min: 0, max: 0.5 });
  assert.deepEqual(slopeClassBounds('e'), { min: 9, max: 15 });
  assert.deepEqual(slopeClassBounds('j'), { min: 100, max: null });
  for (const special of ['$ML', '$UL', '$UR', '$ZZ', '$MH', 'nonsense', null]) {
    assert.equal(slopeClassBounds(special), null, `${special} has no numeric bounds`);
  }
});

test('range spans every class present, not just the dominant one', () => {
  // The whole point: half level, half moderately sloping must NOT read as level.
  const r = parcelSlopeRange({ _soilComposition: [soil('x', 55), soil('e', 45)] });
  assert.equal(r.min, 0);
  assert.equal(r.max, 15);
  assert.equal(slopeRangeText(r), '0 – 15%');
  assert.equal(r.uniform, false);
});

test('a single-class parcel reports that class alone', () => {
  const r = parcelSlopeRange({ _soilComposition: [soil('x', 100)] });
  assert.equal(slopeRangeText(r), '0 – 0.5%');
  assert.equal(r.uniform, true);
});

test('soils sharing a class are summed into one part', () => {
  // Three soils, one class — the summary must read as a single 94% line,
  // not three separate lines for the same stretch of ground.
  const r = parcelSlopeRange({
    _soilComposition: [soil('x', 50, 'A'), soil('x', 28, 'B'), soil('x', 16, 'C')],
  });
  assert.equal(r.parts.length, 1);
  assert.equal(r.parts[0].pct, 94);
  assert.equal(r.uniform, true);
  assert.equal(slopeRangeText(r), '0 – 0.5%');
});

test('grouping by class does not merge different classes', () => {
  const r = parcelSlopeRange({
    _soilComposition: [soil('x', 40, 'A'), soil('c', 35, 'B'), soil('x', 25, 'C')],
  });
  assert.deepEqual(r.parts, [{ code: 'x', pct: 65 }, { code: 'c', pct: 35 }]);
  assert.equal(r.uniform, false);
});

test('parts are ordered primary-first by share', () => {
  const r = parcelSlopeRange({ _soilComposition: [soil('e', 20), soil('x', 70), soil('c', 10)] });
  assert.deepEqual(r.parts.map((p) => p.code), ['x', 'e', 'c']);
});

test('steepestCode drives the sort, independent of share', () => {
  // The steep class is the MINORITY here; sorting must still see it.
  const r = parcelSlopeRange({ _soilComposition: [soil('x', 90), soil('g', 10)] });
  assert.equal(r.steepestCode, 'g');
  assert.equal(r.max, 45);
});

test('non-slope specials and the Other row count as unclassified', () => {
  const r = parcelSlopeRange({
    _soilComposition: [
      soil('x', 60),
      soil('$ZZ', 25),                            // water — no slope
      { isOther: true, topo: null, parcelPct: 8 }, // capped remainder
    ],
  });
  assert.equal(r.coveragePct, 60);
  assert.equal(Math.round(r.unclassifiedPct), 33);
  assert.equal(slopeRangeText(r), '0 – 0.5%');
});

test('open-ended top class reports no upper bound', () => {
  const r = parcelSlopeRange({ _soilComposition: [soil('j', 100)] });
  assert.equal(r.max, null);
  assert.equal(slopeRangeText(r), '>100%');
});

test('null when nothing is stamped or no component carries a slope', () => {
  assert.equal(parcelSlopeRange({}), null);
  assert.equal(parcelSlopeRange({ _soilComposition: [] }), null);
  assert.equal(parcelSlopeRange(null), null);
  assert.equal(parcelSlopeRange({ _soilComposition: [soil('$ZZ', 100)] }), null);
  assert.equal(slopeRangeText(null), '');
});

test('zero and negative shares do not enter the range', () => {
  const r = parcelSlopeRange({ _soilComposition: [soil('x', 100), soil('g', 0)] });
  assert.equal(r.max, 0.5, 'a 0% component must not widen the range');
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
