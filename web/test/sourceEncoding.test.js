// Source files must not carry mojibake (UTF-8 text decoded as Windows-1252
// and written back as UTF-8).
//
// WHY THIS EXISTS. history-pin-lib.ps1 re-pins web/src/arcgis.js every week.
// Under Windows PowerShell 5.1 it read the BOM-less file with Get-Content
// (Windows-1252) and wrote UTF-8, so each run garbled every non-ASCII
// character one more layer: on 2026-10-04 and 10-05, 255 sequences ("—" became
// "ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â..."), including the TACHÉ / ST FRANÇOIS XAVIER zoning
// aliases, which then never matched. The pin scripts now read and write UTF-8
// explicitly; this catches the next script that doesn't, before Vercel ships it.
//
// Run: cd web && node test/sourceEncoding.test.js

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const webDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = join(webDir, '..');

// The first layer of UTF-8-as-1252: "Ã" + a 1252 high char ("Ã©" for é,
// "Ãƒ" for a deeper layer), "â€" (U+2014/2019/201C... begin E2 80), or "Â"
// + a Latin-1 symbol ("Â·", "Â°"). None occurs in real Manitoba text.
const MOJIBAKE = /Ã[\u0080-ÿŒ-™]|â€|Â[ -¿]/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(js|html|css)$/.test(name)) yield p;
  }
}

function scan(paths) {
  const bad = [];
  for (const p of paths) {
    const lines = readFileSync(p, 'utf8').split('\n');
    lines.forEach((l, i) => { if (MOJIBAKE.test(l)) bad.push(`${relative(repoDir, p)}:${i + 1}`); });
  }
  return bad;
}

test('the detector flags a garbled line and passes real accents', () => {
  assert.equal(MOJIBAKE.test("'TACHÃƒÆ’Ã¢â‚¬Â°'"), true);
  assert.equal(MOJIBAKE.test('// a — dash'.replace('—', 'â€”')), true);
  assert.equal(MOJIBAKE.test("'TACHÉ', 'ST FRANÇOIS XAVIER', 0.0005° ≈ 50 m · ±2 ac — ok"), false);
});

test('no mojibake in web/src, web/index.html or api/', () => {
  const paths = [...files(join(webDir, 'src')), join(webDir, 'index.html'), ...files(join(repoDir, 'api'))];
  assert.ok(paths.some((p) => p.endsWith('arcgis.js')), 'arcgis.js is no longer scanned');
  const bad = scan(paths);
  assert.deepEqual(bad, [], `garbled UTF-8 (read as Windows-1252 and re-saved) at:\n      ${bad.join('\n      ')}`);
});

test('the zoning accent aliases are real accents', () => {
  const src = readFileSync(join(webDir, 'src', 'arcgis.js'), 'utf8');
  assert.match(src, /'TACHE':\s*\['TACHÉ'\]/);
  assert.match(src, /'ST FRANCOIS XAVIER':\s*\['ST FRANÇOIS XAVIER'\]/);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
