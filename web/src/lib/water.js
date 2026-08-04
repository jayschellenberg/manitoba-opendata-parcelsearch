/*
 * Water influence — waterfront / near-water classification.
 *
 * r/build_water.R ships per-muni shards built from the V6.1 waterfront
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
 *   shard loaded, roll absent             -> genuinely no water within 50 m
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
 * Grid cell text. Leads with the water body name when there is one, because
 * that is what an appraiser actually reads ("Red River"), and falls back to
 * the class label. Returns '' when there's no stamp — callers decide between
 * blank (not loaded) and an explicit no-water dash.
 */
export function waterCellText(w) {
  const c = waterClass(w);
  if (!c) return '';
  const body = (w.b || '').trim();
  if (body && body !== 'Retention Pond') return body;
  if (w.t === 'Retention Pond') return 'Retention pond';
  return c.label;
}

/** Sort key: frontage classes first, then near-water, then everything else. */
export function waterSortRank(w) {
  const c = waterClass(w);
  if (!c) return WATER_CLASSES.length;
  return WATER_CLASSES.indexOf(c);
}

/** Hover detail — class, water body and type, one per line. */
export function waterTooltip(w) {
  const c = waterClass(w);
  if (!c) return '';
  const out = [c.label];
  const body = (w.b || '').trim();
  if (body) out.push(`Water body: ${body}`);
  if (w.t && w.t !== body) out.push(`Type: ${w.t}`);
  if (!c.frontage) {
    out.push(c.key === 'No Corroboration'
      ? 'Near an unnamed water feature that could not be confirmed against a named one.'
      : 'Near water but without frontage — another parcel or a road lies between.');
  }
  out.push('Screening aid from provincial/federal mapping, not a survey.');
  return out.join('\n');
}
