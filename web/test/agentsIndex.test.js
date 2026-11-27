// /agents.json and /openapi.json are generated from src/lib/agentsIndex.js
// with the data-repo pins read out of src/arcgis.js. If someone reshapes the
// pin constants, readPins() must still find them or the build would publish
// an index naming no commit; this test fails first.
//
// Run: cd web && node test/agentsIndex.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPins, buildAgentsIndex, buildOpenApi, SITE } from '../src/lib/agentsIndex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arcgis = fs.readFileSync(path.join(here, '..', 'src', 'arcgis.js'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'vercel.json'), 'utf8'));

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('agents index');

const pins = readPins(arcgis);

test('both data-repo pins are found in arcgis.js', () => {
  assert.match(pins.parcelData ?? '', /^[0-9a-f]{40}$/);
  assert.match(pins.history ?? '', /^[0-9a-f]{40}$/);
});

test('the index names the pinned commits in every gh-data URL', () => {
  const ix = buildAgentsIndex(pins, '2026-01-01T00:00:00Z');
  const urls = ix.datasets.flatMap((d) => [d.url_template, d.index_url].filter(Boolean));
  for (const u of urls.filter((x) => x.includes('/gh-data/'))) {
    assert.ok(u.includes(pins.parcelData) || u.includes(pins.history), `unpinned: ${u}`);
  }
  assert.equal(ix.pins['mb-parcel-data'], pins.parcelData);
});

test('every dataset carries the fields an agent needs', () => {
  const ix = buildAgentsIndex(pins);
  const ids = new Set();
  for (const d of ix.datasets) {
    for (const k of ['id', 'title', 'url_template', 'key', 'format', 'fields', 'vintage', 'licence']) {
      assert.ok(d[k] && (!Array.isArray(d[k]) || d[k].length), `${d.id ?? '?'} missing ${k}`);
    }
    assert.ok(!ids.has(d.id), `duplicate id ${d.id}`); ids.add(d.id);
    assert.ok(d.url_template.startsWith(SITE) || d.url_template.startsWith('https://'), `${d.id} not absolute`);
  }
});

test('a missing pin fails loudly instead of publishing a broken index', () => {
  assert.throws(() => buildAgentsIndex({ parcelData: null, history: pins.history }));
});

test('openapi document is 3.1 and lists the index itself', () => {
  const doc = buildOpenApi(pins);
  assert.equal(doc.openapi, '3.1.0');
  assert.ok(doc.paths['/agents.json']);
  assert.ok(doc.info.description.includes(pins.parcelData));
});

test('vercel.json lets other origins read the index files', () => {
  const sources = vercel.headers
    .filter((h) => h.headers.some((x) => x.key === 'Access-Control-Allow-Origin' && x.value === '*'))
    .map((h) => h.source);
  for (const want of ['/agents.json', '/openapi.json', '/data/(.*)']) {
    assert.ok(sources.includes(want), `no CORS header rule for ${want}`);
  }
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
