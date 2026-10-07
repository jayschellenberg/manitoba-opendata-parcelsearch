// Tests for the job file (2026-10-07): the document lib/jobFile.js builds and
// validates, which sidebar controls it captures, and the source contracts
// that keep Save / Open wired to the real import, filters, grid and charts.
//
// Run: cd web && node test/jobFile.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  JOB_APP, JOB_VERSION, buildJob, parseJob, jobFileName, isJobControl, JOB_SKIPPED_PILLS,
} from '../src/lib/jobFile.js';

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

const sales = { name: 'ritchot.csv', text: 'Sale Date,Consideration,Municipality,Roll Number\n2024-01-15,150000,RITCHOT (RM),100.000' };

console.log('document');
test('round trip keeps every part', () => {
  const job = buildJob({
    savedAt: '2026-10-07T12:00:00.000Z', build: 'abc123', name: 'Subject roll 100', sales,
    sidebar: { controls: { 'size-low': '5', 'exclude-nominal': true }, multis: { 'zoning-filter': ['RR'] }, pills: { farflung: 'keep' } },
    subject: { muni: 'RITCHOT (RM)', roll: '100', distanceMax: '15' },
    grid: { sort: { col: 'saleprice', dir: 'desc' }, unticked: ['1|100#0'], starred: ['1|300'] },
    tags: { comps: ['100@2024-01-15'], set1: [], set2: [], info: {} },
    reasons: { '300@2024-02-15': 'Assembly' },
    charts: { opts: { unit: 'acres', effDate: '2026-06-30' }, workfileOff: ['rates:x'] },
  });
  const back = parseJob(JSON.stringify(job));
  assert.equal(back.app, JOB_APP);
  assert.equal(back.version, JOB_VERSION);
  assert.equal(back.sales.text, sales.text);
  assert.deepEqual(back.sidebar.controls, { 'size-low': '5', 'exclude-nominal': true });
  assert.deepEqual(back.sidebar.multis, { 'zoning-filter': ['RR'] });
  assert.deepEqual(back.grid.sort, { col: 'saleprice', dir: 'desc' });
  assert.deepEqual(back.grid.unticked, ['1|100#0']);
  assert.equal(back.reasons['300@2024-02-15'], 'Assembly');
  assert.equal(back.charts.opts.effDate, '2026-06-30');
  assert.deepEqual(back.charts.workfileOff, ['rates:x']);
});
test('a job needs sales', () => {
  assert.throws(() => buildJob({}), /No sales are loaded/);
  assert.throws(() => buildJob({ sales: { text: '' } }), /No sales are loaded/);
});
test('parse refuses what it cannot apply, with a readable reason', () => {
  assert.throws(() => parseJob('not json'), /not valid JSON/);
  assert.throws(() => parseJob('{"app":"something-else","version":1}'), /not a Manitoba Parcel Search job/);
  assert.throws(() => parseJob(JSON.stringify({ app: JOB_APP, version: JOB_VERSION + 1, sales })), /newer version/);
  assert.throws(() => parseJob(JSON.stringify({ app: JOB_APP, version: 0, sales })), /no valid version/);
  assert.throws(() => parseJob(JSON.stringify({ app: JOB_APP, version: 1, sales: { text: '' } })), /holds no sales/);
});
test('parse tolerates missing and malformed optional parts', () => {
  const j = parseJob(JSON.stringify({ app: JOB_APP, version: 1, sales, grid: { unticked: 'x', starred: [1, 'a'] }, sidebar: [], charts: { opts: 'x' } }));
  assert.deepEqual(j.grid.unticked, []);
  assert.deepEqual(j.grid.starred, ['a']);
  assert.deepEqual(j.sidebar.controls, {});
  assert.equal(j.charts.opts, null);
  assert.equal(j.subject, null);
  assert.equal(j.grid.sort, null);
});
test('file name carries the subject roll', () => {
  assert.equal(jobFileName('100.000', '2026-10-07'), 'job-100-000-2026-10-07.json');
  assert.equal(jobFileName('', '2026-10-07'), 'job-sales-2026-10-07.json');
});

test('map layer toggles round-trip; an older job has none to restore', () => {
  const job = buildJob({ sales, overlays: ['zoning', 'flood-dfa', 7] });
  assert.deepEqual(job.overlays, ['zoning', 'flood-dfa']);
  assert.deepEqual(parseJob(JSON.stringify(job)).overlays, ['zoning', 'flood-dfa']);
  assert.equal(parseJob(JSON.stringify({ app: JOB_APP, version: 1, sales })).overlays, null);
});

