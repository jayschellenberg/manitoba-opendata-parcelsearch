/*
 * Farmland land-cover buckets.
 *
 * r/build_landcover.R collapses the 12 classes of the 2020 Land Cover
 * raster (LCR_RCT_2020_MB.tif, extracted per parcel by the mao-assembly
 * pipeline) into five appraisal-oriented buckets and ships them as
 * per-muni shards. Each parcel's `_landCover` stamp (set in main.js from
 * the shard) is a plain object of fractions (0-1) that sum to ~1:
 *
 *   { cult: 0.78, past: 0.10, bush: 0.08, wet: 0.03, other: 0.01 }
 *
 * Only parcels over 20 acres are in the shards, so `_landCover` is
 * undefined on urban/residential rolls — callers gate display on the
 * parcel's own computed acreage (> 20 ac) as well, per spec.
 *
 * This module is the single source of truth for the bucket order,
 * labels, and colours, shared by the results grid (main.js) and the
 * map popup (map.js) so the two never drift.
 */

// Bucket order = display order in the popup breakdown. Colours echo the
// natural reading of each cover type (gold cropland, sage pasture, dark
// green bush, blue water, grey built-up/barren).
export const LAND_COVER_BUCKETS = [
  { key: 'cult',  label: 'Cultivated',    color: '#d8a93b' },
  { key: 'past',  label: 'Pasture/Grass', color: '#9ab95a' },
  { key: 'bush',  label: 'Bush/Treed',    color: '#3f7d3f' },
  { key: 'wet',   label: 'Wetland/Water', color: '#4a90c2' },
  { key: 'other', label: 'Other',         color: '#b0b0b0' },
];

// Buckets below this share are dropped from the popup breakdown —
// sub-1% slivers are raster edge noise and only clutter the box.
const MIN_SHARE = 0.01;

/**
 * Every non-zero bucket as {key, label, color, pct}, in canonical
 * order. Returns null when `lc` carries no usable land-cover data.
 */
export function landCoverFractions(lc) {
  if (!lc || typeof lc !== 'object') return null;
  const out = [];
  for (const b of LAND_COVER_BUCKETS) {
    const v = Number(lc[b.key]);
    if (Number.isFinite(v) && v > 0) out.push({ ...b, pct: v });
  }
  return out.length ? out : null;
}

/**
 * Buckets sorted by share (largest first), dropping sub-1% slivers.
 * Drives the popup breakdown. Null when there's no land-cover data.
 */
export function landCoverBreakdown(lc) {
  const all = landCoverFractions(lc);
  if (!all) return null;
  const rows = all
    .filter((b) => b.pct >= MIN_SHARE)
    .sort((a, b) => b.pct - a.pct);
  return rows.length ? rows : null;
}

/**
 * The dominant (largest-share) bucket as {key, label, color, pct}, or
 * null. Drives the grid's "Land Cover" cell and its sort key.
 */
export function dominantBucket(lc) {
  const all = landCoverFractions(lc);
  if (!all) return null;
  return all.reduce((best, b) => (b.pct > best.pct ? b : best));
}

/**
 * Cultivated fraction (0-1), or null when there's no land-cover data.
 * Drives the grid's numeric "Cult %" cell and its sort key.
 */
export function cultFraction(lc) {
  if (!lc || typeof lc !== 'object') return null;
  const v = Number(lc.cult);
  return Number.isFinite(v) ? v : null;
}
