/*
 * The standing multi-family inventory — every qualifying roll, new or not,
 * pre-baked per municipality by r/build_mf_newbuild.R into
 * mb-parcel-data/mf-inventory/.
 *
 * WHAT A STAMP HOLDS. main.js sets `_mfInv` on each parcel from the shard:
 *
 *   { du: 24, cl: 'R2', ad: '2200 PACIFIC AVE' }
 *
 * WHY IT SHIPS FROM THE NEW-BUILD SCRIPT. It is the same universe — the
 * multi-family set before any event detection — so MIN_DU and the farm
 * exclusion are defined once. "Existing multi-family" and "new multi-family"
 * have to describe the same population at different times, or comparing the
 * two layers means nothing.
 *
 * WHY IT IS A SHARD AT ALL, when `Dwelling_Units` already rides on every
 * parcel from PARCEL_OUTFIELDS: the shard is what carries the COLONY
 * EXCLUSION. Filtering the fabric on Dwelling_Units alone would light up
 * 1,222 Hutterite colony rolls at 20-35 units each, which are multi-family in
 * the arithmetic sense and useless as multi-family comparables. Membership of
 * this shard is the definition; the dwelling-unit threshold in the UI narrows
 * it from there.
 *
 * COLOURS ARE NEW MULTI-FAMILY'S UNIT RAMP, imported rather than restated.
 * The two layers are read against each other constantly — "what is here" then
 * "what is new" — and a 24-unit building must not change colour between them.
 *
 * NO COLUMN OF ITS OWN. The grid already has a DU column fed straight from
 * the parcel record, and a second column repeating it would be noise. This
 * layer paints the map and fills the grid; the existing columns describe it.
 */

import { UNITS_RAMP } from './mfNewbuild.js';

// KEEP IN SYNC with MIN_DU in r/build_mf_newbuild.R. This is the shard's
// FLOOR, not the UI's threshold: the user can raise the bar but never lower
// it past what was published.
export const MFINV_MIN_DU = 3;

/** Default for the "dwelling units at least" control. */
export const MFINV_DEFAULT_MIN = MFINV_MIN_DU;

export function readMfInv(v) {
  if (!v || typeof v !== 'object') return null;
  if (!Number.isFinite(Number(v.du))) return null;
  return v;
}

/** Colour by unit count, on New Multi-Family's ramp. */
export function mfInvFillColor(v) {
  const r = readMfInv(v);
  if (!r) return null;
  const du = Number(r.du);
  for (const step of UNITS_RAMP) if (du <= step.max) return step.color;
  return UNITS_RAMP[UNITS_RAMP.length - 1].color;
}

/** Does this roll clear the user's threshold? A stamp below it is not
 *  painted — it is still in the shard, just not in this view. */
export function mfInvPasses(v, minDu) {
  const r = readMfInv(v);
  if (!r) return false;
  const floor = Number.isFinite(Number(minDu)) ? Number(minDu) : MFINV_MIN_DU;
  return Number(r.du) >= floor;
}

export function mfInvTooltip(v) {
  const r = readMfInv(v);
  if (!r) return '';
  const lines = [`${r.du} dwelling unit${Number(r.du) === 1 ? '' : 's'}`];
  if (r.cl) lines.push(`Class ${r.cl}`);
  if (r.ad) lines.push(r.ad);
  lines.push('Current count from the assessment roll. Colonies are excluded.');
  return lines.join('\n');
}

/** Legend rows — the same unit bands the New Multi-Family "Units" view uses,
 *  with the bands entirely below the active threshold dropped, since nothing
 *  in them can be on screen. */
export function mfInvLegendSteps(minDu) {
  const floor = Number.isFinite(Number(minDu)) ? Number(minDu) : MFINV_MIN_DU;
  return UNITS_RAMP
    .filter((s) => s.max >= floor)
    .map((s) => ({ color: s.color, label: s.label }));
}

/** Sanitise the threshold input. Anything unparseable, or below the shard's
 *  own floor, falls back to that floor — the UI must never imply it is
 *  showing 1- and 2-unit rolls that were never published. */
export function clampMinDu(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return MFINV_MIN_DU;
  return Math.max(MFINV_MIN_DU, Math.min(9999, n));
}
