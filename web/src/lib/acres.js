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

const pos = (v) => v != null && Number.isFinite(v) && v > 0;

/**
 * Decide the acreage to use for a parcel.
 *
 * @param {number|null} rollAcres  assessor area parsed from Frontage_or_Area (acres), or null.
 * @param {number|null} geomAcres  geometry-derived area (acres), or null.
 * @returns {{acres:number|null, source:'assessor'|'geometry'|null, rollNominal:boolean, rollValue:number|null}}
 */
export function resolveParcelAcres(rollAcres, geomAcres) {
  const hasRoll = pos(rollAcres);
  const hasGeom = pos(geomAcres);

  // Nominal-roll guard: a real assessor area should be in the same ballpark
  // as the polygon. When it's an order of magnitude smaller on a sizable
  // parcel, treat the roll as a placeholder and use the geometry instead.
  if (hasRoll && hasGeom &&
      geomAcres >= ROLL_NOMINAL_MIN_GEOM_ACRES &&
      rollAcres <= geomAcres * ROLL_NOMINAL_RATIO) {
    return { acres: geomAcres, source: 'geometry', rollNominal: true, rollValue: rollAcres };
  }
  if (hasRoll) return { acres: rollAcres, source: 'assessor', rollNominal: false, rollValue: rollAcres };
  if (hasGeom) return { acres: geomAcres, source: 'geometry', rollNominal: false, rollValue: null };
  return { acres: null, source: null, rollNominal: false, rollValue: null };
}
