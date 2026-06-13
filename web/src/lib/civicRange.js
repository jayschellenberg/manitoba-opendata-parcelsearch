// Civic-number range filtering for the address search. Manitoba has no
// province-wide civic-address dataset, so the app post-filters the live
// Property_Address text client-side. These map an address (and the
// user's From/To bounds) to a sortable integer key where a letter
// suffix sorts between consecutive integers (100 < 100A < 100B < 101).
// Pure logic — extracted from main.js for isolated testing.

/**
 * Parse a civic-address string into a sortable integer key.
 *   "444 1ST ST"     -> 44400
 *   "100A MAIN ST"   -> 10001  (A = +1)
 *   "100B MAIN ST"   -> 10002
 *   "60158 ROAD 96W" -> 6015800
 *   "DESC NE22-21-3E" -> null
 *   "NE1-1-3E"        -> null
 * Requires a civic number (optionally one letter suffix) followed by
 * whitespace. Letter index A=1..Z=26, leaving 0 for "no suffix" so a
 * bare number sorts BEFORE any of its letter-suffixed variants.
 */
export function parseCivicAddressKey(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d+)([A-Za-z]?)\s/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const letter = m[2] ? m[2].toUpperCase().charCodeAt(0) - 64 : 0;
  return num * 100 + letter;
}

/**
 * Parse a From/To bound into a comparison key. The asymmetry matches
 * user expectations:
 *   from "100" (no letter) -> 100*100 + 0   so 100 itself is included
 *   to   "100" (no letter) -> 100*100 + 99  so any 100x suffix included
 *   from "100A" / to "100A" -> exact         (100*100 + 1)
 * Returns null on empty/garbage input.
 */
export function parseCivicBound(raw, kind) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+)([A-Za-z]?)$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const letter = m[2] ? m[2].toUpperCase().charCodeAt(0) - 64 : null;
  if (letter != null) return num * 100 + letter;
  // No letter typed: lower bound includes the bare number; upper bound
  // extends across every letter-suffixed variant of that number.
  return kind === 'upper' ? num * 100 + 99 : num * 100;
}

/**
 * Filter a FeatureCollection in place to features whose Property_Address
 * leads with a civic number in [from, to]. A blank `from` means no lower
 * bound; blank `to` means no upper bound; both blank passes the FC
 * through untouched. When a range IS set, records that don't begin with
 * a civic number (legal descriptions stuffed into Property_Address, junk
 * reference codes) are dropped.
 */
export function applyCivicNumberRange(fc, fromRaw, toRaw) {
  const from = parseCivicBound(fromRaw, 'lower');
  const to   = parseCivicBound(toRaw,   'upper');
  if (from == null && to == null) return;
  const features = fc?.features || [];
  const kept = [];
  for (const f of features) {
    const k = parseCivicAddressKey(f?.properties?.Property_Address);
    if (k == null) continue;                   // no civic number → drop when range set
    if (from != null && k < from) continue;
    if (to   != null && k > to)   continue;
    kept.push(f);
  }
  fc.features = kept;
}
