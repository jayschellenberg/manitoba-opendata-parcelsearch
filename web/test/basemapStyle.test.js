// lib/basemapStyle.js is a second copy of the streets basemap that map.js
// builds (for the Sales Charts map). These checks hold the copy to the
// original: same PMTiles archive, same glyph endpoint, same font remap.
// fontStacks.test.js proves map.js's remap targets a stack the glyph server
// actually serves; this proves the copy says the same thing.
//
// Run: cd web && node test/basemapStyle.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Comments out first: a comment naming the URL is not the code using it.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const mapJs = strip(fs.readFileSync(path.join(root, 'src', 'map.js'), 'utf8'));
const copy = strip(fs.readFileSync(path.join(root, 'src', 'lib', 'basemapStyle.js'), 'utf8'));

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }
const one = (src, re, what) => {
  const m = src.match(re);
  assert.ok(m, `${what} not found`);
  return m[1];
};

console.log('basemapStyle.js mirrors map.js');
test('same PMTiles archive', () => {
  const re = /\|\|\s*'(https:\/\/[^']*basemap-manitoba\.pmtiles)'/;
  assert.equal(one(copy, re, 'copy URL'), one(mapJs, re, 'map.js URL'));
});
test('same glyph endpoint', () => {
  const re = /glyphs: '([^']+)'/;
  assert.equal(one(copy, re, 'copy glyphs'), one(mapJs, re, 'map.js glyphs'));
});
test('same Noto Sans Medium remap target', () => {
  const re = /\.replaceAll\('"Noto Sans Medium"', '([^']+)'\)/;
  assert.equal(one(copy, re, 'copy remap'), one(mapJs, re, 'map.js remap'));
});

test('the charts map labels (municipal names) use that same one stack', () => {
  const mapMod = strip(fs.readFileSync(path.join(root, 'src', 'charts', 'chartMap.js'), 'utf8'));
  const target = one(mapJs, /\.replaceAll\('"Noto Sans Medium"', '"([^"]+)"'\)/, 'map.js remap');
  const stacks = [...mapMod.matchAll(/'text-font':\s*\[([^\]]*)\]/g)].map((m) => m[1].trim());
  assert.ok(stacks.length > 0, 'no text-font in chartMap.js');
  for (const st of stacks) assert.equal(st, `'${target}'`);
});

console.log(`\n${passed}/${passed} passed`);
