// The Manitoba Highways popup's four traffic states.
//
// This popup is the one that started the whole traffic thread: it used to say
// only "Government of Manitoba road network, current to 2023", which reads as
// a statement ABOUT traffic and sent someone looking for counts that were one
// toggle away under a differently-named layer.
//
// Now it carries the count — but it resolves that asynchronously on click and
// by a synchronous peek on hover, so it has to distinguish states that are
// easy to collapse into each other and wrong when collapsed:
//
//   undefined  we have not looked (hover, data not loaded)  -> say nothing
//   null       we looked; MHTIS publishes no count for this road
//   object     the count
//   'pending'  a click's fetch is in flight
//
// Conflating the first two is the dangerous one: "no published traffic count"
// on a road that has one, purely because the user hovered before the layer
// finished loading, is a confident lie.
//
// Run: cd web && node test/highwayPopup.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'map.js'), 'utf8');

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** Lift a top-level function out of map.js; they close with `}` at column 0. */
function grabFn(name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `function ${name} not found in map.js`);
  const end = src.indexOf('\n}', at);
  return src.slice(at, end + 2);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const aadtYearSuffix = (y) =>
  (Number.isFinite(Number(y)) && Number(y) > 1900 ? ` (${Number(y)})` : '');

const mbHighwayHtml = new Function('escapeHtml', 'aadtYearSuffix',
  `${grabFn('mbHighwayHtml')}; return mbHighwayHtml;`)(escapeHtml, aadtYearSuffix);

const PTH68 = { RteType: '-PTH', CommonRoadName_004: '68', CommonRoadName_003: '' };
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

console.log('map.js — Manitoba Highways popup');

test('names the road in every state', () => {
  for (const traffic of [undefined, null, 'pending', { aadt: 2110, year: 2024 }]) {
    assert.match(mbHighwayHtml(PTH68, { traffic }), /Provincial Trunk Highway 68/);
  }
});

test('hovering before the data loads says NOTHING about traffic', () => {
  // The lie this guards against: claiming a road has no published count when
  // all that happened is the user hovered before the layer finished loading.
  const html = strip(mbHighwayHtml(PTH68, { traffic: undefined }));
  assert.doesNotMatch(html, /No published traffic count/);
  assert.doesNotMatch(html, /AADT/);
  assert.doesNotMatch(html, /Traffic count/);
});

test('a road MHTIS publishes no count for says so plainly', () => {
  // Access and service roads genuinely have none, and silence there would
  // read like the old no-traffic-info popup.
  assert.match(strip(mbHighwayHtml(PTH68, { traffic: null })), /No published traffic count/);
});

test('a resolved count shows the number, its year and its station', () => {
  const html = strip(mbHighwayHtml(PTH68, { traffic: { aadt: 2110, year: 2024, stationNum: 1897 } }));
  assert.match(html, /AADT \(2024\) 2,110/);
  assert.match(html, /Source station #1897/);
});

test('an undated count prints bare rather than inventing a year', () => {
  const html = strip(mbHighwayHtml(PTH68, { traffic: { aadt: 2110, year: null } }));
  assert.match(html, /AADT 2,110/);
  assert.doesNotMatch(html, /\(null\)|\(NaN\)|\(\)/);
});

test('an in-flight click shows a distinct pending line', () => {
  const html = strip(mbHighwayHtml(PTH68, { traffic: 'pending' }));
  assert.match(html, /Traffic count…/);
  assert.doesNotMatch(html, /No published traffic count/);
});

console.log('\nmap.js — Manitoba Highways hover wiring');

test('hover peeks and never awaits', () => {
  // Awaiting on hover would resolve after the cursor has moved on, and a
  // "Traffic count…" line flickering under a moving pointer is worse than
  // no line at all.
  const at = src.indexOf("map.on('mousemove', 'mb-highways-line'");
  assert.ok(at >= 0, 'no mousemove handler on mb-highways-line');
  const body = src.slice(at, src.indexOf("map.on('mouseleave', 'mb-highways-line'", at));
  assert.match(body, /mbHighwayAadtPeek/, 'hover must use the synchronous peek');
  assert.doesNotMatch(body, /await|\.then\(/, 'hover must not await');
});

test('hover is dismissed, and hands off to the pinned popup on click', () => {
  assert.match(src, /map\.on\('mouseleave', 'mb-highways-line'/);
  // Clicking removes the hover copy first; otherwise the pinned popup opens
  // on top of a second copy of itself at the cursor.
  assert.match(src, /highwaysHoverPopup\.remove\(\);\s*\/\/ hand off/);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
