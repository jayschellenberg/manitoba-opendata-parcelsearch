// Far-flung exclusion must come from a fixed default, never from storage.
//
// (It ships ON since 2026-09-22 — a portfolio or estate sale spread across a
// wide area has a blended $/Acre that is not a local comparable. That is a
// DEFAULT: identical every session, shown on the pill, named in the filter
// chips, and written into the URL when the user moves off it. What follows is
// about the other thing, which is indistinguishable in the code and is not
// the same at all.)
//
// WHY THIS EXISTS. Jason, 2026-09-13. A production URL was carrying
// `pl=farflung:exclude` on a page nobody had touched that day. It was not a
// URL bug — localStorage held `mbps_far_flung_exclude_v1 = "1"` from some
// earlier job, and every load re-ticked the box.
//
// The distinction the original code missed: the far-flung THRESHOLD only
// marks sales, so persisting it between jobs is free. Exclude REMOVES rows
// from the table, the map and the CSV export. A row-dropping filter that
// turns itself back on months later, and rides silently into every shared
// link, is the same failure shape as the stale-panel and shared-link bugs —
// the screen looks correct and the result set is not.
//
// Source-text check, same idiom as searchReset/overlayWiring: it cannot prove
// runtime behaviour, but it makes "someone re-added persistence" a build
// failure rather than something noticed a year later in a comparable set.
//
// Run: cd web && node test/farFlungPersistence.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawSrc = fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');

/** Comments stripped — a test that matches its own documentation proves
 *  nothing. See the note in searchReset.test.js; that lesson was paid for. */
function stripComments(text) {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlocks.split('\n').map((line) => {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '/' && line[i + 1] === '/' && line[i - 1] !== ':') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

const src = stripComments(rawSrc);
const KEY = 'FAR_FLUNG_EXCLUDE_KEY';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('main.js — far-flung exclusion does not persist');

test('nothing writes the exclude key', () => {
  const writes = [...src.matchAll(new RegExp(`setItem\\(\\s*${KEY}`, 'g'))];
  assert.equal(writes.length, 0,
    'Exclude is being persisted again. It removes rows from the table, map and '
    + 'CSV export, so a stored value silently drops comparables in a later '
    + 'session and rides into every shared pl= link.');
});

test('nothing reads the exclude key back into state', () => {
  const reads = [...src.matchAll(new RegExp(`getItem\\(\\s*${KEY}`, 'g'))];
  assert.equal(reads.length, 0, 'a stored exclude value is being restored at startup');
});

test('the stale key is actively cleared, not just ignored', () => {
  // Browsers that already hold '1' must be cleaned up, or the setting can
  // come back the moment anything reads the key again.
  assert.match(src, new RegExp(`removeItem\\(\\s*${KEY}`),
    'resetFarFlungExclude must removeItem the old key');
});

test('startup forces the fixed DEFAULT, and is actually called', () => {
  const m = /function resetFarFlungExclude\(\)[\s\S]*?\n}/.exec(src);
  assert.ok(m, 'resetFarFlungExclude not found');
  // Not "must be false" any more — Exclude ships ON since 2026-09-22. This
  // guard was never about WHICH value it is; it is about where the value
  // comes FROM. A named constant is the same every session and the pill shows
  // it. A remembered value is the bug this file exists for: invisible, months
  // stale, and it rode into shared links. So: assign from the default, and
  // from nothing else.
  assert.match(m[0], /\$farFlungExclude\.checked\s*=\s*FAR_FLUNG_EXCLUDE_DEFAULT/,
    'reset must assign the named default, not a literal and not a stored value');
  assert.match(src, /const FAR_FLUNG_EXCLUDE_DEFAULT\s*=\s*(?:true|false)\s*;/,
    'the default must be one named constant, so markup and code can be checked against it');
  assert.match(m[0], /pillPainters\.farflung/,
    'the Keep/Exclude pill is painted from the checkbox and must be repainted');
  // The repo's recurring bug is a function that exists and is never called:
  // the definition itself is one match, so a real call means at least two.
  const calls = [...src.matchAll(/resetFarFlungExclude\s*\(/g)];
  assert.ok(calls.length >= 2,
    'resetFarFlungExclude is defined but never called at startup');
});

test('the THRESHOLD still persists', () => {
  // The point is the distinction, not removing persistence wholesale:
  // marking costs nothing to carry between jobs.
  assert.match(src, /setItem\(\s*FAR_FLUNG_STORAGE_KEY/,
    'the km threshold should still be remembered across sessions');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
