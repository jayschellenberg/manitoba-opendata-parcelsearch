/*
 * Water influence — waterfront / near-water classification.
 *
 * r/build_water.R ships per-muni shards built from the V6.3 waterfront
 * detection. Each parcel's `_water` stamp (set in main.js from the shard) is a
 * compact object:
 *
 *   { i: 'Yes', c: 'Direct', t: 'Lake', b: 'Lake Winnipeg' }
 *     i = WaterInfluence      Yes | No
 *     c = WaterInfluenceClass Direct | Waterfront | Reserve Separated |
 *                             Road Separated | Corridor Blocked |
 *                             No Corroboration
 *     t = WaterBodyType       Lake | Watercourse | Retention Pond | ...
 *     b = WaterBody           name, e.g. 'Red River'
 *
 * ABSENCE IS MEANINGFUL, and there are three states — same shape as the Tile
 * Drainage column:
 *   `_water` present                      -> classified, show it
 *   shard loaded, roll absent             -> genuinely no water within 164 ft
 *   shard never loaded (`_waterLoaded`
 *   falsy)                                -> unknown, show blank not "No"
 * Only non-"None" parcels are shipped (370k of 437k are None), so absence from
 * a LOADED shard is the "no water" answer rather than missing data.
 *
 * THE CLASS IS NOT DECORATION. Frontage and near-water-without-access are
 * different markets: a lot fronting the Red River and a lot across the road
 * from it are both "near water" and are not comparable. Road Separated and
 * Corridor Blocked are the second-row cohort — often a view, no frontage —
 * which is why they get their own colour family (see WATER_CLASSES) rather
 * than being folded into a Yes/No flag.
 *
 * This module is the single source of truth for class order, labels and
 * colours, shared by the results grid (main.js) and the map (map.js) so the
 * two never drift — same arrangement as lib/landcover.js.
 */

// Order = severity of water influence, strongest first. Also the map legend
// order. `frontage: true` are exactly the classes the detection calls
// WaterInfluence = "Yes".
//
// ONE BLUE RAMP, DARK = STRONGEST WATER INFLUENCE.
//
// The list is ordered strongest-first, and the colours must descend in
// darkness in exactly that order. Frontage takes the dark half, near-water the
// light half, so the frontage boundary falls where the ramp steps from a solid
// mid-blue (#3a90dd, Reserve separated) to a clearly pale one (#8fc0ea, Road
// separated). Reading darkness as "more water influence" is the intuition
// people bring to the map, and an earlier palette inverted it — near-water
// came out DARKER than waterfront, which actively misleads.
//
// Within near-water the order is meaningful too: Road separated (a road
// between the lot and the water, usually still a view) sits above Corridor
// blocked (another parcel in the way).
//
// Rejected earlier, on evidence:
//   - amber for the near-water pair. Unmistakable, but read as a warning
//     colour for what is often a desirable second-row lot.
//   - teal for the near-water pair. Held up over the yellow fill, but split by
//     hue rather than lightness, so it carried no sense of degree.
//   - pale low-chroma blue-grey. Checked at z17 and it vanished — but that was
//     while the yellow parcel-fill still showed through underneath. That fill
//     is now suppressed whenever the overlay is on (see
//     setWaterInfluenceVisible in map.js), which is what makes a genuinely
//     light near-water colour readable at last.
//
// Any retune must keep BOTH properties: monotonically lightening down the
// list, and a visible step at the frontage boundary. water.test.js pins the
// ordering and the boundary; it cannot judge whether they still read apart on
// a real basemap, so check that on the map.
export const WATER_CLASSES = [
  { key: 'Direct',            label: 'Direct frontage',    short: 'Direct',      color: '#0a4a94', frontage: true  },
  { key: 'Waterfront',        label: 'Waterfront',         short: 'Waterfront',  color: '#1a6fc0', frontage: true  },
  { key: 'Reserve Separated', label: 'Reserve separated',  short: 'Reserve',     color: '#3a90dd', frontage: true  },
  { key: 'Road Separated',    label: 'Road separated',     short: 'Road sep.',   color: '#8fc0ea', frontage: false },
  { key: 'Corridor Blocked',  label: 'Corridor blocked',   short: 'Blocked',     color: '#b3d6f2', frontage: false },
  { key: 'No Corroboration',  label: 'Unconfirmed water',  short: 'Unconfirmed', color: '#d7dce0', frontage: false },
];

const BY_KEY = new Map(WATER_CLASSES.map((c) => [c.key, c]));

/** Class descriptor for a `_water` stamp, or null when there's none. */
export function waterClass(w) {
  if (!w || typeof w !== 'object') return null;
  return BY_KEY.get(w.c) || null;
}

/** True when the parcel has actual frontage (detection's WaterInfluence Yes). */
export function isWaterfront(w) {
  const c = waterClass(w);
  return !!(c && c.frontage);
}

/**
 * True when the parcel is near water but has NO frontage — the second-row
 * cohort. Deliberately excludes 'No Corroboration', which means the water
 * itself couldn't be confirmed rather than that access is blocked.
 */
export function isNearWater(w) {
  const c = waterClass(w);
  return !!(c && !c.frontage && c.key !== 'No Corroboration');
}

/** Map/grid colour for a stamp, or null. */
export function waterColor(w) {
  return waterClass(w)?.color || null;
}

