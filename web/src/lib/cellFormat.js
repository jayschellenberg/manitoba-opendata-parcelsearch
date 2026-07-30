// Pure cell/value formatters extracted from main.js's results-table
// rendering. Each maps parcel properties (or a raw field) to a display
// value — no DOM, no module state — so the renderTable monolith keeps
// only the DOM assembly and these stay independently testable.

/**
 * Normalize a raw field to a real string or null. Manitoba's services
 * stringify nulls inconsistently — `null`, '', a lone '<Null>', or the
 * literal text 'null' all mean "no value". Returns the trimmed string
 * when there's real content, otherwise null. This is the app's core
 * sentinel filter; many table cells gate on it.
 */
export function realStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '<Null>' || s.toLowerCase() === 'null') return null;
  return s;
}

/**
 * Brief legal description for the Legal column. Prefers the full
 * `_legalDescription`; falls back to a "L x · B y · P z" lot/block/plan
 * summary; then the raw `_legalDetail`. Null when nothing usable.
 */
export function legalDisplay(p = {}) {
  if (realStr(p._legalDescription)) return realStr(p._legalDescription);
  const parts = [];
  if (realStr(p._lot)) parts.push(`L ${realStr(p._lot)}`);
  if (realStr(p._block)) parts.push(`B ${realStr(p._block)}`);
  if (realStr(p._plan)) parts.push(`P ${realStr(p._plan)}`);
  if (parts.length) return parts.join(' · ');
  return realStr(p._legalDetail);
}

/**
 * Split a `'X / CITY; Y / CITY'` certificates_of_title string into just
 * the number tokens. Robust against extra whitespace and the
 * alphanumeric prefix-letter forms (D15630, etc.).
 */
