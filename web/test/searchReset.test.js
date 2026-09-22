// The reset contract: what a new Search must not inherit from the last one.
//
// WHY THIS EXISTS. Jason, 2026-09-13: "When I do multiple searches one after
// the other without hitting clear in between, I'm worried that things aren't
// resetting properly." He was right twice.
//
//   selectedParcelRow   The Parcel Summary panel kept showing a parcel from
//                       the PREVIOUS result set. Its "export this parcel"
//                       button exported that parcel, and readCurrentUrlState
//                       put its roll in the shared link, while a different
//                       search sat in the table. clearSelectedParcel() existed
//                       for exactly this and was never called from anywhere.
//   changesShowPrevMsg  The Changes pill stashes the count line it wrote over
//                       so turning Show off can restore it. Across a search it
//                       restored the previous result set's tally.
//
// Neither was a logic error. Both were state nobody remembered to reset, in a
// module with 93 top-level `let`s — which is precisely the thing a human
// review does not reliably catch and a list does.
//
// HOW IT CHECKS. runSearch clears most state indirectly, through helpers it
// always calls (clearTable, setMapData, clearMapShapes, resetWaterFilterBase).
// So "assigned inside runSearch" is too strict a test. The reset SURFACE is
// runSearch plus the bodies of every function it calls, and a variable counts
// as reset if it is assigned anywhere in that surface.
//
// This is a source-text check. It cannot prove the reset happens on every
// code path, and it is not a substitute for running two searches. What it does
// is make "new per-result state was added and nothing resets it" a build
// failure instead of something a user notices months later.
//
// Run: cd web && node test/searchReset.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawSrc = fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');

/**
 * Source with comments removed.
 *
 * This is load-bearing, not tidiness. The first version of this file read the
 * raw text, and the comment explaining the selectedParcelRow fix *mentioned*
 * `clearSelectedParcel()` — so when the call itself was deleted the test still
 * passed, matching the prose. A test that reads its own documentation as
 * evidence proves nothing, and this one was caught only by deliberately
 * reverting the fix to watch it fail.
 *
 * Line comments are cut only when the `//` is not part of a `://` URL and not
 * inside a string literal on that line; this file is full of both.
 */
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

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** A top-level function's source, or null. They close with `}` at column 0. */
function fnBody(name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) return null;
  const end = src.indexOf('\n}', m.index);
  return end < 0 ? null : src.slice(m.index, end + 2);
}

const searchBody = fnBody('runSearch');

