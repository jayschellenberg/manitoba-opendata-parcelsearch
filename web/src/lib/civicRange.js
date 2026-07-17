// Civic-number handling for the address search. Manitoba has no
// province-wide civic-address dataset, so the app works off the live
// Property_Address text: the street name narrows the SQL fetch, and the
// From/To boxes decide client-side. Two jobs live here.
//
// 1. What the boxes mean. civicSearchMode reads the pair — one box is a
//    contains, two equal ones are exact, two different ones are a range
//    — and the range/exact modes key an address to a sortable integer
//    where a letter suffix sorts between consecutive integers
//    (100 < 100A < 100B < 101).
//
// 2. The internal space. Several RMs store the rural grid number split
//    at the thousands mark — Rosser roll 76250 is "1 106 E ROAD 71 N",
//    i.e. civic 1106, and "64 158 ROAD 2 W" is 64158. Others write the
//    same kind of address closed up ("2079 W ROAD 65 N", "60158 ROAD
//    96W"). Both the range filter and the street substring search have
//    to see through that space, in both directions.
//
// Pure logic — extracted from main.js for isolated testing.

/** Remove whitespace sitting between two digits: "1 106" -> "1106".
 *  Loops because a single pass can't rewrite overlapping matches
 *  ("1 1 1"). Spaces next to a letter are left alone, so "100 MAIN"
 *  survives intact. */
function collapseCivicSpaces(raw) {
  let out = String(raw);
  let prev;
  do {
    prev = out;
    out = out.replace(/(\d)\s+(\d)/g, '$1$2');
  } while (out !== prev);
  return out;
}

/** Insert the thousands space MAO uses: "1106" -> "1 106", "64158" ->
 *  "64 158". Only runs of four or more digits regroup — three or fewer
 *  is a plain street number or road number and stays as typed. */
function groupCivicDigits(raw) {
  return String(raw).replace(/\d{4,}/g, (run) => run.replace(/\B(?=(\d{3})+$)/g, ' '));
}

function civicKey(digits, letterRaw) {
  const num = Number(digits);
  if (!Number.isFinite(num)) return null;
  // Letter index A=1..Z=26, leaving 0 for "no suffix" so a bare number
  // sorts BEFORE any of its letter-suffixed variants.
  const letter = letterRaw ? letterRaw.toUpperCase().charCodeAt(0) - 64 : 0;
  return num * 100 + letter;
}

// The civic number as written with no internal space, which is most of
// the province: leading digits, at most one letter suffix, then
// whitespace. "444 1ST ST", "100A MAIN ST", "60158 ROAD 96W".
const RE_CIVIC_PLAIN = /^(\d+)([A-Za-z]?)\s/;
// The split form: a 1-3 digit head, one or more 3-digit groups, then an
// optional direction letter that may or may not be closed up against the
// number. "1 106 E ROAD 71 N" -> 1106 E, "9 089E ROAD 78 N" -> 9089 E,
// "68 016 1 RD W" -> 68016 (the trailing "1" is the road, not a group —
// it isn't three digits).
const RE_CIVIC_GROUPED = /^(\d{1,3})((?:\s+\d{3})+)\s*([A-Za-z]?)(?=\s|$)/;

/**
 * Parse a civic-address string into a sortable integer key, reading the
 * number as written with no internal space.
 *   "444 1ST ST"     -> 44400
 *   "100A MAIN ST"   -> 10001  (A = +1)
 *   "100B MAIN ST"   -> 10002
 *   "60158 ROAD 96W" -> 6015800
 *   "DESC NE22-21-3E" -> null
 *   "NE1-1-3E"        -> null
 * Requires a civic number (optionally one letter suffix) followed by
 * whitespace. For addresses that split the number at the thousands mark
 * this returns only the leading group ("1 106 E ROAD 71 N" -> 100); see
 * parseCivicAddressKeys for the reading that recognizes the split.
 */
export function parseCivicAddressKey(raw) {
  if (!raw) return null;
  const m = String(raw).match(RE_CIVIC_PLAIN);
  if (!m) return null;
  return civicKey(m[1], m[2]);
}

/**
 * Every plausible civic-number key for an address, closed-up reading
 * first. Returns [] when the text carries no civic number at all
 * (quarter-section descriptions, legal references).
 *   "444 1ST ST"          -> [44400]
 *   "1 106 E ROAD 71 N"   -> [100, 110605]     civic 1 or civic 1106E
 *   "32 502 RD"           -> [3200, 3250200]   civic 32 or civic 32502
 *
 * Two readings because the space is genuinely ambiguous and the string
 * alone can't settle it. "1 106 E ROAD 71 N" (Rosser) is civic 1106,
 * but "32 502 RD" (Lac du Bonnet) is civic 32 on road 502 and "146 100
 * RTE" (Morden) is civic 146 on Route 100 — same shape, opposite
 * readings. It isn't even municipality-wide: Macdonald carries both
 * styles ("5 008 ROAD 39NW" split, "96 247 RTE E" not). So rather than
 * guess and be silently wrong, hand both readings to the caller.
 */
