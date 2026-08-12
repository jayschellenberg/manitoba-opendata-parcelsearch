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
    { zoning: [z('Commercial'), z('Resdential')] },
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
  const straddle   = [z('Commercial'), z('Industrial')];

  // No selection is no filter.
  assert.equal(rowMatchesZoneCategories(commercial, new Set()), true);
  assert.equal(rowMatchesZoneCategories(commercial, null), true);

  assert.equal(rowMatchesZoneCategories(commercial, new Set(['Commercial'])), true);
  assert.equal(rowMatchesZoneCategories(commercial, new Set(['Industrial'])), false);

  // ANY zone counts — a parcel straddling two zones is genuinely both.
  assert.equal(rowMatchesZoneCategories(straddle, new Set(['Industrial'])), true);

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

console.log('zoneCategory.test.js: all assertions passed');
