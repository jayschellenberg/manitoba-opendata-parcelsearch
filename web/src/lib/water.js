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
// ALL BLUE-FAMILY, BUT TWO GROUPS — split by HUE:
//   frontage      true blues
//   near-water    teals
//
// The split has to survive because frontage vs no-frontage is a category
// boundary, not a gradient: a lot fronting the Red River and a lot across the
// road from it are not comparable, and a single blue ramp would imply they
// differ only by degree.
//
// Two earlier attempts, both rejected on evidence:
//   - amber for the near-water pair. Separated them unmistakably, but read as
//     a warning colour for what is often a desirable second-row lot.
//   - pale low-chroma blue-grey. Checked on the map at z17 and it was too
//     faint: `water-fill` paints at 0.7 over the app's existing yellow
//     `parcel-fill` (#ffea00 at 0.4), so a washed-out colour muddies to grey-
//     green and effectively disappears.
// Teal keeps the whole overlay blue-ish while staying saturated enough to hold
// its own over that yellow. Any retune must clear the same bar: check it ON
// THE MAP over parcel-fill, not just as swatches — `water.test.js` asserts the
// two groups never share a value but cannot judge whether they still read
// apart.
export const WATER_CLASSES = [
  { key: 'Direct',            label: 'Direct frontage',    short: 'Direct',      color: '#0d5bbf', frontage: true  },
  { key: 'Waterfront',        label: 'Waterfront',         short: 'Waterfront',  color: '#2e86e0', frontage: true  },
  { key: 'Reserve Separated', label: 'Reserve separated',  short: 'Reserve',     color: '#6db4f0', frontage: true  },
  { key: 'Road Separated',    label: 'Road separated',     short: 'Road sep.',   color: '#2aa7b5', frontage: false },
  { key: 'Corridor Blocked',  label: 'Corridor blocked',   short: 'Blocked',     color: '#177f8e', frontage: false },
  { key: 'No Corroboration',  label: 'Unconfirmed water',  short: 'Unconfirmed', color: '#9aa0a6', frontage: false },
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