console.log('which controls');
test('data sources, file inputs, pill backers and display toggles are left out', () => {
  assert.equal(isJobControl({ id: 'size-low', type: 'number' }), true);
  assert.equal(isJobControl({ id: 'subject-roll', type: 'text' }), true);
  assert.equal(isJobControl({ id: 'legal-text', type: 'text' }), true, 'property fields filter sales too');
  assert.equal(isJobControl({ id: 'sales-db-adjacent', type: 'checkbox' }), false);
  assert.equal(isJobControl({ id: 'sales-prov-from', type: 'date' }), false);
  assert.equal(isJobControl({ id: 'recent-uploads-select', type: 'select-one' }), false);
  assert.equal(isJobControl({ id: 'sales-upload-input', type: 'file' }), false);
  assert.equal(isJobControl({ id: 'far-flung-exclude', type: 'checkbox', className: 'pill-backing' }), false);
  assert.equal(isJobControl({ id: 'numbering-toggle', type: 'checkbox' }), false);
  assert.equal(isJobControl({ id: '', type: 'text' }), false);
  assert.deepEqual(JOB_SKIPPED_PILLS, ['adjacent']);
});

console.log('contracts');
test('every sales import records the text a job embeds, and a new search forgets it', () => {
  const main = code('src/main.js');
  assert.match(main, /rememberUpload\(fileName, text\);\s*lastSalesSource = \{ name: fileName, text \};/);
  assert.match(main, /async function runSearch\(\) \{[\s\S]*?csvFullRows = null;\s*lastSalesSource = null;/);
});
test('Save and Open are wired, and Open goes through the ordinary import', () => {
  const main = code('src/main.js');
  assert.match(main, /getElementById\('job-save'\)\?\.addEventListener\('click', saveJob\)/);
  // A picked file and a recent-jobs entry share one open path.
  assert.match(main, /\$jobOpenInput\?\.addEventListener\('change'[\s\S]*?await openJobText\(await file\.text\(\), file\.name\)/);
  assert.match(main, /async function openJobText\(text, fallbackName\) \{[\s\S]*?parseJob\(text\)[\s\S]*?await openJob\(job\)/);
  assert.match(main, /const rec = await getRecentJob\(id\);[\s\S]*?await openJobText\(rec\.text, rec\.name\)/);
  assert.match(main, /async function openJob\(job\) \{[\s\S]*?await handleSalesUpload\(job\.sales\);[\s\S]*?ms\.setSelected\(values\)[\s\S]*?await applySubjectFromInput\(\);[\s\S]*?deselectedSaleKeys = new Set\(job\.grid\.unticked\);[\s\S]*?saveCompTags\(normalizeTags\(job\.tags\)\)/);
  const html = readFileSync(path.join(here, '..', 'index.html'), 'utf8');
  for (const id of ['job-save', 'job-open', 'job-open-input']) assert.ok(html.includes(`id="${id}"`), `index.html lacks #${id}`);
});
test('the charts page follows an opened job, effective date included', () => {
  const charts = code('src/charts/main.js');
  assert.match(charts, /return parsed\.effDatePinned && effDate \? \{ \.\.\.rest, effDate \} : rest;/);
  assert.match(charts, /if \(e\.key !== OPTS_KEY\) return;\s*Object\.assign\(opts, readOpts\(\)\);/);
  assert.match(charts, /setOpt\(\{ effDate: els\.effDate\.value, effDatePinned: false \}\)/);
  const main = code('src/main.js');
  assert.match(main, /effDatePinned: !!rest\.effDate/);
});

test('Save records the pressed layer toggles and Open sets exactly those', () => {
  const main = code('src/main.js');
  assert.match(main, /overlays: readCurrentUrlState\(\)\.overlays \|\| \[\]/);
  assert.match(main, /if \(Array\.isArray\(job\.overlays\)\) \{[\s\S]*?btn\.click\(\);[\s\S]*?restoreUrlOverlays\(\{ overlays: job\.overlays \}\);/);
});

test('the column preset round-trips; an older job leaves the columns alone', () => {
  const job = buildJob({ sales, columns: { preset: 'Agricultural', visible: ['roll', 'cli', 5] } });
  assert.deepEqual(parseJob(JSON.stringify(job)).columns, { preset: 'Agricultural', visible: ['roll', 'cli'] });
  assert.equal(parseJob(JSON.stringify({ app: JOB_APP, version: 1, sales })).columns, null);
});
test('Open re-applies the preset — which re-runs the Agricultural soil load — then the hand-set columns', () => {
  const main = code('src/main.js');
  assert.match(main, /if \(job\.columns\.preset\) applyPreset\(job\.columns\.preset\);/);
  // applyPreset fires onPresetApply, whose Agricultural branch loads the soil.
  assert.match(main, /onPresetApply\(\(name\) => \{\s*lastColumnPreset = name;[\s\S]*?if \(name === 'Agricultural'\) \{\s*ensureAgriculturalGridData\(\);/);
  assert.match(main, /columns: \{\s*preset: lastColumnPreset,/);
});
test('saving and opening both remember the job in the recent list', () => {
  const main = code('src/main.js');
  assert.match(main, /downloadBlob\(new Blob\(\[text\][\s\S]*?addRecentJob\(job, text\)\.then\(refreshRecentJobs\);/);
  assert.match(main, /async function openJobText[\s\S]*?addRecentJob\(job, text\)\.then\(refreshRecentJobs\);/);
});

console.log(`\n${passed} passed`);
