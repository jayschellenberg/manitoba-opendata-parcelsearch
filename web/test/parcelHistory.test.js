// Unit tests for src/lib/parcelHistory.js — matching a sale to the outline
// its roll had on the sale date, from the published change shards.
//
// The fixture is the same reshape as r/test_parcel_history.R ("equal-area
// shift"), so the browser and R agree on which dates are certain, which are
// ambiguous, and that the change window's boundary days are ambiguous too.
//
// Run: cd web && node test/parcelHistory.test.js

import assert from 'node:assert/strict';
import {
  toIsoDay, matchSaleToHistory, historyLabel, historyRank, fmtDay, fmtArea,
  changeWindowText, priorOutlineHtml, saleHistoryHtml, saleOutlineFeatures,
  historyMuniNoForName, historicalRollFeatures,
} from '../src/lib/parcelHistory.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const index = { first_snapshot: '2026-01-01', last_snapshot: '2026-01-22' };
// Old outline seen 01-01..01-15, gone by 01-22; new outline from 01-22 (current).
const rolls = {
  '1.000': [
    { fs: '2026-01-01', ls: '2026-01-15', onb: null, cna: '2026-01-22', o: 'baseline', c: 'reshaped', a: 40000 },
    { fs: '2026-01-22', onb: '2026-01-15', cna: null, o: 'reshaped', c: null, a: 40000 },
  ],
  // A roll carved out on 2026-01-22 from roll 1.000.
  '1.100': [
    { fs: '2026-01-22', onb: '2026-01-15', cna: null, o: 'new', c: null, a: 900,
      from: ['1.000'], rel: 'subdivision_retained_parent' },
  ],
};
const st = (roll, d) => matchSaleToHistory(rolls, roll, d, index);

