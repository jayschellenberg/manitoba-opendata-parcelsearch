// Tests for the comparable tags (charts Phase 2, 2026-10-06): keying on
// rolls + date (never the sale id MAO renumbers), the three ordered lists
// and their numbering, storage hygiene, and the source contracts that keep
// the tags reaching the charts, the maps and the work file.
//
// Run: cd web && node test/compTags.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  emptyTags, normalizeTags, saleTagKey, toggleTag, removeTag, moveTag, clearTags,
  tagNumber, tagLabel, tagDescriptions,
} from '../src/lib/compTags.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const here = path.dirname(fileURLToPath(import.meta.url));
function code(rel) {
  return readFileSync(path.join(here, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const sale = (rolls, y, m, d, extra = {}) => ({ saleId: Math.random(), rolls, dateMs: new Date(y, m - 1, d).getTime(), ...extra });

console.log('keys');
test('rolls sorted + local date, independent of the sale id', () => {
  const a = sale(['123400.000', '99.000'], 2024, 3, 9);
  const b = { ...a, saleId: 'renumbered' };
  assert.equal(saleTagKey(a), '123400.000+99.000@2024-03-09');
  assert.equal(saleTagKey(a), saleTagKey(b));
});
test('same rolls on another date is another sale', () => {
  assert.notEqual(saleTagKey(sale(['1.000'], 2024, 3, 9)), saleTagKey(sale(['1.000'], 2025, 3, 9)));
});
test('no roll, no key', () => {
  assert.equal(saleTagKey({ rolls: [] }), null);
  assert.equal(saleTagKey(null), null);
});
test('falls back to the raw date text', () => {
  assert.equal(saleTagKey({ rolls: ['5'], dateMs: null, dateText: ' Mar 2024 ' }), '5@Mar 2024');
});

console.log('lists');
const A = sale(['1'], 2024, 1, 1, { address: '1 A St', muni: 'TACHE (RM)' });
const B = sale(['2'], 2024, 1, 2);
const C = sale(['3'], 2024, 1, 3);
const [ka, kb, kc] = [A, B, C].map(saleTagKey);
test('toggling appends in order, numbers follow the order', () => {
  let t = emptyTags();
  t = toggleTag(t, 'comps', ka, A);
  t = toggleTag(t, 'comps', kb, B);
  assert.deepEqual(t.comps, [ka, kb]);
  assert.equal(tagNumber(t, 'comps', kb), 2);
  assert.equal(t.info[ka].address, '1 A St');
  t = toggleTag(t, 'comps', ka);
  assert.deepEqual(t.comps, [kb]);
  assert.equal(tagNumber(t, 'comps', kb), 1, 'removing #1 renumbers the rest');
  assert.equal(t.info[ka], undefined, 'info is pruned with the last tag');
});
test('move swaps neighbours and stops at the ends', () => {
  let t = emptyTags();
  for (const k of [ka, kb, kc]) t = toggleTag(t, 'comps', k);
  t = moveTag(t, 'comps', kc, -1);
  assert.deepEqual(t.comps, [ka, kc, kb]);
  assert.deepEqual(moveTag(t, 'comps', ka, -1).comps, t.comps);
  assert.deepEqual(moveTag(t, 'comps', kb, 1).comps, t.comps);
});
test('labels: comp number wins, then L1-n, then L2-n', () => {
  let t = emptyTags();
  t = toggleTag(t, 'set1', ka);
  t = toggleTag(t, 'set2', kb);
  t = toggleTag(t, 'set2', kc);
  assert.equal(tagLabel(t, ka), 'L1-1');
  assert.equal(tagLabel(t, kc), 'L2-2');
  t = toggleTag(t, 'comps', ka);
  assert.equal(tagLabel(t, ka), '1');
  assert.deepEqual(tagDescriptions(t, ka), ['Comp #1', 'Land Set 1 #1']);
  assert.equal(tagLabel(t, 'nobody@2024-01-01'), null);
  assert.equal(tagLabel(t, null), null);
});
test('remove and clear', () => {
  let t = emptyTags();
  t = toggleTag(t, 'comps', ka, A);
  t = toggleTag(t, 'set1', kb, B);
  assert.deepEqual(removeTag(t, 'comps', ka).comps, []);
  assert.deepEqual(clearTags(t, 'set1').set1, []);
  assert.deepEqual(clearTags(t, 'set1').comps, [ka]);
  assert.deepEqual(clearTags(t), emptyTags());
});
test('storage junk normalises to a clean state', () => {
  assert.deepEqual(normalizeTags(null), emptyTags());
  assert.deepEqual(normalizeTags('x'), emptyTags());
  const t = normalizeTags({ comps: [ka, ka, 3, '', kb], set1: 'nope', info: { [ka]: { address: 7 } } });
  assert.deepEqual(t.comps, [ka, kb]);
  assert.deepEqual(t.set1, []);
  assert.equal(t.info[ka].address, '7');
});

console.log('contracts');
test('the labels reach charts, maps and PNGs', () => {
  const main = code('src/charts/main.js');
  assert.match(main, /setPointLabeler\(\(rec\) => tagLabel\(tags, saleTagKey\(rec\)\)\)/);
  assert.match(main, /label: tagLabel\(tags, saleTagKey\(r\)\) \|\| ''/);
  const render = code('src/lib/chartRender.js');
  // Both the scatter and the box plot draw them.
  assert.equal((render.match(/^\s+drawPointLabels\(svg, placed/gm) || []).length, 2);
  // The PNG clone strips pointer-events="none" nodes; the label group must not be one.
  assert.doesNotMatch(render, /function drawPointLabels[\s\S]{0,400}'pointer-events': 'none'/);
  const map = code('src/charts/chartMap.js');
  assert.match(map, /id: 'sales-tag-label'[\s\S]*?'text-field': \['get', 'label'\]/);
});
test('Shift-click tags; the panel, table and popup all toggle', () => {
  const main = code('src/charts/main.js');
  assert.match(main, /function onPointClick\(rec, pt, e\) \{\s*if \(e\?\.shiftKey\) \{ toggleSaleTag\(rec, 'comps'\)/);
  assert.match(main, /renderCompsPanel\(\);/);
  assert.match(main, /popupActions: \(id\) =>/);
  assert.match(main, /b\.addEventListener\('click', \(\) => toggleSaleTag\(rec, list\)\)/);
  const render = code('src/lib/chartRender.js');
  assert.match(render, /onPointClick\(byX\[idx\]\.rec, byX\[idx\], e\)/);
});
test('the work file writes the tagged comps', () => {
  const main = code('src/charts/main.js');
  assert.match(main, /name: 'comps\.csv', data: enc\.encode\(toCsv\(labels, csvRows\(tags\.comps\.length \? tagged :/);
  assert.match(main, /\['Comp #', \(r\) => tagNumber\(tags, 'comps', saleTagKey\(r\)\)\]/);
});

console.log('exclusion reasons (charts Phase 3)');
test('reasons are keyed on rolls + date and reach the tooltip, CSVs and summary', () => {
  const main = code('src/charts/main.js');
  assert.match(main, /const reasonOf = \(rec\) => reasons\[saleTagKey\(rec\)\] \|\| ''/);
  assert.match(main, /if \(rec\.excluded && reasonOf\(rec\)\) rows\.unshift\(\['Excluded', reasonOf\(rec\)\]\)/);
  assert.match(main, /\['Exclusion reason', \(r\) => \(r\.excluded \? reasonOf\(r\) : ''\)\]/);
  assert.match(main, /name: 'excluded\.csv'/);
  assert.match(main, /columns: \[\.\.\.saleCols, \{ label: 'Reason' \}\]/);
});
test('the panel renders, saves on change, and a click-exclude prompts for the reason', () => {
  const main = code('src/charts/main.js');
  assert.match(main, /renderExclPanel\(\);/);
  assert.match(main, /input\.addEventListener\('change', \(\) => \{ setReason\(key, input\.value\)/);
  assert.match(main, /if \(!rec\.excluded\) reasonPromptKey = saleTagKey\(rec\);/);
  // A republish while a reason is being typed must not wipe it.
  assert.match(main, /if \(active && body\.contains\(active\) && active\.dataset\.key\) return;/);
});

console.log(`\n${passed} passed`);