/**
 * Distance in FEET to the nearest water feature, or null.
 *
 * Feet throughout the app because that is the unit frontage is read and argued
 * in. The pipeline measures in metres — the CRS is UTM 14N, so st_distance has
 * no choice — and converts once on the way out, so nothing downstream of the
 * shard ever sees a metre.
 *
 * The explicit null/undefined/'' guard is load-bearing: Number(null) is 0, not
 * NaN, so a shard row with no distance would otherwise read as 0 ft — the cell
 * printing "Red River - 0 ft" and asserting the parcel sits ON the water,
 * which is the strongest claim this column can make and exactly the one we
 * have no evidence for.
 */
export function waterDistance(w) {
  const raw = w?.d;
  if (raw === null || raw === undefined || raw === '') return null;
  const d = Number(raw);
  return Number.isFinite(d) ? d : null;
}

/** "64 ft" / "3.5 ft" — whole feet at 10 ft and above, one decimal below,
 *  where the difference between 3.5 and 8 ft still distinguishes two lots. */
export function formatWaterDistance(d) {
  if (!Number.isFinite(d)) return '';
  return d >= 10 ? `${Math.round(d)} ft` : `${d.toFixed(1)} ft`;
}

/**
 * Grid cell text — water body then distance, e.g. "Red River · 60 ft".
 *
 * Leads with the body name because that is what an appraiser actually reads,
 * and carries the distance because no frontage threshold is right in every
 * community: amenity-strip widths and pond setbacks are developer choices. A
 * borderline parcel should show its measurement rather than a bare verdict.
 *
 * Near-water rows now carry a body name too (the pipeline records the nearest
 * feature whatever the verdict), so this reads "Lake Winnipeg · 79 ft" on a
 * Corridor Blocked lot instead of the bare class label. The dot colour and the
 * tooltip still carry the frontage verdict — the name is context, not a claim.
 *
 * Returns '' when there is no stamp; callers decide between blank (not loaded)
 * and an explicit no-water label.
 */
export function waterCellText(w) {
  const c = waterClass(w);
  if (!c) return '';
  const body = (w.b || '').trim();
  const dist = formatWaterDistance(waterDistance(w));
  let head;
  if (body && body !== 'Retention Pond') head = body;
  else if (w.t === 'Retention Pond') head = 'Retention pond';
  else head = c.label;
  return dist ? `${head} · ${dist}` : head;
}

/**
 * Sort key: class severity first, distance as the tie-break within a class.
 *
 * The integer part is the class index so every frontage parcel still sorts
 * above every near-water one. The fractional part is distance scaled into
 * [0, 1) — capped at the detection limit, so ordering by "how close" inside a
 * class can never reorder the classes themselves. Unstamped parcels sort last.
 */
export const WATER_DETECTION_LIMIT_FT = 164;   // the pipeline's 50 m buffer

export function waterSortRank(w) {
  const c = waterClass(w);
  if (!c) return WATER_CLASSES.length;
  const d = waterDistance(w);
  const cap = WATER_DETECTION_LIMIT_FT;
  const within = Number.isFinite(d) ? Math.min(d, cap) / (cap + 1) : cap / (cap + 1);
  return WATER_CLASSES.indexOf(c) + within;
}

/**
 * CSV cells for the water export columns: Water / Water Class / Water Body /
 * Water Type / Water Distance (ft).
 *
 * Bare values, not the grid's "body · 60 ft" composite — a spreadsheet
 * filters and pivots on one fact per column, mirroring how Tiled and
 * Irrigated split theirs.
 *
 * Same three states as the grid cell, and the difference still matters:
 *   - shard never loaded (`loaded` false) → all blank. We genuinely do not
 *     know; "No water" here would be a confident lie.
 *   - loaded, no stamp → "No water", rest blank. Distinct wording from the
 *     stamped near-water "No" (frontage verdict) on purpose: one says
 *     nothing is within 164 ft, the other says water is near but access
 *     has no frontage.
 *   - stamped → verdict (Yes/No), class label, body, type, whole feet.
 */
export function waterCsvCells(w, loaded) {
  if (!w) return loaded ? ['No water', '', '', '', ''] : ['', '', '', '', ''];
  const d = waterDistance(w);
  return [
    w.i || '',
    waterClass(w)?.label || '',
    (w.b || '').trim(),
    w.t || '',
    Number.isFinite(d) ? d : '',
  ];
}

/** Hover detail — class, water body and type, one per line. */
export function waterTooltip(w) {
  const c = waterClass(w);
  if (!c) return '';
  const out = [c.label];
  const body = (w.b || '').trim();
  if (body) out.push(`Water body: ${body}`);
  if (w.t && w.t !== body) out.push(`Type: ${w.t}`);
  const d = waterDistance(w);
  if (Number.isFinite(d)) {
    // Spelled out because the verdict is a threshold applied to this number,
    // and thresholds calibrated in one community do not transfer cleanly to
    // another. Showing the measurement lets a borderline call be second-
    // guessed instead of taken on trust.
    out.push(`Distance to water: ${formatWaterDistance(d)} (parcel boundary)`);
  }
  if (!c.frontage) {
    out.push(c.key === 'No Corroboration'
      ? 'Near an unnamed water feature that could not be confirmed against a named one.'
      : 'Near water but without frontage — another parcel or a road lies between.');
  }
  out.push('Screening aid from provincial/federal mapping, not a survey.');
  return out.join('\n');
}
