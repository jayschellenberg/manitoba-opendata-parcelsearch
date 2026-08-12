// Unit tests for lib/zoneCategory.js — the Zoning Type rollup that sits
// above the municipality-specific zone code. Pins the normalization rules
// against the real vocabulary surveyed off the live ZONING service on
// 2026-08-12 (36 distinct values / 19,315 polygons), and the "any zone
// counts" matching rule the filter uses.
//
// Run: cd web && node test/zoneCategory.test.js

import assert from 'node:assert/strict';
import {
  NO_ZONE_CATEGORY,
  normalizeZoneCategory,
  zoneCategoryLabel,
  zoneCategoriesInRows,
  rowMatchesZoneCategories,
} from '../src/lib/zoneCategory.js';

/** A zoning match in the shape main.js's rows carry. */
const z = (cat) => ({ feature: { properties: { ZONE_CATEGORY: cat } } });

// ---- the common categories pass through untouched --------------------
for (const v of [
  'Residential', 'Commercial', 'Industrial', 'Institutional',
  'Open Space', 'Parks and Recreation', 'Mixed Use', 'Settlement Centre',
  'Rural Residential', 'Rural/Agricultural', 'Crown Land', 'WMA',
]) {
  assert.equal(normalizeZoneCategory(v), v, `${v} must survive unchanged`);
}

// ---- unambiguous typos fold -----------------------------------------
assert.equal(normalizeZoneCategory('Resdential'), 'Residential');
assert.equal(normalizeZoneCategory('esidential'), 'Residential');

// ---- leading/trailing/inner whitespace folds ------------------------
assert.equal(normalizeZoneCategory(' Rural Residential'), 'Rural Residential');
assert.equal(normalizeZoneCategory(' Settlement Centre'), 'Settlement Centre');
assert.equal(normalizeZoneCategory('Settlement  Centre'), 'Settlement Centre');
assert.equal(normalizeZoneCategory('Commercial  '), 'Commercial');

// ---- US/CA spelling and the agricultural family ---------------------
assert.equal(normalizeZoneCategory('Settlement Center'), 'Settlement Centre');
assert.equal(normalizeZoneCategory('Agricultural'), 'Rural/Agricultural');
assert.equal(normalizeZoneCategory('Agriculture'), 'Rural/Agricultural');
assert.equal(normalizeZoneCategory('Mixed'), 'Mixed Use');
assert.equal(normalizeZoneCategory('Recreational'), 'Recreation');

// ---- distinctions the province genuinely draws are PRESERVED --------
// Jason, 2026-08-12: typos and whitespace only. Merging these would
// destroy a difference that matters when picking comps.
assert.notEqual(
  normalizeZoneCategory('Open Space'),
  normalizeZoneCategory('Parks and Recreation'),
  'Open Space and Parks and Recreation are separate types',
);
assert.notEqual(
  normalizeZoneCategory('Recreation'),
  normalizeZoneCategory('Parks and Recreation'),
  'Recreation must not collapse into the broader Parks and Recreation',
);
assert.notEqual(
  normalizeZoneCategory('Residential'),
  normalizeZoneCategory('Rural Residential'),
  'Rural Residential is its own type, not a spelling of Residential',
);

// ---- blank / missing -------------------------------------------------
assert.equal(normalizeZoneCategory(''), null);
assert.equal(normalizeZoneCategory('   '), null);
assert.equal(normalizeZoneCategory(null), null);
assert.equal(normalizeZoneCategory(undefined), null);
assert.equal(normalizeZoneCategory('<Null>'), null, 'ArcGIS null sentinel');
assert.equal(zoneCategoryLabel(''), NO_ZONE_CATEGORY);
assert.equal(zoneCategoryLabel('Commercial'), 'Commercial');

// ---- an unknown category is kept, not guessed at ---------------------
// The survey can't have seen every by-law; a value that isn't a known
// typo is far likelier to be a real type than a mistake.
assert.equal(normalizeZoneCategory('Waterfront Resort'), 'Waterfront Resort');

// ---- zoneCategoriesInRows -------------------------------------------
{
  const rows = [
    { zoning: [z('Commercial')] },
    { zoning: [z('Resdential')] },
    { zoning: [z('Industrial')] },
    { zoning: [z('  Commercial ')] },   // dedupes with the first
    { zoning: [z('')] },                // blank → the explicit label
    { zoning: [] },                     // no zoning at all
  ];
  assert.deepEqual(
    zoneCategoriesInRows(rows),
    ['Commercial', 'Industrial', 'Residential', NO_ZONE_CATEGORY],
    'sorted, deduped after normalizing, with the blank label last',
  );
}

