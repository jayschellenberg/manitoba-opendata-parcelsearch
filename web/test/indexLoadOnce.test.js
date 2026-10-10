// Each index is downloaded at most once per page.
//
// WHY THIS EXISTS. 2026-10-10, a cold production load: a Playwright timing
// run showed THREE parallel requests for the 17 MB (gzip) legal index on the
// first address search. warmLegalIndex(), getParishOptions() and the search
// itself each posted their own 'load' to the worker, and the worker only
// guarded with `parsed` — set after the first load COMPLETES, so every
// message that arrived while the fetch was in flight started another one.
// assessmentIndex.js / its worker had the same shape.
//
// The fix is one in-flight promise on each side: the worker keeps `loading`
// and returns it to every concurrent 'load'; the main-thread module funnels
// every public call through requestWorkerLoad(), the only place that posts
// 'load'. loadDirect() (no-worker fallback) is reached only when there is no
// worker, so it can never race a pending worker load.
//
// Source-text check, same idiom as latePushFilter: it guards the SHAPE, which
// is what regressed. Comments are stripped first so prose cannot satisfy it.
//
// Run: cd web && node test/indexLoadOnce.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (s, re) => (s.match(re) || []).length;

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

for (const file of ['legalIndex.js', 'assessmentIndex.js']) {
  const s = stripComments(src(file));
  test(`${file}: 'load' is posted from requestWorkerLoad() only`, () => {
    assert.equal(count(s, /postMessage\('load'/g), 1, "exactly one postMessage('load'");
    const fn = s.slice(s.indexOf('function requestWorkerLoad()'));
    assert.ok(fn.includes("postMessage('load'"), 'the one post lives inside requestWorkerLoad');
  });
  test(`${file}: requestWorkerLoad caches the promise and clears it on failure`, () => {
    const fn = s.slice(s.indexOf('function requestWorkerLoad()'), s.indexOf('async function loadDirect()'));
    assert.ok(/if \(workerLoadPromise\) return workerLoadPromise;/.test(fn), 'returns the pending promise');
    assert.ok(/workerLoadPromise = null;/.test(fn), 'clears the slot when the load rejects');
  });
  test(`${file}: every public entry point uses requestWorkerLoad, never a direct load post`, () => {
    const direct = count(s, /= postMessage\('load'/g);
    assert.equal(direct, 1, 'only requestWorkerLoad assigns a load post');
    assert.ok(count(s, /requestWorkerLoad\(\)/g) >= 3, 'warm + lookups + metadata all go through it');
  });
  test(`${file}: _reset clears the shared load promise`, () => {
    const reset = s.slice(s.indexOf('export function _reset'));
    assert.ok(/workerLoadPromise = null;/.test(reset));
  });
}

for (const file of ['workers/legalIndex.worker.js', 'workers/assessmentIndex.worker.js']) {
  const s = stripComments(src(file));
  test(`${file}: concurrent 'load' messages share one in-flight promise`, () => {
    assert.ok(/let loading = null;/.test(s), 'declares the in-flight slot');
    const fn = s.slice(s.indexOf('async function loadFromUrls('), s.indexOf('async function fetchIndex('));
    assert.ok(/if \(!loading\) \{/.test(fn), 'starts a fetch only when none is pending');
    assert.ok(/return loading;/.test(fn), 'returns the pending promise to every caller');
    assert.ok(/\.finally\(\(\) => \{ loading = null; \}\)/.test(fn), 'releases the slot when it settles');
  });
  test(`${file}: the download itself happens in exactly one place`, () => {
    const after = s.slice(s.indexOf('async function fetchIndex('));
    assert.equal(count(after, /await fetch\(/g), 3, 'local, R2, proxy — one attempt each');
    const before = s.slice(0, s.indexOf('async function fetchIndex('));
    assert.equal(count(before, /await fetch\(/g), 0, 'no fetch outside fetchIndex');
  });
}

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nindexLoadOnce: all passed');
