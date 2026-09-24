// Unit tests for src/lib/provinceSearch.js — the province-wide class search.
//
// Pins the rules Jason set (2026-09-24) and the failure modes that would
// quietly return the wrong comp set:
//
//   * Class is the class AT THE SALE, from the export's stacked
//     "Class At Sale" column, and a multi-roll sale matches if ANY roll
//     carries the class.
//   * A sale with no class is UNKNOWN, reachable only by asking for it.
//   * Price bounds test the WHOLE sale's consideration; min and max are
//     both optional.
//   * The property-type list is counted over the class/date/type/price set
//     and does not shrink as property types are ticked.
//   * Rows come back out of the shard VERBATIM (quoted multi-line cells
//     included), so the existing parser sees what a municipality load gives.
//   * A shard exported before the class column refuses to index, rather
//     than filing every sale as unknown and finding nothing.
//   * The panel is actually wired into main.js (comment-stripped source).
//
// Run: cd web && node test/provinceSearch.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classBitsOf, classMask, indexShard, KeyTable, runSearch, extractRows, describeCriteria,
  listSaved, saveSearch, deleteSaved, SAVED_KEY, dateKey, CLASS_CODES, defaultDateWindow,
} from '../src/lib/provinceSearch.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push([true, name]); } catch (err) { results.push([false, name, err]); }
}

const HEADER = 'muni_no,Municipality,Sale Date,sale_date_parsed,Consideration,consideration_num,'
  + 'Roll Number,Primary Property,Sale Type Group,Class At Sale,Class Source';
const row = (cells) => cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');

// Newest first, as the export writes shards.
const SHARD = [
  HEADER,
  // 1: warehouse, class 60, $900k, 2024
  row(['101', 'X', 'Mar 01, 2024', '2024-03-01', '$900,000', '900000', '100.000',
    'AVERAGE FRAME WAREHOUSE', 'ICI LAND AND BUILDINGS', '60', 'pdf']),
  // 2: two rolls — residential + commercial bare land; any-roll rule
  row(['101', 'X', 'Jun 01, 2020', '2020-06-01', '$300,000', '300000', '200.000\n201.000',
    '1 STY RES AVG QUALITY\n', 'RESIDENTIAL LAND AND BUILDINGS', '11\n60', 'pdf\ntax_year']),
  // 3: class 60 retail, $150k, 2016
  row(['101', 'X', 'Jan 05, 2016', '2016-01-05', '$150,000', '150000', '300.000',
    'RETAIL STORE', 'ICI LAND AND BUILDINGS', '60', 'tax_year']),
  // 4: no class at sale (1990)
  row(['101', 'X', 'Jan 05, 1990', '1990-01-05', '$50,000', '50000', '400.000',
    '', 'ICI BARE LAND', '', '']),
  // 5: class 60, no readable price
  row(['101', 'X', 'Jan 05, 2015', '2015-01-05', '', '', '500.000',
    '', 'ICI BARE LAND', '60', 'pdf']),
].join('\n') + '\n';

function build(shards) {
  const keys = new KeyTable();
  const m = new Map();
  for (const [no, csv] of Object.entries(shards)) m.set(no, indexShard(csv, keys));
  return { keys, m };
}

test('classBitsOf: blank is unknown, stacked lines OR together', () => {
  assert.equal(classBitsOf(''), classMask(['unknown']));
  assert.equal(classBitsOf('\n'), classMask(['unknown']));
  assert.equal(classBitsOf('11\n60'), classMask(['11', '60']));
  assert.ok(classBitsOf('99') & classMask(['99']), 'an unlisted code still indexes');
  assert.equal(classBitsOf('99') & classMask(['60']), 0);
});

test('class picker lists codes in numeric order', () => {
  const codes = CLASS_CODES.map(([c]) => Number(c));
  assert.deepEqual(codes, [...codes].sort((a, b) => a - b));
});

test('default window: Jan 1 five years back, through the newest sale', () => {
  assert.deepEqual(defaultDateWindow(new Date(2026, 8, 24), '2026-09-10'),
    { from: '2021-01-01', to: '2026-09-10' });
  assert.deepEqual(defaultDateWindow(new Date(2027, 0, 1), '2026-12-20T00:00:00Z'),
    { from: '2022-01-01', to: '2026-12-20' });
  assert.deepEqual(defaultDateWindow(new Date(2026, 8, 24), null), { from: '2021-01-01', to: '' },
    'no newest sale = open-ended, never a made-up date');
});

test('dateKey: ISO to int, junk to 0', () => {
  assert.equal(dateKey('2024-03-01'), 20240301);
  assert.equal(dateKey(''), 0);
  assert.equal(dateKey('Mar 01, 2024'), 0);
});

test('class 60 matches single-roll AND the multi-roll sale with one class-60 roll', () => {
  const { keys, m } = build({ 101: SHARD });
  const r = runSearch(m, { classes: ['60'] }, keys);
  assert.deepEqual(r.byMuni.get('101'), [1, 2, 3, 5]);
});

test('unknown class is only returned when asked for', () => {
  const { keys, m } = build({ 101: SHARD });
  assert.deepEqual(runSearch(m, { classes: ['unknown'] }, keys).byMuni.get('101'), [4]);
  assert.equal(runSearch(m, { classes: [] }, keys).total, 0, 'no class chosen = no search');
});

test('price: min alone, max alone, both; whole-sale; unpriced sale fails a bound', () => {
  const { keys, m } = build({ 101: SHARD });
  assert.deepEqual(runSearch(m, { classes: ['60'], min: 250000 }, keys).byMuni.get('101'), [1, 2]);
  assert.deepEqual(runSearch(m, { classes: ['60'], max: 300000 }, keys).byMuni.get('101'), [2, 3]);
  assert.deepEqual(runSearch(m, { classes: ['60'], min: '200000', max: '400000' }, keys).byMuni.get('101'), [2]);
  assert.deepEqual(runSearch(m, { classes: ['60'], min: '' }, keys).byMuni.get('101'), [1, 2, 3, 5],
    'an empty bound is no bound, and keeps the unpriced sale');
});

