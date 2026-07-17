/*
 * Parcel numbering — the stable 1..N sequence stamped onto a multi-parcel
 * result set so the map callouts and the results-table "#" column agree.
 *
 * The ordering the user asked for: municipality FIRST (by MAO muni code,
 * the numeric prefix on the Municipality field), then Roll # as a NUMBER
 * (so 90 sorts before 100, not after it as a plain string sort would).
 * The number is a fixed identity — once
 * assigned it stays glued to that parcel regardless of how the table is
 * later re-sorted or filtered — so this runs once per new result set, not
 * on every re-render.
 *
 * Pure (no DOM / no map) so it can be unit-tested in node; main.js owns
 * the "when" (which result sets get numbered) and map.js owns the "where"
 * (drawing the callouts).
 */

/**
 * Municipality sort key — the MAO muni code (the integer prefix on the
 * Municipality field, e.g. 600 for "600 - RM OF HEADINGLEY"). Numeric so
 * the numbering groups munis by their authority code, matching the
 * Muni # column. Munis without a parseable code sort last (+Infinity).
 */
export function muniCodeValue(props) {
  const m = String(props?.Municipality ?? '').match(/^\s*(\d+)\s*-/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return Infinity;
}

/**
 * Roll # as a number. Roll_No_Txt is "<digits>.<3-digit-sub>" (e.g.
 * "123456.010"); parseFloat keeps the sub-roll ordering ("…​.010" <
 * "…​.500") while sorting the main roll numerically. Non-numeric /
 * missing rolls sort last via +Infinity.
 */
export function rollNumericValue(props) {
  const cleaned = String(props?.Roll_No_Txt ?? '').replace(/[^0-9.]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : Infinity;
}

/**
 * Return the features ordered by (municipality name, roll numeric),
 * with the raw roll string and original index as stable tie-breakers.
 * Does not mutate the input array or the features. Features without
 * `.properties` are dropped.
 */
export function orderForNumbering(features) {
  return (features || [])
    .filter((f) => f && f.properties)
    .map((f, idx) => ({
      f,
      idx,
      muni: muniCodeValue(f.properties),
      roll: rollNumericValue(f.properties),
      rollStr: String(f.properties.Roll_No_Txt ?? ''),
    }))
    .sort((a, b) => {
      if (a.muni !== b.muni) return a.muni - b.muni;
      if (a.roll !== b.roll) return a.roll - b.roll;
      if (a.rollStr < b.rollStr) return -1;
      if (a.rollStr > b.rollStr) return 1;
      return a.idx - b.idx;
    })
    .map((e) => e.f);
}

/**
 * Assign a 1-based `_seq` to each feature's properties, in
 * municipality-then-roll order. Mutates the features (stamps
 * `properties._seq`) and returns them in assigned order.
 */
export function assignParcelSeq(features) {
  const ordered = orderForNumbering(features);
  ordered.forEach((f, i) => { f.properties._seq = i + 1; });
  return ordered;
}

/** Remove any previously-stamped `_seq` (used when a result set drops
 *  back to a single parcel, so a stray "1" badge never lingers). */
export function clearParcelSeq(features) {
  for (const f of features || []) {
    if (f && f.properties && '_seq' in f.properties) delete f.properties._seq;
  }
}
