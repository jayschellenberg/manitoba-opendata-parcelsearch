// Tests for the Sales Charts work file (charts Phase 1, 2026-10-06): CSV
// quoting and the Excel formula guard, HTML escaping in summary.html, the
// zip entry names, and the source contracts that keep the export wired —
// a work file that builds but is never reachable from its button is the
// failure this repo keeps having (see the contract-test notes).
//
// Run: cd web && node test/workFile.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  escapeHtml, csvCell, toCsv, fileStem, figureFileName, workFileName, buildSummaryHtml,
} from '../src/lib/workFile.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** Source text with comments removed, so a commented-out call cannot pass. */
function code(rel) {
  return readFileSync(path.join(here, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

console.log('CSV');
test('numbers go out raw, blanks empty', () => {
  assert.equal(csvCell(1234.5), '1234.5');
  assert.equal(csvCell(-12), '-12');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(NaN), '');
});
test('quotes commas, quotes and newlines', () => {
  assert.equal(csvCell('RM OF TACHE, MB'), '"RM OF TACHE, MB"');
  assert.equal(csvCell('12" pipe'), '"12"" pipe"');
  assert.equal(csvCell('a\nb'), '"a\nb"');
});
test('text that Excel would evaluate is defused', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-5 acres'), "'-5 acres");
});
test('document: BOM, header, CRLF rows', () => {
  const doc = toCsv(['Address', 'Price'], [['Île-des-Chênes', 250000], ['A, B', null]]);
  assert.ok(doc.startsWith('﻿Address,Price\r\n'));
  assert.ok(doc.includes('Île-des-Chênes,250000\r\n'));
  assert.ok(doc.endsWith('"A, B",\r\n'));
});

console.log('names');
test('file stems fold accents and punctuation', () => {
  assert.equal(fileStem('CMS Heatmap – Price per Acre'), 'cms-heatmap-price-per-acre');
  assert.equal(fileStem('Île-des-Chênes'), 'ile-des-chenes');
  assert.equal(fileStem('***', 'x'), 'x');
});
test('figure names sort in page order', () => {
  assert.equal(figureFileName(0, 'Land Price/Unit', 'Price per Acre over Time', 'png'),
    '01-land-price-unit-price-per-acre-over-time.png');
  assert.equal(figureFileName(11, 'Water', 'Water premium', 'csv'), '12-water-water-premium.csv');
});
test('zip name carries the subject roll when there is one', () => {
  assert.equal(workFileName('123456.000', '2026-10-06'), 'work-file-123456-000-2026-10-06.zip');
  assert.equal(workFileName('', '2026-10-06'), 'work-file-sales-2026-10-06.zip');
});

console.log('summary.html');
test('escapes pasted text everywhere it appears', () => {
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  const evil = '<img src=x onerror=alert(1)>';
  const html = buildSummaryHtml({
    title: `Sales work file — ${evil}`,
    subject: [['Address', evil]],
    comps: { columns: [{ label: 'Address' }], rows: [[evil]] },
    figures: [{ tabLabel: 'Water', title: evil, kind: 'table', columns: [{ label: evil }], rows: [[evil]] }],
  });
  assert.ok(!html.includes('<img src=x'), 'raw markup leaked into the page');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});
test('embeds images and groups figures under their tab', () => {
  const html = buildSummaryHtml({
    title: 'T',
    comps: { columns: [{ label: 'A' }], rows: [['1'], ['2']] },
    figures: [
      { tabLabel: 'Land Price/Unit', title: 'One', kind: 'image', src: 'data:image/png;base64,AAAA' },
      { tabLabel: 'Land Price/Unit', title: 'Two', kind: 'image', src: 'data:image/png;base64,BBBB' },
      { tabLabel: 'Map', title: 'Three', kind: 'image', src: 'data:image/png;base64,CCCC' },
    ],
  });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.equal((html.match(/<img /g) || []).length, 3);
  assert.equal((html.match(/class="tab-head"/g) || []).length, 2);
  assert.ok(html.includes('Comparable sales (2)'));
  assert.ok(html.includes('No subject roll was set'));
});
test('an empty excluded list adds no section', () => {
  const html = buildSummaryHtml({ excluded: { columns: [], rows: [] } });
  assert.ok(!html.includes('Excluded sales'));
});

test('linked images: zip paths kept as relative src, with a note to keep the folder', () => {
  const html = buildSummaryHtml({
    linkedImages: true,
    figures: [{ tabLabel: 'Map', title: 'T', kind: 'image', src: 'charts/01-map-cms-heatmap.png' }],
  });
  assert.ok(html.includes('<img src="charts/01-map-cms-heatmap.png"'));
  assert.ok(html.includes('keep the two together'));
  assert.ok(!buildSummaryHtml({ figures: [{ tabLabel: 'Map', title: 'T', kind: 'image', src: 'data:image/png;base64,AA' }] })
    .includes('keep the two together'), 'no note when embedded');
});

console.log('contracts');
test('the embed choice reaches the summary', () => {
  const main = code('src/charts/main.js');
  assert.match(main, /src: embed \? await blobToDataUrl\(png\) : name/);
  assert.match(main, /buildSummaryHtml\(\{ \.\.\.model, figures, linkedImages: !embed \}\)/);
  assert.match(main, /\{ embed: els\.workfileEmbed\.checked \}/);
});
test('the button opens the dialog and the dialog builds the zip', () => {
  const main = code('src/charts/main.js');
  assert.match(main, /els\.workfileOpen\.addEventListener\('click'[\s\S]*?renderWorkfileList\(\)[\s\S]*?showModal\(\)/);
  assert.match(main, /els\.workfileGo\.addEventListener\('click'[\s\S]*?buildWorkFile\(/);
  assert.match(main, /buildStoreZip\(files\)/);
  assert.match(main, /buildSummaryHtml\(/);
  const html = readFileSync(path.join(here, '..', 'charts.html'), 'utf8');
  for (const id of ['workfile-open', 'workfile-dialog', 'workfile-list', 'workfile-status', 'workfile-go']) {
    assert.ok(html.includes(`id="${id}"`), `charts.html lacks #${id}`);
  }
});
test('every chart card registers what it exports', () => {
  const render = code('src/lib/chartRender.js');
  // The footer every scatter, box plot, bar and histogram shares, and the table card.
  assert.match(render, /function appendChartFooter[\s\S]*?EXPORT_SPECS\.set\(figure, \{ kind: 'chart'/);
  assert.match(render, /export function drawTableCard[\s\S]*?EXPORT_SPECS\.set\(figure, \{\s*kind: 'table'/);
  // The PNG button and the zip share one renderer.
  assert.match(render, /export function exportChartPng[\s\S]*?renderChartPng\(spec\)/);
});

console.log(`\n${passed} passed`);
