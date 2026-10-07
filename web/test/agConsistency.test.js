// Tests for the Agricultural page's consistency filters (2026-10-07, the land
// template's CMSAG1 "rate" mode): the pass/fail rules, unknown-is-kept, the
// words that go into subtitles, and that the charts page wires them into the
// Ag page's own fitted set only.
//
// Run: cd web && node test/agConsistency.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { agConsSpec, agConsActive, agConsistent, agConsWords } from '../src/lib/agConsistency.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const code = (rel) => readFileSync(path.join(here, '..', rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const sale = (ag) => ({ ag });
const mascOf = (r) => r.ag?.masc || 'Unrated';
const pass = (rec, raw) => agConsistent(rec, agConsSpec(raw), { mascOf, unrated: 'Unrated' });

console.log('spec');
test('empty and junk mean off', () => {
  assert.equal(agConsActive(agConsSpec(null)), false);
  assert.equal(agConsActive(agConsSpec({ cultLo: '', masc: [] })), false);
  assert.equal(agConsActive(agConsSpec({ cultLo: 'x' })), false);
  assert.equal(agConsActive(agConsSpec({ cultHi: '90' })), true);
  assert.equal(agConsActive(agConsSpec({ cli: ['2'] })), true);
});

console.log('rules');
test('cultivated band, inclusive at both ends', () => {
  const band = { cultLo: '50', cultHi: '90' };
  assert.equal(pass(sale({ cover: { cult: 0.5 } }), band), true);
  assert.equal(pass(sale({ cover: { cult: 0.9 } }), band), true);
  assert.equal(pass(sale({ cover: { cult: 0.49 } }), band), false);
  assert.equal(pass(sale({ cover: { cult: 0.95 } }), band), false);
  assert.equal(pass(sale({ cover: { cult: 0.2 } }), { cultLo: '', cultHi: '30' }), true, 'one-sided band');
});
test('keep-lists', () => {
  assert.equal(pass(sale({ masc: 'B' }), { masc: ['A', 'B'] }), true);
  assert.equal(pass(sale({ masc: 'E' }), { masc: ['A', 'B'] }), false);
  assert.equal(pass(sale({ cliClass: '3' }), { cli: ['1', '2'] }), false);
  assert.equal(pass(sale({ cliClass: 2 }), { cli: ['1', '2'] }), true, 'numeric class matches its string');
  assert.equal(pass(sale({ coverLabel: 'Grassland' }), { cover: ['Cropland'] }), false);
});
test('a sale with no value is kept — never measured is not failed', () => {
  const all = { cultLo: '50', masc: ['A'], cli: ['1'], cover: ['Cropland'] };
  assert.equal(pass(sale(null), all), true);
  assert.equal(pass(sale({ masc: null, cliClass: null, coverLabel: null, cover: null }), all), true);
  assert.equal(pass(sale({ masc: 'Unrated' }), { masc: ['A'] }), true);
});
test('every set filter must pass', () => {
  const f = { cultLo: '50', masc: ['A', 'B'] };
  assert.equal(pass(sale({ masc: 'A', cover: { cult: 0.8 } }), f), true);
  assert.equal(pass(sale({ masc: 'A', cover: { cult: 0.3 } }), f), false);
  assert.equal(pass(sale({ masc: 'D', cover: { cult: 0.8 } }), f), false);
});
test('words for subtitles and the summary', () => {
  assert.equal(agConsWords(agConsSpec({ cultLo: '50', masc: ['A', 'B'], cli: ['1'], cover: ['Cropland'] })),
    'Cultivated 50–100%; MASC A, B; CLI 1; Cover Cropland');
  assert.equal(agConsWords(agConsSpec({ cultHi: '40' })), 'Cultivated 0–40%');
  assert.equal(agConsWords(agConsSpec({})), '');
});

console.log('contracts');
test('only the Agricultural page fits the filtered set, and says so', () => {
  const main = code('src/charts/main.js');
  assert.match(main, /const ag = opts\.tab === 'ag' && agConsActive\(\);[\s\S]*?const active = ag \? ticked\.filter\(agConsistent\) : ticked;/);
  assert.match(main, /const cacheKey = ag \? `\$\{metric\}\|ag` : metric;/);
  assert.match(main, /if \(agOut\?\.has\(rec\.saleId\)\) return 'trimmed';/);
  assert.match(main, /cms\.ag \? `; Ag: \$\{cms\.ag\.words\}` : ''/);
  assert.match(main, /label: 'Per year \(all ticked\)'/);
  assert.match(main, /if \(page === 'ag'\) out\.push\(agConsBar\(\)\);/);
});

console.log(`\n${passed} passed`);