export function parseCivicAddressKeys(raw) {
  if (!raw) return [];
  const s = String(raw);
  const keys = [];
  const plain = parseCivicAddressKey(s);
  if (plain != null) keys.push(plain);
  const g = s.match(RE_CIVIC_GROUPED);
  if (g) {
    const joined = civicKey(g[1] + g[2].replace(/\s+/g, ''), g[3]);
    if (joined != null && !keys.includes(joined)) keys.push(joined);
  }
  return keys;
}

/**
 * Parse a From/To bound into a comparison key. The asymmetry matches
 * user expectations:
 *   from "100" (no letter) -> 100*100 + 0   so 100 itself is included
 *   to   "100" (no letter) -> 100*100 + 99  so any 100x suffix included
 *   from "100A" / to "100A" -> exact         (100*100 + 1)
 * A bound may be typed with the internal space ("1 106"), so it can be
 * pasted straight out of a Property_Address. Returns null on
 * empty/garbage input.
 */
export function parseCivicBound(raw, kind) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = collapseCivicSpaces(s).match(/^(\d+)([A-Za-z]?)$/);
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
 * Expand a street-name search term into the forms the data might store:
 * the term as typed, plus the space-collapsed ("1 106" -> "1106") and
 * thousands-grouped ("1106" -> "1 106") forms when they differ. Callers
 * match with OR, so the extra forms only ever add hits — no reading has
 * to win. Upper-cased and whitespace-collapsed to match how both the
 * SQL clause and the client-side filters compare.
 */
export function addressSearchVariants(raw) {
  const base = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!base) return [];
  const out = [base];
  for (const v of [collapseCivicSpaces(base), groupCivicDigits(base)]) {
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** True when `address` contains any of `variants` (as built by
 *  addressSearchVariants). Shared by every client-side street filter so
 *  they agree with the SQL clause buildParcelClauses emits. */
export function addressMatchesVariants(address, variants) {
  if (!variants || variants.length === 0) return true;
  const addr = String(address || '').toUpperCase();
  return variants.some((v) => addr.includes(v));
}

/**
 * Classify what a From/To pair is asking for. The two boxes are one
 * control, and how many of them are filled says which question the user
 * means:
 *   both blank          -> 'none'      no civic filter at all
 *   one box filled      -> 'contains'  substring, e.g. 1106 finds
 *                                      "1 106 E ROAD 71 N"
 *   both filled, equal  -> 'exact'     that number only (To auto-fills
 *                                      from From, so this is the common
 *                                      path)
 *   both filled, differ -> 'range'     From..To inclusive
 *
 * A lone box is a contains rather than an open-ended bound: "everything
 * numbered 1106 and up" is not a question anyone asks of an address,
 * while "find me 1106, however it's written" is the whole point.
 * `term` carries the typed text for the two text-matching modes.
 */
export function civicSearchMode(fromRaw, toRaw) {
  const from = String(fromRaw || '').trim();
  const to   = String(toRaw   || '').trim();
  if (!from && !to)  return { mode: 'none',     term: '' };
  if (!from || !to)  return { mode: 'contains', term: from || to };
  const a = parseCivicBound(from, 'lower');
  const b = parseCivicBound(to,   'lower');
  // Compared canonically, so "1 106" and "1106" are the same bound.
  // Unparseable on either side falls to 'range', which no-ops below —
  // the same nothing-happens the boxes have always done with junk.
  if (a != null && a === b) return { mode: 'exact', term: from };
  return { mode: 'range', term: '' };
}

/**
 * Filter a FeatureCollection in place by the civic-number boxes, per
 * civicSearchMode:
 *   'contains' — plain substring against Property_Address, across the
 *                spacing variants. No civic number required, so it reads
 *                the same as the Street Name box.
 *   'exact' /
 *   'range'    — key the address and keep it when it lands in
 *                [from, to]. Records that don't begin with a civic
 *                number (legal descriptions stuffed into
 *                Property_Address, junk reference codes) are dropped.
 *   'none'     — the FC passes through untouched.
 *
 * A split-number address is kept when EITHER reading lands in range (see
 * parseCivicAddressKeys). An exact search stays precise either way; a
 * wide range errs toward showing the parcel rather than hiding it.
 */
export function applyCivicNumberFilter(fc, fromRaw, toRaw) {
  const { mode, term } = civicSearchMode(fromRaw, toRaw);
  if (mode === 'none') return;
  const features = fc?.features || [];

  if (mode === 'contains') {
    const variants = addressSearchVariants(term);
    if (variants.length === 0) return;
    fc.features = features.filter(
      (f) => addressMatchesVariants(f?.properties?.Property_Address, variants),
    );
    return;
  }

  const from = parseCivicBound(fromRaw, 'lower');
  const to   = parseCivicBound(toRaw,   'upper');
  if (from == null && to == null) return;
  const kept = [];
  for (const f of features) {
    const keys = parseCivicAddressKeys(f?.properties?.Property_Address);
    if (keys.length === 0) continue;            // no civic number → drop when range set
    const hit = keys.some((k) => (from == null || k >= from) && (to == null || k <= to));
    if (hit) kept.push(f);
  }
  fc.features = kept;
}
