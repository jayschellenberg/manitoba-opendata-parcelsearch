/*
 * Farmland land-cover buckets, and which of two sources is the headline.
 *
 * Two per-parcel stamps carry the same five fractions of the parcel,
 * { cult, past, bush, wet, other }, summing to ~1:
 *
 *   `_landfacts.mix`  the CROP INVENTORY read per pixel over 2021-2025 by
 *                     r/build_landfacts.R (see lib/landfacts.js) — the
 *                     headline whenever it is present. Parcels of 20 acres
 *                     or more with a MASC rating.
 *   `_landCover`      the STATCAN LAND COVER REGISTER, reference year 2020,
 *                     collapsed from its 11 classes by r/build_landcover.R
 *                     via the mao-assembly pipeline. Parcels over
 *                     LAND_COVER_MIN_ACRES. The headline only where the mix
 *                     is absent; otherwise the cross-check.
 *
 * WHY THE CROP INVENTORY LEADS (Jason, 2026-09-15): it is five years
 * fresher, annual, and trained on Manitoba crop-insurance ground truth,
 * and its cultivated figure is a pixel-level land-use rule rather than a
 * fixed 2020 epoch. WHY THE REGISTER STAYS: measured across 173,671
 * parcels the two agree on cultivated share to a median 0.0 pp, and where
 * they disagree by more than COVER_DISAGREE_MIN neither is authoritative —
 * that flag is worth more to an appraiser than either number alone. The
 * register also cannot split its "grassland & shrubland" class, so the
 * two legitimately differ on shrub-heavy ground.
 *
 * headlineCover() is the one place that choice is made; the grid, both
 * popups, the CSV and the Land Cover map overlay all go through it.
 *
 * This module is the single source of truth for the bucket order, labels
 * and colours, shared by the results grid (main.js) and the map popup
 * (map.js) so the two never drift.
 */

import { landMix, readLandfacts } from './landfacts.js';

// Minimum parcel acreage that gets land-cover data. Below this, the
// pipeline drops the parcel from the per-muni shards (urban/residential
// lots that the 2020 LCR raster can't usefully resolve at 30m, and that
// don't carry a meaningful single "headline" cover). KEEP IN SYNC with
// r/build_landcover.R's ACRES_THRESHOLD — both the pipeline and the
// webapp's display gates read this constant, so changing it here and
// re-running the pipeline propagates the new threshold everywhere.
export const LAND_COVER_MIN_ACRES = 10;

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

/**
 * Coerce a `_landCover` stamp to an object. MapLibre serialises nested
 * feature properties to JSON strings when read back from rendered features
 * (the popup path), so the stamp arrives either way.
 */
export function readLandCover(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

// The two sources, keyed as headlineCover() reports them.
export const LAND_COVER_SOURCES = Object.freeze({
  aci: { label: 'Crop inventory 2021–25', short: 'ACI 21–25',
         detail: 'AAFC Annual Crop Inventory read per pixel over 2021–2025' },
  lcr: { label: 'Land Cover Register 2020', short: 'LCR 2020',
         detail: 'Statistics Canada Land Cover Register, reference year 2020' },
});

// Two sources further apart than this on any one bucket are flagged: at
// 20 pp of a quarter section they differ by 32 acres, past anything either
// classifier's accuracy supports, and the honest reading is "go look".
export const COVER_DISAGREE_MIN = 0.20;

/**
 * The largest gap between two fraction objects across the five buckets,
 * as { key, label, diff } with diff in 0..1 — or null unless both exist.
 */
export function coverDisagreement(a, b) {
  if (!a || !b) return null;
  let worst = null;
  for (const bk of LAND_COVER_BUCKETS) {
    const va = Number(a[bk.key]) || 0; const vb = Number(b[bk.key]) || 0;
    const diff = Math.abs(va - vb);
    if (!worst || diff > worst.diff) worst = { key: bk.key, label: bk.label, diff };
  }
  return worst;
}

/**
 * Which fractions a parcel shows as its land cover, from its two stamps.
 * Returns null when neither is usable, else
 *   { lc, source, other, disagreement, flagged }
 * where `lc` is the headline fraction object, `source` 'aci' | 'lcr',
 * `other` the cross-check fractions (null without one), `disagreement` from
 * coverDisagreement() and `flagged` whether it clears COVER_DISAGREE_MIN.
 * `acres` gates the register the way its shards were built (over
 * LAND_COVER_MIN_ACRES); an unknown acreage (a fabric feature carries none)
 * does not gate, since the shard itself was built above the line. The mix
 * carries its own gate in the builder.
 */
export function headlineCover(landfacts, landCover, acres) {
  const mix = landMix(readLandfacts(landfacts));
  const lcrAllowed = acres == null || acres === '' || Number(acres) > LAND_COVER_MIN_ACRES;
  const lcr = lcrAllowed ? readLandCover(landCover) : null;
  const lcrOk = lcr && cultFraction(lcr) != null ? lcr : null;
  if (!mix && !lcrOk) return null;
  const lc = mix || lcrOk;
  const other = mix ? lcrOk : null;
  const disagreement = coverDisagreement(lc, other);
  return {
    lc, source: mix ? 'aci' : 'lcr', other, disagreement,
    flagged: !!disagreement && disagreement.diff >= COVER_DISAGREE_MIN,
  };
}