/** runSearch plus every function it calls — the code a search actually runs. */
const resetSurface = (() => {
  const called = [...new Set(
    [...searchBody.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
  )];
  return [searchBody, ...called.map(fnBody).filter(Boolean)].join('\n');
})();

const isAssignedIn = (v, text) => new RegExp(`(^|[^.\\w])${v}\\s*=[^=]`).test(text);

// ---------------------------------------------------------------------------
// State that DESCRIBES THE CURRENT RESULT SET. Every one of these must be
// reset when a new search starts, or it describes the previous one.
// ---------------------------------------------------------------------------
const PER_RESULT = [
  'currentRows', 'currentPage',
  'lastResultFc', 'lastZoningFc', 'lastDevPlanFc',
  'lastAsOfHighlight', 'lastWithheldGeometry',
  'csvFullRows', 'csvFullBaseMsg', 'csvMatchedMunis',
  'basicFullRows', 'basicFullMsg',
  'enteredRollOrder', 'salesMuniLoaded',
  'waterFilterBaseRows', 'waterFilterBaseMsg', 'lastWaterFilterDropped',
  'subjectFeature', 'subjectCentroid',
  'devPlanDeferred', 'searchHasRun', 'salesExportEnrichmentComplete',
  'selectedParcelRow',    // the 2026-09-13 leak
  'deselectedSaleKeys',   // row culling belongs to the result set it was done on
  'changesShowPrevMsg',   // the 2026-09-13 leak
  // Which themed overlay filled the grid. A search takes the grid from it, and
  // an overlay that still believed it owned these rows would hand the search's
  // results to another overlay on its way off (regrantResultsGrid).
  'overlayGridOwner',
  // The grid's parcel-scoped soil and the parcel set it was fetched for.
  // Keyed on the result parcels, so a stale one would miss rather than
  // mislead — but it is tens of megabytes of polygons belonging to a result
  // set that is gone, which is the cost the scoped fetch exists to avoid.
  'gridSoilFc', 'gridSoilKey',
  // Municipalities the user panned the soil overlay into. Scoped to the
  // result set that was on screen when they panned.
  'soilPannedMunis',
];

// State that SURVIVES a search on purpose. Listed with the reason, so the
// decision is recorded rather than rediscovered.
const PERSISTENT = {
  listParcelKeys: 'an imported list outlives a search by design; the pill clears it',
  listMatchedMunis: 'travels with listParcelKeys',
  listUnresolvedRows: 'travels with listParcelKeys — runSearch preserves the panel in list mode',
  listImportNotices: 'travels with listParcelKeys',
  listSiteByKey: 'travels with listParcelKeys',
  exportColumnMismatchWarned: 'warn-once-per-session flag; resetting it would nag',
  currentSort: "the user's sort preference, not a property of the results",
  numberingOn: 'a display preference that should carry across searches',
  numberingEntryOrder: 'travels with numberingOn',
  trafficFlowFcPromise: 'session memo for the Traffic Flow FC; refetching it per search would be pure waste',
  tileNetworkLastKey: 'cache key for the loaded tile-network scope, invalidated by scope not by search',
};

console.log('main.js — what a new Search must not inherit');

test('runSearch exists and calls its reset helpers', () => {
  assert.ok(searchBody, 'runSearch not found in main.js');
  for (const helper of ['clearTable', 'setMapData']) {
    assert.match(searchBody, new RegExp(`\\b${helper}\\s*\\(`), `runSearch must call ${helper}`);
  }
});

test('every per-result variable is reset by a search', () => {
  const missing = PER_RESULT.filter((v) => !isAssignedIn(v, resetSurface));
  assert.deepEqual(missing, [],
    `state describing the last result set, never reset by a new search: ${missing.join(', ')}`);
});

test('every per-result variable actually exists', () => {
  // Guards the list itself: a renamed variable would otherwise silently stop
  // being checked while the test kept passing.
  const gone = PER_RESULT.filter((v) => !new RegExp(`^let ${v}\\b`, 'm').test(src));
  assert.deepEqual(gone, [], `listed but no longer declared in main.js: ${gone.join(', ')}`);
});

test('the two 2026-09-13 leaks stay fixed', () => {
  // Named individually so a regression says which one, not just "something".
  assert.ok(isAssignedIn('selectedParcelRow', resetSurface),
    'the Parcel Summary panel would show a parcel from the previous search');
  assert.ok(isAssignedIn('changesShowPrevMsg', resetSurface),
    'turning Changes off would restore the previous search\'s count line');
  // clearSelectedParcel was dead code for the whole time the bug existed.
  assert.match(searchBody, /clearSelectedParcel\s*\(/,
    'runSearch must call clearSelectedParcel, not merely have it defined');
});

test('persistent state is documented, not accidental', () => {
  for (const [v, reason] of Object.entries(PERSISTENT)) {
    assert.ok(reason && reason.length > 20, `${v} needs a real reason, not a placeholder`);
    assert.ok(!PER_RESULT.includes(v), `${v} cannot be both per-result and persistent`);
  }
});

test('new module state forces a decision', () => {
  // The point of the whole file. Any top-level `let` that is neither
  // classified above nor matched by a category rule is reported, so adding
  // per-result state without resetting it fails the build instead of
  // surfacing as a stale panel months later.
  const declared = [...src.matchAll(/^let ([a-zA-Z_$][\w$]*)\s*[=;]/gm)].map((m) => m[1]);
  const CATEGORY_RULES = [
    // muni/overlay-scoped: reset by resetMascAndGridToggles on muni change.
    // PushedFor is the LoadedFor twin — what has been fetched vs what is
    // actually sitting in a map source — and shares its lifecycle exactly.
    /LoadedFor$/, /PushedFor$/, /OverlayOn$/, /Mode$/, /Cache$/, /^historical/, /^muni/, /^_muni/,
    // transient plumbing: timers, generations, in-flight guards, UI bookkeeping
    /Timer$/, /Generation$/, /Seq$/, /Pending$/, /Ops$/, /Running$/, /Abort$/,
    /^capture/, /^route/, /^sales/, /^chartsChannel$/, /^urlWritePending$/,
    /^lastSizeUom$/, /^lastCountText$/, /^resultsSettling/, /^waterRightsWanted/,
    /^soilStampWanted/, /^waterOverlayOn$/, /^waterInfluenceRerunTimer$/,
    /^landCoverOpacity$/, /^landCoverRasterAvailable$/, /^gridMode$/, /^cliMode$/,
    /^lastCliFc$/, /^selectedParcelRow$/, /^muniPicker$/, /^searchHasRun$/,
    // The CLI overlay's identity palette, carried across to the measurement
    // FC by soil code. Owned by the overlay mode, cleared when it changes.
    /^cliIdentityColorByCode$/,
  ];
  const unclassified = declared.filter((v) =>
    !PER_RESULT.includes(v)
    && !(v in PERSISTENT)
    && !CATEGORY_RULES.some((re) => re.test(v)));
  assert.deepEqual(unclassified, [],
    `new top-level state in main.js — decide whether a new Search must reset it, `
    + `then add it to PER_RESULT or PERSISTENT in this file: ${unclassified.join(', ')}`);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
