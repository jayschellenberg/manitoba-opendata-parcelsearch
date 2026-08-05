/*
 * Parcel acreage resolution.
 *
 * The app trusts the assessor's recorded area (Roll_Entry Frontage_or_Area,
 * e.g. "5.000 Acres") over a geometry-derived figure — it's the official
 * value. BUT a small set of parcels (crown / reserve land, e.g.
 * "INDIGENOUS & NORTHERN RELATIONS") carry a NOMINAL placeholder area like
 * "0.01 Acres" on a polygon that is actually hundreds of acres. Blindly
 * preferring the roll there would display 0.01 ac for a 357-ac parcel.
 *
 * resolveParcelAcres() applies a sanity guard: when the roll area is
 * implausibly tiny relative to the geometry area (and the geometry is
 * materially large), it falls back to the geometry figure and flags the
 * parcel so the UI/export can surface "roll area looks nominal".
 *
 * It also cross-checks the two figures against each other whenever both
 * exist. Agreement is the normal case; a divergence past AREA_VARIANCE_PCT
 * means the assessor's recorded area and its own polygon disagree, which is
 * what a pending subdivision or consolidation looks like from the outside.
 * That gets flagged too (areaMismatch) so the number can be confirmed before
 * it reaches a report.
 *
 * Geometry area itself is computed by the caller via @turf/area (geodesic,
 * authalic-radius spherical-excess) — already accurate to <0.0001% of the
 * true ellipsoidal area; this module only decides WHICH figure to trust.
 *
 * Pure + dependency-free so it unit-tests without turf or the DOM.
 */

// Roll area is "nominal" when it's <= this fraction of the geometry area …
export const ROLL_NOMINAL_RATIO = 0.1;        // roll < 10% of geometry
// … AND the geometry is at least this big (acres). The floor avoids flipping
// tiny urban lots where ~10 m geometry noise can dwarf a small true area.
export const ROLL_NOMINAL_MIN_GEOM_ACRES = 5;

// A genuine assessor area and its own polygon should agree closely. Past this
// divergence the two halves of the provincial record disagree with each other,
// and the displayed figure shouldn't go into a report unchecked.
//
// TUNING — measured over 36,678 cross-checkable parcels across 31 sampled
// municipalities (2026-08-05, against the 2026-08-04 roll):
//
//     > 2%   18.4% of parcels        > 25%   2.4%
//     > 5%    8.8%                   > 50%   1.6%
//     >10%    5.1%                   >100%   0.7%
//
// 2% is deliberate but noisy: at that setting nearly one row in five carries
// the marker, and most of those are ordinary survey-vs-digitized-boundary
// differences of a few percent, not real change. It is set low on purpose —
// the cost of a spurious ⚠ is a glance, the cost of a missed one is a wrong
// area in a report. Raise it here if the noise gets in the way; the numbers
// above say what you would be trading. Anything past ~100% is almost always a
// genuine subdivision or consolidation rather than survey drift.
//
// NOTE ON WHAT THIS DOES *NOT* CATCH: when the province re-publishes the roll
// with BOTH the attribute and the polygon still pre-subdivision, the two agree
// with each other and nothing here fires. Confirmed 2026-08-05 on RM of Ste
// Anne roll 126910 — MAO's map showed the subdivided ±2.3 ac parcel while
// ROLL_ENTRY still carried 17.22 ac against a 16.97 ac polygon (1.5% apart).
// Upstream lag of that kind is only visible via the layer's edit date, not
// from an internal cross-check. See lib/staleness.js upstreamLag().
export const AREA_VARIANCE_PCT = 0.02;        // 2%

const pos = (v) => v != null && Number.isFinite(v) && v > 0;

/**
 * The assessment roll's own size figure, tidied for display but not converted.
 *
 * ROLL_ENTRY's Frontage_or_Area is a hybrid: about 63% of Manitoba parcels
 * state an area ("160.00 ACRES") and the other 37% state a frontage
 * ("110.00 FEET"), which is a width and carries no area information at all.
 * The app used to read this field only to derive acres, which meant the
 * frontage cohort's sole assessor-stated size silently became a polygon
 * estimate that no column identified as such. Showing the raw string keeps the
 * primary source on the row.
 *
 * Units are lower-cased ("160.00 acres") purely so a column of them doesn't
 * shout. The number is left exactly as the roll states it, trailing zeros and
 * all, because it is a quoted figure and rounding it would misrepresent the
 * source.
 *
 * @param {string|null} raw  Frontage_or_Area as the service returns it.
 * @returns {string} display string, or '' when there is nothing to show.
 */
export function formatRollSizeField(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  // Some service configurations stringify null as the literal '<Null>'.
  if (!s || s === '<Null>') return '';
  return s.replace(/\b(ACRES?|FEET|FT|HECTARES?|HA)\b/gi, (u) => u.toLowerCase());
}

/**
 * Decide the acreage to use for a parcel.
 *
 * @param {number|null} rollAcres  assessor area parsed from Frontage_or_Area (acres), or null.
 * @param {number|null} geomAcres  geometry-derived area (acres), or null.
 * @returns {{acres:number|null, source:'assessor'|'geometry'|null, rollNominal:boolean,
 *            rollValue:number|null, geomValue:number|null, variancePct:number|null,
 *            areaMismatch:boolean}}
 *   variancePct  |roll - geom| / geom, as a fraction — the polygon is the
 *                independent measurement, so it is the denominator. Null when
 *                only one figure exists, or when the nominal guard already
 *                explains the gap (no point flagging it twice).
 *   areaMismatch true when we are DISPLAYING the assessor figure and the
 *                polygon disagrees by more than AREA_VARIANCE_PCT.
 */
export function resolveParcelAcres(rollAcres, geomAcres) {
  const hasRoll = pos(rollAcres);
  const hasGeom = pos(geomAcres);
  const geomValue = hasGeom ? geomAcres : null;

  // Nominal-roll guard: a real assessor area should be in the same ballpark
  // as the polygon. When it's an order of magnitude smaller on a sizable
  // parcel, treat the roll as a placeholder and use the geometry instead.
  // rollNominal already tells the whole story here, so variance stays null
  // rather than reporting a meaningless ~100% against a placeholder.
  if (hasRoll && hasGeom &&
      geomAcres >= ROLL_NOMINAL_MIN_GEOM_ACRES &&
      rollAcres <= geomAcres * ROLL_NOMINAL_RATIO) {
    return {
      acres: geomAcres, source: 'geometry', rollNominal: true, rollValue: rollAcres,
      geomValue, variancePct: null, areaMismatch: false,
    };
  }
  if (hasRoll) {
    // Cross-check the figure we're about to show against the polygon it came
    // with. Disagreement doesn't tell us which side is wrong — only that one
    // of them has moved and the number needs confirming before it's relied on.
    const variancePct = hasGeom ? Math.abs(rollAcres - geomAcres) / geomAcres : null;
    return {
      acres: rollAcres, source: 'assessor', rollNominal: false, rollValue: rollAcres,
      geomValue, variancePct,
      areaMismatch: variancePct != null && variancePct > AREA_VARIANCE_PCT,
    };
  }
  if (hasGeom) {
    return {
      acres: geomAcres, source: 'geometry', rollNominal: false, rollValue: null,
      geomValue, variancePct: null, areaMismatch: false,
    };
  }
  return {
    acres: null, source: null, rollNominal: false, rollValue: null,
    geomValue: null, variancePct: null, areaMismatch: false,
  };
}
