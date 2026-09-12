// lib/cliRollup.js — per-CLI-class rollup of a soil composition.
// Run: cd web && node test/cliRollup.test.js
import assert from 'node:assert/strict';
import { cliClassRollup } from '../src/lib/cliRollup.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const rows = [
  { soilName: 'Red River', agriCap: '2W', agcapCls: '2', parcelPct: 40, areaAcres: 40 },
  { soilName: 'Osborne',   agriCap: '3W', agcapCls: '3', parcelPct: 30, areaAcres: 30 },
  { soilName: 'Scanterbury', agriCap: '2W', agcapCls: '2', parcelPct: 20, areaAcres: 20 },
  { soilName: 'Marsh',     agriCap: '3NW', agcapCls: '3', parcelPct: 10, areaAcres: 10 },
];

test('sums the same class across soils and sorts by share', () => {
  assert.deepEqual(cliClassRollup(rows), [
    { cls: '2W', agcapCls: '2', parcelPct: 60, areaAcres: 60 },
    { cls: '3W', agcapCls: '3', parcelPct: 30, areaAcres: 30 },
    { cls: '3NW', agcapCls: '3', parcelPct: 10, areaAcres: 10 },
  ]);
});

test('ignores the Other remainder row and zero / missing shares', () => {
  const r = cliClassRollup([...rows, { isOther: true, parcelPct: 5 }, { agriCap: '4', parcelPct: 0 }, { agriCap: '5', parcelPct: NaN }]);
  assert.equal(r.length, 3);
});

test('caps at maxRows and folds the rest into Other classes', () => {
  const many = ['1', '2W', '3W', '4M', '5M', '6T', '7'].map((c, i) => ({ agriCap: c, agcapCls: c[0], parcelPct: 20 - i * 2, areaAcres: 20 - i * 2 }));
  const r = cliClassRollup(many, { maxRows: 3 });
  assert.equal(r.length, 4);
  assert.deepEqual(r.map((c) => c.cls), ['1', '2W', '3W', 'Other classes']);
  assert.equal(r[3].isOther, true);
  assert.equal(r[3].parcelPct, 14 + 12 + 10 + 8);
});

test('acres stay null when no row carried acres', () => {
  const r = cliClassRollup([{ agriCap: '2W', parcelPct: 50 }, { agriCap: '2W', parcelPct: 10 }]);
  assert.deepEqual(r, [{ cls: '2W', agcapCls: '2W', parcelPct: 60, areaAcres: null }]);
});

test('rows without a class read as Unrated; empty input is empty', () => {
  assert.equal(cliClassRollup([{ parcelPct: 30 }])[0].cls, 'Unrated');
  assert.deepEqual(cliClassRollup([]), []);
  assert.deepEqual(cliClassRollup(null), []);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
