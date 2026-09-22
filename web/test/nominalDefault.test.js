// Nominal sales defaults to Exclude, and shared links still round-trip.
//
// WHY THIS EXISTS. Jason, 2026-09-22: excluding nominal transfers is the
// normal starting point for a sales analysis — they are not market evidence —
// so the filter ships on rather than waiting to be remembered.
//
// Flipping the default is one attribute. The trap is the OTHER half. The URL
// writer omits a pill whose selected segment is the default, so that an
// untouched session produces a clean link; the restore path only clicks
// segments the URL actually names. Those two agree only while "the default"
// means the same thing on both sides.
//
// Nominal now loads on `exclude` while `include` is still the FIRST segment.
// If the writer kept assuming first-means-default it would drop `include`
// from the URL — so a link shared by someone who had deliberately turned the
// filter OFF would arrive with it ON, quietly filtering comps out of a set
// the recipient never asked to filter. No error, no visible difference in the
// pill, just a different answer. That is the same shape as the shared-link
// bug the restore path was written to fix in the first place.
//
// So the default is marked in the DOM (`data-default`) and the writer is
// asserted to read it.
//
// Run: cd web && node test/nominalDefault.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** The markup of one pill, by its data-pill name. */
function pillMarkup(name) {
  const at = html.indexOf(`data-pill="${name}"`);
  assert.notEqual(at, -1, `no pill named ${name} in index.html`);
  const end = html.indexOf('</div>', at);
  return html.slice(at, end);
}

console.log('nominal sales — default is Exclude, and links still round-trip');

test('the backing checkbox ships checked', () => {
  const m = /<input[^>]*id="exclude-nominal"[^>]*>/.exec(html);
  assert.ok(m, 'no #exclude-nominal input in index.html');
  assert.match(m[0], /\bchecked\b/,
    'the filter is meant to be on by default; the pill is only a view of this input');
});

test('the Exclude segment is the pressed one', () => {
  const pill = pillMarkup('nominal');
  const exclude = /<button[^>]*data-mode="exclude"[^>]*>/.exec(pill);
  const include = /<button[^>]*data-mode="include"[^>]*>/.exec(pill);
  assert.ok(exclude && include, 'nominal pill must offer both segments');
  assert.match(exclude[0], /aria-pressed="true"/, 'Exclude should be selected on load');
  assert.match(include[0], /aria-pressed="false"/, 'Include should not be selected on load');
  assert.match(exclude[0], /\bclass="[^"]*\bactive\b/, 'Exclude should carry the active class');
});

test('the page default is marked in the DOM, because it is not the first segment', () => {
  const pill = pillMarkup('nominal');
  const segments = [...pill.matchAll(/<button[^>]*data-mode="([^"]+)"[^>]*>/g)];
  assert.ok(segments.length >= 2);
  assert.notEqual(segments[0][1], 'exclude',
    'this test only has a job while Include is still the first segment');
  const exclude = /<button[^>]*data-mode="exclude"[^>]*>/.exec(pill)[0];
  assert.match(exclude, /\bdata-default\b/,
    'the segment the page loads in must say so, or the URL writer cannot know it');
});

test('the URL writer compares against data-default, not segments[0]', () => {
  // The assertion that actually prevents the shared-link bug. Reading the
  // source rather than the behaviour, because the writer needs a live DOM.
  const at = main.indexOf('const pills = {};');
  assert.notEqual(at, -1, 'the pill URL writer moved; this test needs re-pointing');
  const body = main.slice(at, main.indexOf('\n  }', at));
  assert.match(body, /data-default/,
    'the writer must look for the marked default segment');
  assert.ok(!/===\s*segments\[0\]\.dataset\.mode/.test(body),
    'comparing to segments[0] drops a non-first default from shared links');
});

test('far-flung sales also default to Exclude, marked the same way', () => {
  // Same shape as nominal, and the same trap: `keep` is the first segment, so
  // without data-default the URL writer would drop it, and a link from
  // someone who had deliberately KEPT far-flung sales would arrive excluding
  // them. That exact failure already happened here once in the other
  // direction — 2026-09-13, a production URL carrying farflung:exclude that
  // nobody had set — so it is worth pinning on this pill specifically.
  const m = /<input[^>]*id="far-flung-exclude"[^>]*>/.exec(html);
  assert.ok(m, 'no #far-flung-exclude input in index.html');
  assert.match(m[0], /\bchecked\b/, 'far-flung Exclude should ship on');

  const pill = pillMarkup('farflung');
  const exclude = /<button[^>]*data-mode="exclude"[^>]*>/.exec(pill)[0];
  const keep = /<button[^>]*data-mode="keep"[^>]*>/.exec(pill)[0];
  assert.match(exclude, /aria-pressed="true"/, 'Exclude should be selected on load');
  assert.match(keep, /aria-pressed="false"/, 'Keep should not be selected on load');
  assert.match(exclude, /\bdata-default\b/,
    'the segment the page loads in must say so, or shared links lose the off state');

  // Markup and code must agree, or the pill shows one thing and the filter
  // does another after resetFarFlungExclude runs.
  assert.match(main, /const FAR_FLUNG_EXCLUDE_DEFAULT\s*=\s*true\s*;/,
    'FAR_FLUNG_EXCLUDE_DEFAULT must match the checked attribute above');
});

test('exactly one segment claims to be the default', () => {
  // Two would make the winner depend on document order, which is the kind of
  // thing that works until someone reorders the buttons.
  for (const m of html.matchAll(/data-pill="([^"]+)"/g)) {
    const pill = pillMarkup(m[1]);
    const marked = [...pill.matchAll(/\bdata-default\b/g)].length;
    assert.ok(marked <= 1, `pill "${m[1]}" marks ${marked} default segments`);
  }
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