test('toIsoDay uses the local calendar day', () => {
  assert.equal(toIsoDay(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(toIsoDay(new Date('nope')), null);
});

test('inside the old outline\'s observed span: prior, certain', () => {
  const m = st('1.000', '2026-01-10');
  assert.equal(m.state, 'prior');
  assert.equal(m.certain, true);
});

test('the change window and its boundary days are ambiguous', () => {
  for (const d of ['2026-01-15', '2026-01-18', '2026-01-22']) {
    const m = st('1.000', d);
    assert.equal(m.state, 'ambiguous', d);
    assert.equal(m.candidates.length, 2, d);
  }
});

test('after the latest snapshot: current, but not observed (not certain)', () => {
  const m = st('1.000', '2026-02-01');
  assert.equal(m.state, 'current');
  assert.equal(m.certain, false);
});

test('before the first snapshot: the first outline, flagged censored', () => {
  const m = st('1.000', '2025-06-01');
  assert.equal(m.state, 'prior');
  assert.equal(m.censored, true);
  assert.equal(m.certain, false);
});

test('roll with no changes: current; censored only before the history began', () => {
  assert.deepEqual([st('9.000', '2026-01-10').state, st('9.000', '2026-01-10').censored], ['current', false]);
  assert.equal(st('9.000', '2025-01-10').censored, true);
  assert.equal(historyLabel(st('9.000', '2025-01-10')), 'Same since history began');
});

test('a sale before a new roll existed: not_yet, with its parent roll', () => {
  const m = st('1.100', '2026-01-05');
  assert.equal(m.state, 'not_yet');
  assert.deepEqual(m.earliest.from, ['1.000']);
  // "Not mapped yet", not "did not exist": MAO assesses and sells new lots
  // before the province maps them.
  assert.equal(historyLabel(m), 'Not yet mapped at sale');
  assert.match(saleHistoryHtml(m, index), /not yet on the province's parcel map/);
  assert.match(saleHistoryHtml(m, index), /carved from 1\.000/);
});

test('no sale date: unknown, no label, ranked last', () => {
  const m = matchSaleToHistory(rolls, '1.000', null, index);
  assert.equal(m.state, 'unknown');
  assert.equal(historyLabel(m), null);
  assert.equal(historyRank(m), 9);
});

test('ranking puts changed parcels first', () => {
  assert.ok(historyRank(st('1.000', '2026-01-10')) < historyRank(st('1.000', '2026-01-18')));
  assert.ok(historyRank(st('1.000', '2026-01-18')) < historyRank(st('1.000', '2026-02-01')));
});

test('formatting: dates without leading zeros, area in m2 and acres', () => {
  assert.equal(fmtDay('2026-07-01'), 'Jul 1, 2026');
  assert.equal(fmtArea(4046.8564224), '4,047 m² (1.00 ac)');
  assert.equal(changeWindowText(rolls['1.000'][0], index), 'between Jan 15, 2026 and Jan 22, 2026');
});

test('popup text gives a window, never a single change date', () => {
  const html = priorOutlineHtml({ roll: '1.000', fs: '2026-01-01', ls: '2026-01-15', cna: '2026-01-22',
                                  c: 'reshaped', a: 40000, a2: 39000, to: '1.100',
                                  rel: 'subdivision_retained_parent' }, index);
  assert.match(html, /between Jan 15, 2026 and Jan 22, 2026/);
  assert.match(html, /does not publish the actual change date/);
  assert.match(html, /40,000 m² .*→ 39,000 m²/);
  assert.match(html, /1\.000 \(same roll\), 1\.100/);
  assert.doesNotMatch(html, /changed on/i);
});

test('popup text escapes data', () => {
  const html = priorOutlineHtml({ roll: '<b>x</b>', ls: '2026-01-15', cna: '2026-01-22', c: 'retired', a: 1 }, index);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

test('sale outline features: the superseded outline(s) only', () => {
  const shard = { outlines: { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: null, properties: { roll: '1.000', fs: '2026-01-01' } },
    { type: 'Feature', geometry: null, properties: { roll: '2.000', fs: '2026-01-01' } },
  ] } };
  assert.equal(saleOutlineFeatures(shard, '1.000', st('1.000', '2026-01-10')).length, 1);
  assert.equal(saleOutlineFeatures(shard, '1.000', st('1.000', '2026-01-18')).length, 1);
  assert.equal(saleOutlineFeatures(shard, '1.000', st('1.000', '2026-02-01')).length, 0);
});

// ---- retired rolls drawn from the history ----
const rIndex = { ...index, munis: { '165': { name: 'RITCHOT (RM)' }, '101': { name: 'ALONSA (RM)' } } };
const rShard = {
  rolls: {
    // Retired: two outlines, both closed.
    '5.000': [
      { fs: '2026-01-01', ls: '2026-01-08', onb: null, cna: '2026-01-15', o: 'baseline', c: 'reshaped', a: 1000 },
      { fs: '2026-01-15', ls: '2026-01-15', onb: '2026-01-08', cna: '2026-01-22', o: 'reshaped', c: 'retired', a: 900,
        to: ['6.000'], rel: 'consolidation' },
    ],
    // Still current: must not be rescued.
    '1.000': rolls['1.000'],
  },
  outlines: { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      properties: { roll: '5.000', fs: '2026-01-01', ls: '2026-01-08', cna: '2026-01-15', c: 'reshaped' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] },
      properties: { roll: '5.000', fs: '2026-01-15', ls: '2026-01-15', cna: '2026-01-22', c: 'retired' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 3], [0, 0]]] },
      properties: { roll: '1.000', fs: '2026-01-01', ls: '2026-01-15', cna: '2026-01-22', c: 'reshaped' } },
  ] },
};

test('muni name -> number from the change index, case/space-insensitive', () => {
  assert.equal(historyMuniNoForName(rIndex, 'ritchot  (rm)'), 165);
  assert.equal(historyMuniNoForName(rIndex, 'NOWHERE (RM)'), null);
  assert.equal(historyMuniNoForName(null, 'RITCHOT (RM)'), null);
});

test('retired roll becomes a feature from its LAST outline; a current roll is not rescued', () => {
  const feats = historicalRollFeatures(rShard, ['5.000', '1.000', '7.000'], { muniNo: 165, muniName: 'RITCHOT (RM)' });
  assert.equal(feats.length, 1);
  const p = feats[0].properties;
  assert.equal(p.Roll_No_Txt, '5.000');
  assert.equal(p.Municipality, '165 - RITCHOT (RM)');
  assert.equal(p._fromHistory, true);
  assert.ok(p.OBJECTID >= 2_000_000_000, 'synthetic OBJECTID outside ROLL_ENTRY range');
  assert.deepEqual(feats[0].geometry.coordinates[0][1], [2, 0]);
});

test('a sale on a retired roll matches its outline and the popup says the roll is gone', () => {
  const m = matchSaleToHistory(rShard.rolls, '5.000', '2026-01-18', rIndex);
  assert.equal(m.state, 'prior');
  const html = saleHistoryHtml(m, rIndex);
  assert.match(html, /This roll no longer exists/);
  assert.match(html, /retired between Jan 15, 2026 and Jan 22, 2026/);
  assert.match(html, /land now in 6\.000/);
  // After retirement there is no candidate at all.
  assert.equal(matchSaleToHistory(rShard.rolls, '5.000', '2026-02-01', rIndex).state, 'retired');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
