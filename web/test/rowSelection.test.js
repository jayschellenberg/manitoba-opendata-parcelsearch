// The row-selection contract: unticking a sale must reach all three places.
//
// WHY THIS EXISTS. Jason, 2026-09-13: "a select column of checkboxes where all
// records are selected/shown by default and if you unselect a row it is hidden
// from map", scoped to map + CSV export + charts, with a warning prompt before
// an export or a chart that would silently carry fewer rows.
//
// Three separate consumers read the selection, and a miss in any one of them
// is invisible: the grid looks right, the checkbox looks right, and only the
// number at the far end is wrong. That is this repo's recurring failure — code
// that exists and is never called — so each hop is asserted by name rather
// than trusted.
//
// The subtle one is ORDER inside setMapData. A parcel that sold twice
// contributes two features; the per-parcel dedupe collapses them. Filtering
// AFTER the dedupe would drop the parcel whenever the surviving feature
// happened to be the unticked sale, so unticking one sale could erase a
// parcel whose other sale is still on the grid. Filter first, dedupe second.
//
// Run: cd web && node test/rowSelection.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const rawSrc = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');

/** Comments stripped — a test that matches its own documentation proves
 *  nothing. See searchReset.test.js; that lesson was paid for twice. */
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

/** A top-level function's source, or null. They close with `}` at column 0. */
function fnBody(name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) return null;
  const end = src.indexOf('\n}', m.index);
  return end < 0 ? null : src.slice(m.index, end + 2);
}

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('row selection — unticking reaches map, export and charts');

test('the column exists in the header, pinned and ungearable', () => {
  const th = /<th data-col="select"[^>]*>/.exec(html);
  assert.ok(th, 'no <th data-col="select"> in index.html');
  assert.match(th[0], /data-no-gear/,
    'the select column must be data-no-gear: a control column that a preset '
    + 'could hide would strand unticked rows with no way to tick them back');
  assert.match(th[0], /sales-only/, 'the column should only show in sales mode');
  assert.match(html, /id="select-all-rows"/, 'the header tick-all box is missing');
});

test('renderTable actually appends the cell', () => {
  // The recurring bug: defined, styled, documented, never called.
  const body = fnBody('renderTable');
  assert.ok(body, 'renderTable not found');
  assert.match(body, /appendChild\(selectCell\(row\)\)/,
    'selectCell exists but renderTable never appends it');
  assert.ok(fnBody('selectCell'), 'selectCell is not defined');
});

test('the cell sits immediately before the star, matching the thead', () => {
  // Columns are matched BY POSITION (columns.js). A cell appended in a
  // different order than the <th>s puts every later value in the wrong
  // column — silently, since most cells are plain text.
  const body = fnBody('renderTable');
  const sel = body.indexOf('appendChild(selectCell(row))');
  const fav = body.indexOf('appendChild(favoriteCell(row))');
  assert.ok(sel >= 0 && fav >= 0, 'both control cells must be appended');
  assert.ok(sel < fav, 'selectCell must be appended before favoriteCell');
  const thSel = html.indexOf('data-col="select"');
  const thFav = html.indexOf('data-col="favorite"');
  assert.ok(thSel < thFav, 'the <th> order must match the cell order');
});