// Every offered option must return at least one row. A type appearing
// ONLY as some parcel's secondary zone is not offered, because the filter
// matches the dominant zone and ticking it would return nothing.
{
  const rows = [{ zoning: [z('Commercial'), z('Industrial')] }];
  assert.deepEqual(
    zoneCategoriesInRows(rows),
    ['Commercial'],
    'Industrial is only a secondary zone here, so it is not an option',
  );
}

// A custom accessor keeps the module free of the caller's row shape.
{
  const rows = [{ z: [z('Commercial')] }];
  assert.deepEqual(zoneCategoriesInRows(rows, (r) => r.z), ['Commercial']);
}

// Nothing to report on an empty / junk input.
assert.deepEqual(zoneCategoriesInRows([]), []);
assert.deepEqual(zoneCategoriesInRows(null), []);

// ---- rowMatchesZoneCategories ---------------------------------------
{
  const commercial = [z('Commercial')];

  // No selection is no filter.
  assert.equal(rowMatchesZoneCategories(commercial, new Set()), true);
  assert.equal(rowMatchesZoneCategories(commercial, null), true);

  assert.equal(rowMatchesZoneCategories(commercial, new Set(['Commercial'])), true);
  assert.equal(rowMatchesZoneCategories(commercial, new Set(['Industrial'])), false);

  // Matching runs on the NORMALIZED value, so ticking "Residential"
  // catches the typo'd polygon too. This is the silent miss the
  // normalization exists to prevent.
  assert.equal(
    rowMatchesZoneCategories([z('Resdential')], new Set(['Residential'])),
    true,
    'a typo\'d polygon must not fall out of its own category',
  );

  // A row with no zoning join reads as "(no category)" — from the user's
  // side, an unjoined sale and a blank field are the same thing.
  assert.equal(rowMatchesZoneCategories([], new Set([NO_ZONE_CATEGORY])), true);
  assert.equal(rowMatchesZoneCategories([], new Set(['Commercial'])), false);
  assert.equal(rowMatchesZoneCategories([z('')], new Set([NO_ZONE_CATEGORY])), true);
}

// ---- REGRESSION: the grid and the filter must never disagree ---------
// Reported 2026-08-12: "Commercial is checked but I sometimes see
// Industrial in the Zoning Type column."
//
// joinTopNByArea keeps the top 2 zoning polygons per parcel, sorted by
// descending share of parcel area, so zoning[0] is the DOMINANT zone.
// The Zoning Type column renders zoning[0]. Matching on ANY zone let a
// parcel 90% Industrial / 10% Commercial pass a Commercial filter and
// then display "Industrial". Matching the dominant zone makes the two
// agree by construction.
{
  const parcels = [
    { name: 'pure commercial',   zoning: [z('Commercial')] },
    { name: 'mostly commercial', zoning: [z('Commercial'), z('Industrial')] },
    { name: 'mostly industrial', zoning: [z('Industrial'), z('Commercial')] },
    { name: 'pure industrial',   zoning: [z('Industrial')] },
    { name: 'no zoning join',    zoning: [] },
  ];

  // The invariant, stated directly: for EVERY row and EVERY selection, a
  // kept row's displayed type is one of the ticked ones.
  for (const ticked of [['Commercial'], ['Industrial'], ['Commercial', 'Industrial'], [NO_ZONE_CATEGORY]]) {
    const sel = new Set(ticked);
    for (const p of parcels) {
      if (!rowMatchesZoneCategories(p.zoning, sel)) continue;
      const shown = p.zoning.length
        ? zoneCategoryLabel(p.zoning[0].feature.properties.ZONE_CATEGORY)
        : NO_ZONE_CATEGORY;
      assert.ok(
        sel.has(shown),
        `${p.name} survived {${ticked}} but the grid would show "${shown}"`,
      );
    }
  }

  // And the specific case, spelled out.
  const commercialOnly = new Set(['Commercial']);
  const kept = parcels.filter((p) => rowMatchesZoneCategories(p.zoning, commercialOnly));
  assert.deepEqual(
    kept.map((p) => p.name),
    ['pure commercial', 'mostly commercial'],
    'a mostly-industrial parcel must not survive a Commercial filter',
  );
}