test('date window is inclusive and drops undated rows only when set', () => {
  const { keys, m } = build({ 101: SHARD });
  assert.deepEqual(runSearch(m, { classes: ['60'], from: '2016-01-05', to: '2020-06-01' }, keys)
    .byMuni.get('101'), [2, 3]);
});

test('sale types filter; empty list = any', () => {
  const { keys, m } = build({ 101: SHARD });
  assert.deepEqual(runSearch(m, { classes: ['60'], types: ['ICI BARE LAND'] }, keys).byMuni.get('101'), [5]);
  assert.equal(runSearch(m, { classes: ['60'], types: [] }, keys).total, 4);
});

test('property-type list: counted over the base set, stable under ticking', () => {
  const { keys, m } = build({ 101: SHARD });
  const all = runSearch(m, { classes: ['60'] }, keys);
  const picked = runSearch(m, { classes: ['60'], subcats: ['ICI|Warehouse / storage'] }, keys);
  assert.deepEqual(picked.byMuni.get('101'), [1]);
  assert.deepEqual(picked.tree, all.tree, 'ticking a type must not shrink the list');
  const ici = all.tree.find((f) => f.family === 'ICI');
  const labels = Object.fromEntries(ici.options.map((o) => [o.label, o.count]));
  assert.equal(labels['Warehouse / storage'], 1);
  assert.equal(labels['Store / retail'], 1);
  assert.equal(labels['(no primary structure)'], 1);
});

test('a multi-roll sale matches a property type on either roll', () => {
  const { keys, m } = build({ 101: SHARD });
  const r = runSearch(m, { classes: ['60'], subcats: ['Residential|(no primary structure)'] }, keys);
  assert.deepEqual(r.byMuni.get('101'), [2], 'second roll is bare land');
});

test('extractRows returns the header and rows verbatim, stacked cells intact', () => {
  const got = extractRows(SHARD, [2, 5]);
  assert.equal(got.header, HEADER);
  assert.equal(got.rows.length, 2);
  assert.ok(got.rows[0].includes('"200.000\n201.000"'));
  assert.ok(got.rows[1].includes('500.000'));
});

test('a shard exported before Class At Sale refuses to index', () => {
  const old = SHARD.replace(',Class At Sale,Class Source', ',X,Y');
  assert.equal(indexShard(old, new KeyTable()), null);
});

test('several shards: byMuni keyed per shard, total sums', () => {
  const { keys, m } = build({ 101: SHARD, 102: SHARD.replace(/\n101,/g, '\n102,') });
  const r = runSearch(m, { classes: ['60'], min: 250000 }, keys);
  assert.equal(r.total, 4);
  assert.deepEqual([...r.byMuni.keys()], ['101', '102']);
});

test('describeCriteria reads like a search', () => {
  const s = describeCriteria({ classes: ['60', 'unknown'], min: 250000, from: '2015-01-01', types: ['ICI BARE LAND'] });
  assert.match(s, /Class 60/);
  assert.match(s, /unknown class/);
  assert.match(s, /≥ \$250,000/);
  assert.match(s, /2015-01-01 → today/);
  assert.match(s, /1 sale type/);
});

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
}

test('saved searches: save, overwrite by name, delete', () => {
  const st = new MemStorage();
  assert.deepEqual(listSaved(st), []);
  saveSearch(st, ' Ind 250k ', { classes: ['60'], min: 250000 });
  saveSearch(st, 'Farm', { classes: ['30'] });
  saveSearch(st, 'Ind 250k', { classes: ['60'], min: 300000 });
  const list = listSaved(st);
  assert.deepEqual(list.map((s) => s.name), ['Farm', 'Ind 250k']);
  assert.equal(list[1].criteria.min, 300000);
  deleteSaved(st, 'Farm');
  assert.deepEqual(listSaved(st).map((s) => s.name), ['Ind 250k']);
  assert.equal(saveSearch(st, '   ', {}), null, 'blank name is refused');
});

test('saved searches survive corrupt or blocked storage', () => {
  const bad = new MemStorage();
  bad.setItem(SAVED_KEY, '{not json');
  assert.deepEqual(listSaved(bad), []);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(listSaved(blocked), []);
  assert.equal(saveSearch(blocked, 'x', { classes: ['60'] }), null);
  assert.deepEqual(listSaved(null), []);
});

// ---- wiring: the panel must be called, and a province load must not be
// narrowed by the municipality ticks. Comment-stripped so prose cannot pass.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(^|[^:])\/\/[^\r\n]*$/gm, '$1');
}
const here = path.dirname(fileURLToPath(import.meta.url));
const main = stripComments(fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8'));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');

test('main.js initialises the province panel with the shared load path', () => {
  assert.match(main, /initSalesProvincePanel\(\{[\s\S]*?onLoad:\s*loadSalesDbPayload/);
  assert.match(main, /scope === 'province' \? null/);
});

test('index.html carries every element the panel reads', () => {
  for (const id of ['sales-prov', 'sales-prov-class', 'sales-prov-unknown', 'sales-prov-from',
    'sales-prov-to', 'sales-prov-min', 'sales-prov-max', 'sales-prov-types', 'sales-prov-subs',
    'sales-prov-count', 'sales-prov-search', 'sales-prov-save', 'sales-prov-saved',
    'sales-prov-delete', 'sales-prov-status']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
});

let failed = 0;
for (const [ok, name, err] of results) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name}\n    ${err?.message}`); }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