export function parseTitleNumbers(raw) {
  const out = [];
  for (const part of String(raw || '').split(/\s*;\s*/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Take everything up to the first ' / ' (or end of string).
    const num = trimmed.split(/\s*\/\s*/)[0].trim();
    if (num) out.push(num);
  }
  return out;
}

/**
 * Dominant CLI agricultural-capability label for the parcel — from the
 * top-share soil of the stamped `_soilComposition`. Null when no Soil
 * Survey / CLI overlay has been loaded.
 */
export function dominantCliLabel(p) {
  const top = Array.isArray(p?._soilComposition) ? p._soilComposition[0] : null;
  if (!top) return null;
  return top.agriCap || top.agcapCls || null;
}

/**
 * Dominant soil association name for the parcel — SOILNAME1 of the
 * top-share soil (e.g. "Red River"). Null when no overlay loaded.
 */
export function dominantSoilTypeLabel(p) {
  const top = Array.isArray(p?._soilComposition) ? p._soilComposition[0] : null;
  if (!top) return null;
  return top.soilName || top.soilCode || null;
}

/**
 * Manitoba Soil Survey slope class (TOPO) of the parcel's dominant soil.
 *
 * Returns the RAW code ("x", "c", "$MH", …). Decoding to a range belongs
 * to map.js's decodeSoilDescriptor, which owns the domain tables — this
 * module stays free of app deps. Null when no Soil Survey / CLI overlay
 * has been loaded, or when the dominant soil carries no TOPO.
 */
export function dominantSlopeCode(p) {
  const top = Array.isArray(p?._soilComposition) ? p._soilComposition[0] : null;
  if (!top) return null;
  return top.topo || null;
}

// Slope classes in increasing steepness — the sort order the Slope column
// needs. Sorting the decoded label instead would collate by leading
// character, putting "0 – 0.5%" and ">0.5 – 2%" in arbitrary positions
// relative to each other, and the raw codes are worse still (x is the
// FLATTEST class but sorts last alphabetically).
const SLOPE_CLASS_ORDER = ['x', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

/**
 * Sort rank for a TOPO code: 0 = flattest, 9 = steepest. The non-slope
 * specials ($ML modified / $UL unclassified / $UR urban / $ZZ water /
 * $MH marsh) have no steepness so they rank after every real class, and
 * a missing code ranks after those — matching the empty-sorts-last
 * behaviour of the neighbouring CLI and Soil Type columns.
 */
export function slopeSortRank(code) {
  if (code == null || String(code).trim() === '') return SLOPE_CLASS_ORDER.length + 1;
  const i = SLOPE_CLASS_ORDER.indexOf(String(code).trim().toLowerCase());
  return i === -1 ? SLOPE_CLASS_ORDER.length : i;
}

// Numeric percent bounds per slope class, matching map.js's SOIL_TOPO_LABELS
// text. `max: null` on the open-ended top class. Kept as numbers here (not
// parsed out of the label strings) so the range arithmetic can't drift if a
// label is ever reworded.
const SLOPE_CLASS_BOUNDS = {
  x: { min: 0,   max: 0.5 },
  b: { min: 0.5, max: 2 },
  c: { min: 2,   max: 5 },
  d: { min: 5,   max: 9 },
  e: { min: 9,   max: 15 },
  f: { min: 15,  max: 30 },
  g: { min: 30,  max: 45 },
  h: { min: 45,  max: 70 },
  i: { min: 70,  max: 100 },
  j: { min: 100, max: null },
};

/** Numeric percent bounds for a TOPO code, or null for the non-slope
 *  specials ($ML / $UL / $UR / $ZZ / $MH) and anything unrecognized. */
export function slopeClassBounds(code) {
  if (code == null) return null;
  return SLOPE_CLASS_BOUNDS[String(code).trim().toLowerCase()] ?? null;
}

/**
 * Aggregate the parcel's slope across its stamped soil composition.
 *
 * Returns null when nothing is stamped or no component carries a real
 * slope class, otherwise:
 *   { min, max, steepestCode, parts: [{code, pct}], coveragePct, unclassifiedPct, uniform }
 *
 * `min`/`max` span the classes actually present — a parcel that is part
 * level and part moderately sloping reports 0 – 15%. `max` is null when
 * the open-ended top class is present.
 *
 * IMPORTANT about coverage. `_soilComposition` is rolled up by soil
 * association and capped (maxRows: 3 for parcels), so:
 *   - a soil appearing in several polygons at different slopes contributes
 *     only its largest polygon's class — see soilSurveyComponentsFromMatches
 *   - the "Other mapped soils" remainder carries no slope at all
 * `coveragePct` is therefore how much of the parcel this range actually
 * speaks for, and callers are expected to surface `unclassifiedPct` rather
 * than let the range imply it covers the whole parcel.
 *
 * `parts` is one entry per distinct SLOPE CLASS (soils sharing a class are
 * summed), ordered by descending share — so parts[0] is the primary slope
 * and parts[1] the secondary.
 */
export function parcelSlopeRange(p) {
  const comp = Array.isArray(p?._soilComposition) ? p._soilComposition : null;
  if (!comp || comp.length === 0) return null;

  // Grouped BY SLOPE CLASS, not by soil. Two soil associations sharing a
  // class describe one stretch of ground, and listing them separately
  // makes the summary read as "0 – 0.5% — 50%; 0 – 0.5% — 28%" when the
  // honest reading is a single "0 – 0.5% — 78%".
  const byClass = new Map();
  let coveragePct = 0;
  let totalPct = 0;
  for (const row of comp) {
    const pct = Number(row?.parcelPct);
    // No share means no contribution — a zero-extent component must not
    // widen the range with a class that covers none of the parcel.
    if (!Number.isFinite(pct) || pct <= 0) continue;
    totalPct += pct;
    if (!slopeClassBounds(row?.topo)) continue;   // specials + the Other row
    coveragePct += pct;
    const code = String(row.topo).trim().toLowerCase();
    byClass.set(code, (byClass.get(code) || 0) + pct);
  }
  if (byClass.size === 0) return null;

  const parts = [...byClass.entries()]
    .map(([code, pct]) => ({ code, pct }))
    // Share descending, then flattest-first so equal shares are stable.
    .sort((a, b) => b.pct - a.pct || slopeSortRank(a.code) - slopeSortRank(b.code));
  let min = Infinity;
  let max = 0;
  let openEnded = false;
  let steepestCode = parts[0].code;
  for (const part of parts) {
    const b = slopeClassBounds(part.code);
    if (b.min < min) min = b.min;
    if (b.max == null) openEnded = true;
    else if (b.max > max) max = b.max;
    if (slopeSortRank(part.code) > slopeSortRank(steepestCode)) steepestCode = part.code;
  }
  const uniform = parts.length === 1;
  return {
    min,
    max: openEnded ? null : max,
    steepestCode,
    parts,
    coveragePct,
    unclassifiedPct: Math.max(0, totalPct - coveragePct),
    uniform,
  };
}

/** Trim a bound for display: 0.5 stays "0.5", 15 stays "15". */
function slopeNum(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1)));
}

/**
 * Compact span for the grid cell — "0 – 15%", or "0 – 0.5%" when the
 * parcel sits in a single class. Empty string when there's nothing to
 * report, so the caller can fall back to the not-loaded hint.
 */
export function slopeRangeText(range) {
  if (!range) return '';
  if (range.max == null) return `>${slopeNum(range.min)}%`;
  return `${slopeNum(range.min)} – ${slopeNum(range.max)}%`;
}
