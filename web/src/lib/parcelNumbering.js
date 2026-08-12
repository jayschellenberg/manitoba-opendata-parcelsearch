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
 * Where this parcel's roll sat in a typed Roll # list. `rollOrder` is a
 * `Map<Roll_No_Txt, position>` built by the caller from what the user
 * actually typed; rolls not in it (or no map at all) return +Infinity so
 * they fall past the entered ones and sort among themselves by the normal
 * rule.
 */
export function enteredOrderValue(props, rollOrder) {
  if (!rollOrder) return Infinity;
  const pos = rollOrder.get(String(props?.Roll_No_Txt ?? ''));
  return Number.isFinite(pos) ? pos : Infinity;
}

/**
 * Return the features ordered by (municipality name, roll numeric),
 * with the raw roll string and original index as stable tie-breakers.
 * Does not mutate the input array or the features. Features without
 * `.properties` are dropped.
 *
 * Pass `rollOrder` (see enteredOrderValue) to order by the sequence the
 * rolls were TYPED instead. Two rolls entered as "154350, 154345" then
 * number 1 and 2 in that order, rather than 154345 first as the numeric
 * sort would have it — when you type a comp list you are usually typing
 * it in the order you mean to present it. Rolls the list doesn't name
 * still fall back to muni-then-roll, after the entered ones.
 */
export function orderForNumbering(features, rollOrder = null) {
  return (features || [])
    .filter((f) => f && f.properties)
    .map((f, idx) => ({
      f,
      idx,
      entered: enteredOrderValue(f.properties, rollOrder),
      muni: muniCodeValue(f.properties),
      roll: rollNumericValue(f.properties),
      rollStr: String(f.properties.Roll_No_Txt ?? ''),
    }))
    .sort((a, b) => {
      if (a.entered !== b.entered) return a.entered - b.entered;
      if (a.muni !== b.muni) return a.muni - b.muni;
      if (a.roll !== b.roll) return a.roll - b.roll;
      if (a.rollStr < b.rollStr) return -1;
      if (a.rollStr > b.rollStr) return 1;
      return a.idx - b.idx;
    })
    .map((e) => e.f);
}

/**
 * A caller-supplied Site / Comp label carried in from a parcel-list
 * import (stamped as `_siteNo` on the feature). Trimmed; empty → null.
 */
export function siteValue(props) {
  const raw = props?._siteNo;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/**
 * Group identity — parcels that are one subject rather than several.
 * Stamped as `_saleGroupId` by all three paths that can produce one: a
 * multi-parcel sale in a CSV upload, a multi-roll row in a parcel-list
 * import, and rolls joined with `+` / `|` in the Roll # field.
 */
export function groupValue(props) {
  const raw = props?._saleGroupId;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/**
 * Assign each feature's `_seq` — the number shown on the map badge and
 * in the grid "#" column.
 *
 * If ANY feature carries a Site value (a "Site"/"Comp #" column from a
 * parcel-list import), Site wins: each parcel's `_seq` is its own Site
 * value verbatim (parsed to a number when it's numeric, so the grid
 * sorts and the badge sizes correctly; kept as a string otherwise).
 * Parcels in the set without a Site value get no number.
 *
 * Otherwise it falls back to the computed sequence: 1..N in
 * municipality-code-then-Roll# order, counting by SUBJECT rather than by
 * parcel — every member of a group (see groupValue) shares one number, and
 * the count advances once for the group. A six-roll holding is one comp on
 * the map and should carry one badge, not six consecutive ones.
 *
 * `opts.rollOrder` swaps that muni-then-roll sort for the order the rolls
 * were typed — see orderForNumbering. It only reorders; the group counting
 * and the Site override are unchanged.
 *
 * Mutates the features and returns them (in assigned order for the
 * computed case; input order for the Site case).
 */
export function assignParcelSeq(features, { rollOrder = null } = {}) {
  const list = (features || []).filter((f) => f && f.properties);
  const anySite = list.some((f) => siteValue(f.properties) != null);
  if (anySite) {
    for (const f of list) {
      const s = siteValue(f.properties);
      if (s == null) { f.properties._seq = null; continue; }
      // Numeric Site → a number (so it sorts and sizes like the auto
      // sequence). Non-numeric label (e.g. "A") → keep the string.
      f.properties._seq = /^\d+(\.\d+)?$/.test(s) ? Number(s) : s;
    }
    return list;
  }
  const ordered = orderForNumbering(list, rollOrder);
  const numberByGroup = new Map();
  let next = 1;
  for (const f of ordered) {
    const gid = groupValue(f.properties);
    if (gid == null) {
      f.properties._seq = next++;
      continue;
    }
    if (!numberByGroup.has(gid)) numberByGroup.set(gid, next++);
    f.properties._seq = numberByGroup.get(gid);
  }
  return ordered;
}

/** Remove any previously-stamped `_seq` (used when a result set drops
 *  back to a single parcel, so a stray "1" badge never lingers). */
export function clearParcelSeq(features) {
  for (const f of features || []) {
    if (f && f.properties && '_seq' in f.properties) delete f.properties._seq;
  }
}