// ---- LOAD / REFRESH SEQUENCES ---------------------------------------
// The filter control is rebuilt from the current rows on every upload
// (syncZoningFilterOptions) and re-applied on every filter change
// (refilterCsvIfActive). These walk the orders those actually happen in,
// against the same retainSelection the multi-select uses, so a stale tick
// or a silently-dropped one shows up here rather than in the grid.
{
  const { retainSelection } = await import('../src/lib/multiSelect.js');

  /** One upload: rebuild the options, keep whatever ticks survive. */
  const load = (rows, ticked) => {
    const options = zoneCategoriesInRows(rows);
    const kept = retainSelection(ticked, options);
    return { options, ticked: kept };
  };
  /** Apply the current ticks to the rows, as refilterCsvIfActive does. */
  const applyFilter = (rows, ticked) =>
    rows.filter((r) => rowMatchesZoneCategories(r.zoning, new Set(ticked)));

  const commercial = { id: 'c', zoning: [z('Commercial')] };
  const industrial = { id: 'i', zoning: [z('Industrial')] };
  const mixed      = { id: 'm', zoning: [z('Industrial'), z('Commercial')] };
  const unjoined   = { id: 'u', zoning: [] };

  // 1. First load, nothing ticked → every row shows.
  let state = load([commercial, industrial, mixed], []);
  assert.deepEqual(state.options, ['Commercial', 'Industrial']);
  assert.equal(applyFilter([commercial, industrial, mixed], state.ticked).length, 3,
    'no ticks means no filtering');

  // 2. Tick Commercial → only the commercial-dominant rows survive.
  state.ticked = ['Commercial'];
  assert.deepEqual(
    applyFilter([commercial, industrial, mixed], state.ticked).map((r) => r.id),
    ['c'],
    'the industrial-dominant mixed parcel must not leak through',
  );

  // 3. Re-filter again without reloading — idempotent, no drift.
  assert.deepEqual(
    applyFilter(applyFilter([commercial, industrial, mixed], state.ticked), state.ticked)
      .map((r) => r.id),
    ['c'],
  );

  // 4. Re-upload a set that STILL has Commercial → the tick survives.
  state = load([commercial, unjoined], state.ticked);
  assert.deepEqual(state.options, ['Commercial', NO_ZONE_CATEGORY]);
  assert.deepEqual(state.ticked, ['Commercial'], 'a still-valid tick is kept across a reload');
  assert.deepEqual(applyFilter([commercial, unjoined], state.ticked).map((r) => r.id), ['c']);

  // 5. Re-upload a set with NO Commercial → the stale tick is dropped,
  //    and the filter falls back to "everything" rather than to an
  //    impossible selection that would render an empty grid.
  state = load([industrial], state.ticked);
  assert.deepEqual(state.options, ['Industrial']);
  assert.deepEqual(state.ticked, [], 'a tick with no matching option is dropped');
  assert.deepEqual(applyFilter([industrial], state.ticked).map((r) => r.id), ['i'],
    'dropping the stale tick must not leave the grid empty');

  // 6. A search resets the control (setOptions([])) — no options, no
  //    ticks, and the next load starts clean.
  state = load([], ['Industrial']);
  assert.deepEqual(state.options, []);
  assert.deepEqual(state.ticked, []);

  // 7. Enrichment ordering: if the options were ever built BEFORE the
  //    zoning join landed, every row would look unjoined and the only
  //    option would be "(no category)". Pinning it makes the ordering
  //    requirement explicit — syncZoningFilterOptions must stay after
  //    enrichOverlays in handleSalesUpload.
  const preJoin = [{ id: 'c', zoning: [] }, { id: 'i', zoning: [] }];
  assert.deepEqual(zoneCategoriesInRows(preJoin), [NO_ZONE_CATEGORY],
    'options built before the zoning join would offer nothing useful');

  // 8. "(no category)" is tickable and finds both the unjoined rows and
  //    the ones whose polygon carried a blank field.
  const blankField = { id: 'b', zoning: [z('')] };
  state = load([commercial, unjoined, blankField], [NO_ZONE_CATEGORY]);
  assert.deepEqual(
    applyFilter([commercial, unjoined, blankField], state.ticked).map((r) => r.id),
    ['u', 'b'],
  );
}

console.log('zoneCategory.test.js: all assertions passed');
