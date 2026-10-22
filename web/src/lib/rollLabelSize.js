// Roll-number label size, by zoom and parcel acreage.
//
// One table, two readers: map.js builds the muni-parcels-label layer's
// text-size expression from it, and the numbered callouts read the same
// size to sit a badge just above the roll number (Jason, 2026-10-22).
// Keeping both on this table is what stops the badge drifting onto the
// label when someone retunes the sizes.

/** [zoom, [[acres, px], ...]] — each zoom stop maps acreage to a size. */
export const ROLL_LABEL_SIZE_STOPS = [
  [13, [[0.1, 7], [1, 9], [10, 11], [80, 12], [640, 14]]],
  [14, [[0.1, 7], [1, 10], [10, 12], [80, 13], [640, 15]]],
  [17, [[0.1, 9], [1, 12], [10, 14], [80, 16], [640, 18]]],
  [19, [[0.1, 11], [1, 14], [10, 16], [80, 18], [640, 20]]],
];

/** The layer's zoom-then-acreage interpolate expression. */
export function rollLabelSizeExpression() {
  const out = ['interpolate', ['linear'], ['zoom']];
  for (const [zoom, stops] of ROLL_LABEL_SIZE_STOPS) {
    out.push(zoom, ['interpolate', ['linear'], ['to-number', ['get', '_acres'], 1], ...stops.flat()]);
  }
  return out;
}

/** MapLibre's linear interpolate, clamped at both ends. */
function lerpStops(stops, x) {
  if (x <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [x1, y1] = stops[i];
    if (x <= x1) {
      const [x0, y0] = stops[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return stops[stops.length - 1][1];
}

/** The size (px) the layer draws a roll number at, at `zoom`, for a parcel
 *  of `acres` — what rollLabelSizeExpression evaluates to. */
export function rollLabelSize(zoom, acres) {
  // to-number reads a missing property (null) as 0 and only falls back to
  // the 1 for a value it cannot convert.
  const n = acres == null || acres === false ? 0 : Number(acres);
  const a = Number.isFinite(n) ? n : 1;
  return lerpStops(ROLL_LABEL_SIZE_STOPS.map(([z, stops]) => [z, lerpStops(stops, a)]), zoom);
}
