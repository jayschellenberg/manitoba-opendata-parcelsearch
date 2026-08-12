/*
 * Zoning Type — the broad ZONE_CATEGORY that sits above the municipality-
 * specific zone CODE.
 *
 * A code like "CG2" means nothing across municipal lines: every Manitoba
 * by-law invents its own. ZONE_CATEGORY is the province's own rollup of
 * those codes into a dozen readable types (Commercial, Industrial, Open
 * Space...), which is what makes a cross-muni comp search possible at all.
 * The field already rides along on every zoning polygon the app fetches
 * (ZONING_OUTFIELDS in arcgis.js) — this module only cleans it.
 *
 * And it needs cleaning. A survey of the live service on 2026-08-12 found
 * 36 distinct values across 19,315 polygons, where the real list is ~14.
 * The tail is data entry noise: single-polygon typos ("Resdential",
 * "esidential"), leading spaces (" Rural Residential"), and US/CA spelling
 * splits ("Settlement Center"). Left raw, the filter dropdown shows 36
 * entries with visible near-duplicates and ticking "Residential" silently
 * misses two parcels — the kind of quiet miss that makes a filter stop
 * being trusted.
 *
 * What this deliberately does NOT do is merge categories the province
 * genuinely distinguishes (Jason, 2026-08-12). "Open Space" (917 polygons)
 * and "Parks and Recreation" (1,257) are separate types, not two spellings
 * of one, and collapsing them would destroy a distinction that matters when
 * picking comps. Only unambiguous errors fold.
 *
 * Pure (no DOM / no network) so it can be unit-tested in node.
 */

/**
 * The label shown for a zoning polygon carrying no category at all — 148
 * polygons province-wide. Given its own tickable entry rather than being
 * dropped, so those sales can be found deliberately instead of quietly
 * falling out of every category filter.
 */
export const NO_ZONE_CATEGORY = '(no category)';

/**
 * Unambiguous-error folds, keyed by the aggressively-normalized form
 * (uppercase, punctuation and whitespace stripped — see foldKey). Value is
 * the canonical display spelling.
 *
 * Every entry here is a value the province publishes on a HANDFUL of
 * polygons where a far more common spelling of the same thing exists. The
 * counts in the comments are from the 2026-08-12 survey; they're the
 * evidence that these are mistakes rather than distinct types.
 */
export const ZONE_CATEGORY_ALIASES = new Map([
  // Typos — 1 polygon each, against 7,854 for "Residential".
  ['RESDENTIAL',      'Residential'],
  ['ESIDENTIAL',      'Residential'],
  // US spelling, 1 polygon, against 1,201 for the Canadian "Centre".
  ['SETTLEMENTCENTER', 'Settlement Centre'],
  // The agricultural family: "Agricultural" (1) and "Agriculture" (3) are
  // strays beside "Rural/Agricultural" (2,624), which is the form the
  // by-laws actually use.
  ['AGRICULTURAL',    'Rural/Agricultural'],
  ['AGRICULTURE',     'Rural/Agricultural'],
  // "Mixed" (1) against "Mixed Use" (337).
  ['MIXED',           'Mixed Use'],
  // "Recreational" (1) against "Recreation" (6). NOT folded into "Parks
  // and Recreation" (1,257) — that is a different, broader type.
  ['RECREATIONAL',    'Recreation'],
]);

/**
 * Aggressive key for alias lookup: uppercase, strip everything that isn't
 * a letter or digit. Collapses the leading-space and punctuation variants
 * (" Rural Residential", "Settlement  Centre") onto their clean twin
 * without needing an alias entry for each.
 */
function foldKey(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

/**
 * Canonical display form of a raw ZONE_CATEGORY.
 *
 * Returns null for a blank/missing category, so callers can decide
 * between the NO_ZONE_CATEGORY label (the grid, the filter list) and
 * omitting it entirely. Anything not in the alias table is returned
 * whitespace-trimmed but otherwise untouched — an unknown category is far
 * more likely to be a real type this survey didn't see than a typo, and
 * silently rewriting it would be worse than showing it.
 */
export function normalizeZoneCategory(raw) {
  const trimmed = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed === '<Null>') return null;
  const alias = ZONE_CATEGORY_ALIASES.get(foldKey(trimmed));
  return alias || trimmed;
}

/** The category to DISPLAY — normalized, or the explicit blank label. */
export function zoneCategoryLabel(raw) {
  return normalizeZoneCategory(raw) ?? NO_ZONE_CATEGORY;
}

/**
 * Every distinct Zoning Type offered by a row set, as display labels,
 * sorted — with NO_ZONE_CATEGORY forced last so the real types lead the
 * dropdown.
 *
 * Reads the DOMINANT zone of each row, matching rowMatchesZoneCategories.
 * If this collected secondary zones too, a type that only ever appears as
 * some parcel's minor zone would sit in the dropdown and return nothing
 * when ticked — an option that does nothing is worse than an absent one.
 * Every entry this returns is guaranteed to keep at least one row.
 *
 * `zoningOf(row)` extracts a row's zoning-match array, keeping this
 * module free of the caller's row shape.
 */
export function zoneCategoriesInRows(rows, zoningOf) {
  const seen = new Set();
  for (const row of rows || []) {
    const matches = zoningOf ? zoningOf(row) : row?.zoning;
    const dominant = (matches || [])[0];
    seen.add(zoneCategoryLabel(dominant?.feature?.properties?.ZONE_CATEGORY));
  }
  const hasBlank = seen.delete(NO_ZONE_CATEGORY);
  const out = [...seen].sort((a, b) => a.localeCompare(b));
  if (hasBlank) out.push(NO_ZONE_CATEGORY);
  return out;
}

/**
 * Does a row match the ticked Zoning Types?
 *
 * Matches on the DOMINANT zone only — zoningMatches[0], the polygon
 * covering the largest share of the parcel, which joinTopNByArea sorts to
 * the front. Deliberately NOT "any zone matches" (Jason, 2026-08-12).
 *
 * The zone CODE filter beside this one does use any-zone matching, and
 * this started out copying it. But that filter shows BOTH the Zoning and
 * Zoning 2 columns, so a row kept on its secondary zone explains itself.
 * The Zoning Type column shows only the dominant type, so any-zone
 * matching produced rows that flatly contradicted the filter: a parcel 90%
 * Industrial with a 10% Commercial sliver passed a Commercial filter and
 * then displayed "Industrial".
 *
 * Matching the dominant zone also happens to be the right appraisal
 * answer. A parcel that is 90% industrial is not a commercial comp; one
 * that is 70% commercial is. The cutoff is sharp at 50/50, but it is the
 * same cutoff the grid already uses to decide what to display, so the two
 * can never disagree.
 *
 * An empty selection is no filter at all. A row with no zoning matches
 * counts as NO_ZONE_CATEGORY, so ticking "(no category)" finds the sales
 * whose zoning join produced nothing as well as those whose polygon
 * carried a blank field — from the user's side those are the same thing.
 */
export function rowMatchesZoneCategories(zoningMatches, selected) {
  if (!selected || selected.size === 0) return true;
  const dominant = (zoningMatches || [])[0];
  if (!dominant) return selected.has(NO_ZONE_CATEGORY);
  return selected.has(zoneCategoryLabel(dominant?.feature?.properties?.ZONE_CATEGORY));
}