test('the header tick-all is wired, not just rendered', () => {
  assert.ok(fnBody('wireSelectAllBox'), 'wireSelectAllBox is not defined');
  const calls = [...src.matchAll(/wireSelectAllBox\s*\(/g)];
  assert.ok(calls.length >= 2, 'wireSelectAllBox is defined but never called');
  assert.ok(fnBody('syncSelectAllBox'), 'syncSelectAllBox is not defined');
  // Must be recomputed on render, or a filter that removes the last unticked
  // row leaves the header stuck indeterminate.
  assert.match(fnBody('renderTable'), /syncSelectAllBox\s*\(/,
    'renderTable must resync the header box');
});

test('setMapData filters BEFORE the per-parcel dedupe', () => {
  const body = fnBody('setMapData');
  assert.ok(body, 'setMapData not found');
  assert.match(body, /deselectedSaleKeys/,
    'setMapData does not consult the selection — unticking would not hide anything');
  // Name the variable the dedupe is FED, not merely the order the identifiers
  // happen to appear in. An earlier version of this assertion compared string
  // offsets and stayed green when the dedupe was re-pointed at the unfiltered
  // collection, because the filter expression was still sitting above it.
  const fed = /dedupeParcelFeaturesForMap\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(body);
  assert.ok(fed, 'the per-parcel dedupe is gone');
  const at = body.search(new RegExp(`\\bconst ${fed[1]}\\s*=`));
  assert.ok(at >= 0, `the dedupe is fed ${fed[1]}, which is not built in setMapData`);
  // Everything from the declaration up to the dedupe call: whatever builds
  // the collection has to happen in there, whatever its line endings.
  const assign = body.slice(at, body.indexOf('dedupeParcelFeaturesForMap('));
  assert.match(assign, /deselectedSaleKeys/,
    `the dedupe is fed ${fed[1]}, which has not been filtered by the selection — `
    + 'filtering after the dedupe can erase a parcel whose OTHER sale is still ticked');
});

test('the CSV export drops unticked rows and warns first', () => {
  const body = fnBody('exportCsv');
  assert.ok(body, 'exportCsv not found');
  assert.match(body, /rowIsSelected/, 'exportCsv does not apply the selection');
  assert.match(body, /confirmCulledExport\s*\(/,
    'exportCsv must warn before writing a file that omits rows');
  assert.ok(fnBody('confirmCulledExport'), 'confirmCulledExport is not defined');
  // Starring expands to whole sale groups; that expansion must not resurrect
  // a row the user explicitly unticked.
  const starred = body.slice(body.indexOf('starredGroupIds'));
  assert.match(starred, /rowIsSelected/,
    'the starred-only expansion must still honour the checkboxes');
});

test('the charts read only ticked rows, and the button warns', () => {
  const body = fnBody('publishSalesCharts');
  assert.ok(body, 'publishSalesCharts not found');
  assert.match(body, /filter\(rowIsSelected\)/,
    'the charts would plot rows the map is hiding');
  // The warning belongs on the button, not on publish: publish also runs on
  // every ordinary re-render, and a confirm there would fire constantly.
  const handler = /getElementById\('charts-open'\)[\s\S]{0,700}/.exec(src);
  assert.ok(handler, 'the charts-open handler is gone');
  assert.match(handler[0], /confirmCulledExport\s*\(/,
    'opening the charts must warn when rows are unticked');
  assert.ok(!/confirmCulledExport/.test(body),
    'publishSalesCharts must NOT confirm — it runs on every re-render');
});

test('the count line states the cull', () => {
  const body = fnBody('renderResultsStatus');
  assert.ok(body, 'renderResultsStatus not found');
  assert.match(body, /deselectedCount\(/,
    'the status line must say how many rows are hidden — the grid still lists them');
});

test('the selection is never persisted', () => {
  // Deliberate. A remembered cull is the far-flung exclusion bug: a filter
  // that silently drops rows in a session the user did not set it in.
  assert.ok(!/setItem\([^)]*deselected/i.test(src),
    'row selection must not be written to localStorage');
  assert.ok(!/getItem\([^)]*deselected/i.test(src),
    'row selection must not be restored from localStorage');
});

test('an unticked row stays visible on the grid', () => {
  // Dimmed, not removed: a culled comp you cannot see is a comp you cannot
  // put back.
  assert.match(css, /tr\.deselected/, 'no styling for an unticked row');
  assert.ok(!/tr\.deselected[^{]*\{[^}]*display:\s*none/.test(css),
    'unticked rows must not be hidden from the table itself');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
