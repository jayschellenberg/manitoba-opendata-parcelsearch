/*
 * Historical → current parcel size-change classification.
 *
 * For the Historical overlay: match each historical-snapshot parcel to the
 * current parcel with the same roll (within the same muni — roll numbers are
 * only unique per municipality) and classify how much its area changed. The
 * map colours changed parcels and the popup shows old→new acres.
 *
 * IMPORTANT (surfaced in the popup): a size change can be a real subdivision /
 * consolidation, OR a re-survey / geometry correction, OR — for frontage-only
 * parcels where we fall back to the simplified (~2-3 m) historical display
 * geometry — a simplification artifact. It is a pointer to investigate, not
 * proof. Where both snapshots carry an assessor AREA the delta is roll-vs-roll
 * and immune to simplification; that is the high-confidence case.
 *
 * Pure + dependency-free — acreage is computed by the caller (parcelAcres) and
 * passed in as roll→acres maps, so this unit-tests without turf or the DOM.
 */

export const SIZE_MINOR_PCT = 5;    // |Δ| >  5%  → minor change
export const SIZE_MAJOR_PCT = 25;   // |Δ| > 25%  → material change

/** Band for a signed percent delta. */
export function sizeBand(deltaPct) {
  if (deltaPct == null || !Number.isFinite(deltaPct)) return 'unknown';
  const a = Math.abs(deltaPct);
  if (a > SIZE_MAJOR_PCT) return 'major';
  if (a > SIZE_MINOR_PCT) return 'minor';
  return 'same';
}

/**
 * Classify size changes between two roll→acres maps.
 *
 * @param {Map<string,number>} histByRoll  historical roll → acres
 * @param {Map<string,number>} curByRoll   current   roll → acres
 * @returns {{ byRoll: Map<string,{histAcres,curAcres,deltaPct,band}>,
 *             summary: {same,minor,major,gone,appeared,unknown} }}
 *   `band` is one of 'same' | 'minor' | 'major' | 'gone' | 'unknown'.
 *   'gone'     = roll present historically but not now (removed/merged away).
 *   'appeared' = roll present now but not historically (counted in summary only).
 */
export function computeSizeChanges(histByRoll, curByRoll) {
  const byRoll = new Map();
  const summary = { same: 0, minor: 0, major: 0, gone: 0, appeared: 0, unknown: 0 };

  for (const [roll, h] of histByRoll) {
    const c = curByRoll.get(roll);
    if (c == null) {
      byRoll.set(roll, { histAcres: h, curAcres: null, deltaPct: null, band: 'gone' });
      summary.gone++;
      continue;
    }
    if (!(h > 0) || !(c > 0)) {
      byRoll.set(roll, { histAcres: h, curAcres: c, deltaPct: null, band: 'unknown' });
      summary.unknown++;
      continue;
    }
    const deltaPct = ((c - h) / h) * 100;
    const band = sizeBand(deltaPct);
    byRoll.set(roll, { histAcres: h, curAcres: c, deltaPct, band });
    summary[band]++;
  }

  for (const roll of curByRoll.keys()) if (!histByRoll.has(roll)) summary.appeared++;

  return { byRoll, summary };
}
