// Tests for lib/condoUnit.js — the Sales tab's Condo units filter.
//
// Run: cd web && node test/condoUnit.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CONDO_FILTER_MODES, condoUnitOf, condoUnitLabel, condoSortKey,
  condoSaleKeys, saleKeyOf, passesCondoFilter,
} from '../src/lib/condoUnit.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');

test('a leading single-dash plan-unit pair is a condo unit', () => {
  assert.deepEqual(condoUnitOf('DESC 1-39000', '39000-1 UNDIVIDED 1.5% INTEREST'), { plan: '39000', units: ['1'] });
  assert.deepEqual(condoUnitOf('', '00412-007'), { plan: '412', units: ['7'] });
});

test('a unit range and a repeated plan list every unit once', () => {
  assert.deepEqual(condoUnitOf('', '39000-1/3'), { plan: '39000', units: ['1', '2', '3'] });
  assert.deepEqual(condoUnitOf('DESC 1/4-39000', '39000-1 39000-2'), { plan: '39000', units: ['1', '2', '3', '4'] });
});

test('a lot on a plan is not a condo unit', () => {
  // The double dash is lot--plan; mid-text pairs are ambiguous and ignored.
  assert.equal(condoUnitOf('DESC 4-66600', '4--66600'), null);
  assert.equal(condoUnitOf('', 'RL-6-GP-3909 6-3909'), null);
  assert.equal(condoUnitOf('', 'NE 12-3-4W'), null);
  assert.equal(condoUnitOf('', ''), null);
  assert.equal(condoUnitOf(null, undefined), null);
});

test('the grid label names the plan and its units, capped', () => {
  assert.equal(condoUnitLabel('39000', ['1']), '39000 - 1');
  assert.equal(condoUnitLabel('39000', '1,2,3'), '39000 - 1, 2, 3');
  assert.equal(condoUnitLabel('39000', ['1', '2', '3', '4', '5', '6']), '39000 - 1, 2, 3, 4 +2');
  assert.equal(condoUnitLabel('39000', []), '39000');
  assert.equal(condoUnitLabel('', ['1']), '');
  assert.equal(condoUnitLabel(null, null), '');
});

test('sorting keeps a plan together, unit order inside it, non-units last', () => {
  const keys = [
    condoSortKey('39000', ['12']), condoSortKey('412', ['7']),
    condoSortKey(null, null), condoSortKey('39000', ['2']),
  ];
  const sorted = [...keys].sort((a, b) => a - b);
  assert.deepEqual(sorted, [keys[1], keys[3], keys[0], keys[2]]);
});

const row = (props) => ({ parcel: { properties: props } });

test('a sale is a condo sale when any of its parcels is a unit', () => {
  const rows = [
    row({ _saleGroupId: 1, _condoPlan: '39000' }),
    row({ _saleGroupId: 1 }),                       // same sale, not a unit
    row({ _saleGroupId: 2 }),
    row({ _condoPlan: '412' }),                     // ungrouped
    row({}),
  ];
  const keys = condoSaleKeys(rows);
  assert.deepEqual([...keys].sort(), ['g:1', 'r:3']);
  assert.equal(keys.has(saleKeyOf(rows[1].parcel.properties, 1)), true, 'whole assembly counts');
  assert.equal(keys.has(saleKeyOf(rows[2].parcel.properties, 2)), false);
  assert.equal(keys.has(saleKeyOf(rows[4].parcel.properties, 4)), false);
  assert.deepEqual([...condoSaleKeys(null)], []);
});

test('Any passes everything; Only and Exclude are exact complements', () => {
  for (const isCondo of [true, false]) {
    assert.equal(passesCondoFilter('any', isCondo), true);
    assert.equal(passesCondoFilter(undefined, isCondo), true);
    assert.notEqual(passesCondoFilter('only', isCondo), passesCondoFilter('exclude', isCondo));
  }
  assert.equal(passesCondoFilter('only', true), true);
  assert.equal(passesCondoFilter('exclude', true), false);
});

test('the control, the column and the filter step are wired', () => {
  const html = read('index.html');
  const main = read('src/main.js');
  assert.match(html, /<select id="sales-condo-filter"/);
  for (const mode of CONDO_FILTER_MODES) {
    assert.match(html, new RegExp(`<option value="${mode}"`), `option ${mode}`);
  }
  assert.match(html, /<th data-col="condo"/);
  assert.match(main, /fail\('Condo units'\)/);
  // A fail() label missing from SALES_FILTER_STEPS counts the row as passing.
  const at = main.indexOf('const SALES_FILTER_STEPS');
  const steps = main.slice(at, main.indexOf('];', at));
  assert.match(steps, /'Condo units'/);
});

console.log(`\ncondoUnit: ${passed} tests passed`);
