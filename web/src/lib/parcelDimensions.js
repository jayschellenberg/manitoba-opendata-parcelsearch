/*
 * Parcel side dimensions, in feet, from the assessment polygon.
 *
 * Replaces measuring a lot by hand with the Measure tool. Each outer ring is
 * reduced to its "sides" — the runs an appraiser would call one side — and
 * each side's length is reported. Three things stand between a raw ring and
 * that list, and they are what this module exists for:
 *
 *   1. DIGITIZING NOISE. A straight lot line routinely carries extra vertices
 *      a few inches off the line. Measured raw, a 120 ft side reads as
 *      "61.3 / 58.9". Vertices whose offset from the chord of their
 *      neighbours is under STRAIGHT_TOL_M (or a tiny fraction of the shorter
 *      neighbour, for long rural lines) are dropped, so the run merges.
 *   2. CURVES. A cul-de-sac or curved frontage is dozens of short chords.
 *      A run of gentle same-direction bends is folded into ONE side flagged
 *      `arc`, reported as its arc length (the sum of the chords).
 *   3. SLIVERS. A jog shorter than MIN_SIDE_FT stays in the perimeter but
 *      gets no label of its own — "0.4 ft" on a map is noise, not a fact.
 *
 * Lengths are measured on a local tangent plane using WGS84 metres-per-degree
 * at the ring's own latitude. Over a parcel (well under the 2 km of a quarter
 * section's diagonal) that is within millimetres of the ellipsoidal distance
 * — closer than turf's spherical haversine, and far below the error in the
 * assessment polygon itself. These are APPROXIMATE dimensions: the polygons
 * are digitized, not surveyed.
 *
 * Holes are ignored; MultiPolygon parts are measured separately. Sides are
 * listed clockwise, starting with the side whose midpoint is furthest north.
 *
 * Pure and dependency-free so it unit-tests under node (test/parcelDimensions.test.js).
 */

export const M_TO_FT = 1 / 0.3048;

// A vertex sitting closer than this to the line through its neighbours is
// digitizing noise, not a corner. ~1 ft.
export const STRAIGHT_TOL_M = 0.3;
// …or closer than this fraction of the shorter adjacent segment, so a 1 m
// wobble halfway along an 800 m quarter line still merges (≈0.3° deflection).
export const STRAIGHT_TOL_FRAC = 0.0025;
// A bend at or under this many degrees can be part of a curve.
export const ARC_MAX_TURN_DEG = 30;
// …and a curve needs at least this many consecutive gentle same-direction
// bends. One or two bends is a bent lot line — two real sides.
export const ARC_MIN_BENDS = 3;
// …turning through at least this much in total.
export const ARC_MIN_TOTAL_TURN_DEG = 15;
// Chords longer than this are not part of a digitized curve.
export const ARC_MAX_CHORD_M = 20;
// A curve's chords are near-uniform. Where a long straight meets the first
// short chord of a curve (the tangent point) the ratio is large, which is
// what keeps a 66 ft frontage from being swallowed into a rounded corner.
export const ARC_MAX_CHORD_RATIO = 3;
// Sides shorter than this get no label (still counted in the perimeter).
export const MIN_SIDE_FT = 1;

/** WGS84 metres per degree of latitude / longitude at latitude `latDeg`. */
function metresPerDegree(latDeg) {
  const p = (latDeg * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p),
  };
}

/** Outer rings of a Polygon / MultiPolygon geometry; [] for anything else. */
function outerRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates?.[0] ? [geometry.coordinates[0]] : [];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).map((p) => p?.[0]).filter(Boolean);
  return [];
}

/** Drop the closing duplicate and consecutive repeats. */
function openRing(ring) {
  const out = [];
  for (const c of ring) {
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const last = out[out.length - 1];
    if (last && last[0] === c[0] && last[1] === c[1]) continue;
    out.push([c[0], c[1]]);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out;
}

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** Perpendicular offset of p from the line a→b (metres). */
function offsetFromChord(p, a, b) {
  const L = dist(a, b);
  if (L === 0) return dist(p, a);
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / L;
}

/** Signed turn at b travelling a→b→c, degrees (+ = left). */
function turnDeg(a, b, c) {
  const h1 = Math.atan2(b.y - a.y, b.x - a.x);
  const h2 = Math.atan2(c.y - b.y, c.x - b.x);
  let d = ((h2 - h1) * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * Remove noise vertices, least significant first, until every remaining
 * vertex is a real bend. Works on an open ring of {x, y, ll, keep}; a vertex
 * flagged `keep` (a curve and its two ends) is never removed — the bulge of a
 * tight curve between neighbouring vertices is well under the noise
 * tolerance, so without this a rounded corner collapses into its frontage.
 */
function dropNoiseVertices(pts) {
  const v = pts.slice();
  for (;;) {
    if (v.length <= 3) return v;
    let best = -1, bestOff = Infinity;
    for (let i = 0; i < v.length; i++) {
      if (v[i].keep) continue;
      const a = v[(i - 1 + v.length) % v.length], b = v[i], c = v[(i + 1) % v.length];
      const off = offsetFromChord(b, a, c);
      const tol = Math.max(STRAIGHT_TOL_M, STRAIGHT_TOL_FRAC * Math.min(dist(a, b), dist(b, c)));
      if (off <= tol && off < bestOff) { best = i; bestOff = off; }
    }
    if (best < 0) return v;
    v.splice(best, 1);
  }
}

/**
 * Flag curve vertices on the RAW ring: `arc` on a curve's interior vertices,
 * `keep` on those and on the two vertices where the curve meets its
 * neighbouring sides.
 */
function markCurves(v) {
  const n = v.length;
  const turns = v.map((b, i) => turnDeg(v[(i - 1 + n) % n], b, v[(i + 1) % n]));
  // Which vertices are gentle bends that may belong to a curve?
  const gentle = v.map((b, i) => {
    const a = v[(i - 1 + n) % n], c = v[(i + 1) % n];
    const t = turns[i];
    const d1 = dist(a, b), d2 = dist(b, c);
    const ok = t !== 0 && Math.abs(t) <= ARC_MAX_TURN_DEG
      && d1 <= ARC_MAX_CHORD_M && d2 <= ARC_MAX_CHORD_M
      && Math.max(d1, d2) <= ARC_MAX_CHORD_RATIO * Math.min(d1, d2);
    return ok ? Math.sign(t) : 0;
  });
  if (gentle.every((g) => g !== 0 && g === gentle[0])) {
    // The whole ring is one smooth curve (a round lot). Keep one break so
    // it still reads as a single closed side.
    v.forEach((p, i) => { p.arc = i !== 0; p.keep = true; });
    return;
  }
  // Walk runs starting at a run boundary so a run that wraps past index 0
  // is seen whole.
  let start = gentle.findIndex((g, i) => g !== gentle[(i - 1 + n) % n]);
  if (start < 0) start = 0;
  let i = 0;
  while (i < n) {
    const g = gentle[(start + i) % n];
    if (g === 0) { i++; continue; }
    let len = 0, total = 0;
    while (len < n && gentle[(start + i + len) % n] === g) {
      total += Math.abs(turns[(start + i + len) % n]);
      len++;
    }
    // A curve needs enough bends AND enough total turn — three 1° wiggles
    // in a straight line turning the same way by chance are not a curve.
    if (len >= ARC_MIN_BENDS && total >= ARC_MIN_TOTAL_TURN_DEG) {
      for (let j = -1; j <= len; j++) {
        const p = v[(start + i + j + n) % n];
        p.keep = true;
        if (j >= 0 && j < len) p.arc = true;
      }
    }
    i += len;
  }
}

/** Shoelace signed area of an open ring of {x, y}; > 0 = counter-clockwise. */
function signedArea(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/**
 * Sides of one outer ring, clockwise from the northernmost side.
 * @returns {{sides: Array<{ft:number, arc:boolean, coords:number[][]}>, perimeterFt:number}|null}
 */
function ringSides(ring) {
  const ll = openRing(ring);
  if (ll.length < 3) return null;
  let lat0 = 0, lon0 = 0;
  for (const c of ll) { lon0 += c[0]; lat0 += c[1]; }
  lon0 /= ll.length; lat0 /= ll.length;
  const k = metresPerDegree(lat0);
  let pts = ll.map((c) => ({ x: (c[0] - lon0) * k.lon, y: (c[1] - lat0) * k.lat, ll: c }));
  if (signedArea(pts) > 0) pts.reverse();          // make it clockwise
  if (Math.abs(signedArea(pts)) === 0) return null;

  markCurves(pts);
  const v = dropNoiseVertices(pts);
  const n = v.length;

  // Corners are the vertices that are not inside a curve. Walk corner to
  // corner, collecting every vertex between as one side.
  const corners = [];
  for (let i = 0; i < n; i++) if (!v[i].arc) corners.push(i);
  const sides = [];
  let perimeterM = 0;
  for (let ci = 0; ci < corners.length; ci++) {
    const from = corners[ci];
    const to = corners[(ci + 1) % corners.length];
    const span = ((to - from + n) % n) || n;
    const run = [];
    for (let j = 0; j <= span; j++) run.push(v[(from + j) % n]);
    let m = 0;
    for (let j = 1; j < run.length; j++) m += dist(run[j - 1], run[j]);
    perimeterM += m;
    sides.push({
      ft: m * M_TO_FT,
      arc: run.length > 2,
      coords: run.map((p) => p.ll),
      // Midpoint height of the side's chord, for the start-at-north rule.
      midY: (run[0].y + run[run.length - 1].y) / 2,
    });
  }
  if (!sides.length) return null;
  // Start at the northernmost side, keeping clockwise order.
  let top = 0;
  for (let i = 1; i < sides.length; i++) if (sides[i].midY > sides[top].midY) top = i;
  const ordered = sides.slice(top).concat(sides.slice(0, top)).map(({ ft, arc, coords }) => ({ ft, arc, coords }));
  return { sides: ordered, perimeterFt: perimeterM * M_TO_FT };
}

const CACHE = new WeakMap();

/**
 * Dimensions of a parcel geometry. Cached per geometry object, so the grid,
 * the sort and the map can all ask without re-measuring.
 *
 * @returns {{parts: Array<{sides: Array<{ft:number, arc:boolean, coords:number[][]}>, perimeterFt:number}>,
 *            perimeterFt:number}|null}  null for a point / missing geometry.
 */
export function parcelDimensions(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  if (CACHE.has(geometry)) return CACHE.get(geometry);
  const parts = outerRings(geometry).map(ringSides).filter(Boolean);
  const out = parts.length
    ? { parts, perimeterFt: parts.reduce((s, p) => s + p.perimeterFt, 0) }
    : null;
  CACHE.set(geometry, out);
  return out;
}

/** "66.0" under 1,000 ft, "1,320" at or above. */
export function formatFeet(ft) {
  if (!Number.isFinite(ft)) return '';
  return ft < 1000
    ? ft.toFixed(1)
    : Math.round(ft).toLocaleString('en-US');
}

/** The sides that get a label of their own (slivers dropped). */
export function labelledSides(part) {
  return (part?.sides || []).filter((s) => s.ft >= MIN_SIDE_FT);
}

/**
 * Grid / CSV text: "66.0 / 120.2 / 66.1 / 119.8", an arc marked "(arc)",
 * MultiPolygon parts separated by " | ". '' when there is no polygon.
 */
export function formatSides(dims) {
  if (!dims?.parts?.length) return '';
  return dims.parts
    .map((part) => labelledSides(part)
      .map((s) => `${formatFeet(s.ft)}${s.arc ? ' (arc)' : ''}`)
      .join(' / '))
    .filter(Boolean)
    .join(' | ');
}

// Past this many sides a list of lengths is not something anyone reads in a
// grid cell — a riverbank or park parcel can have hundreds. The grid shows a
// summary instead (the full list stays in the tooltip and the CSV).
export const GRID_MAX_SIDES = 12;

/** Total labelled sides across every part. */
export function sideCount(dims) {
  return (dims?.parts || []).reduce((n, part) => n + labelledSides(part).length, 0);
}

/** Grid text: the side list, or "Irregular — N sides" when it is too long. */
export function formatSidesForGrid(dims) {
  const n = sideCount(dims);
  if (n > GRID_MAX_SIDES) return `Irregular — ${n} sides (${formatFeet(dims.perimeterFt)} ft perimeter)`;
  return formatSides(dims);
}

/**
 * Point at the middle of a side (by length, so an arc's label sits on the
 * arc) and the rotation, in degrees clockwise, that lays text along the side
 * there, normalised to [-90, 90] so it never reads upside down.
 */
function sideLabelAnchor(coords) {
  const k = metresPerDegree(coords[0][1]);
  const xy = coords.map((c) => ({ x: c[0] * k.lon, y: c[1] * k.lat }));
  let total = 0;
  for (let i = 1; i < xy.length; i++) total += dist(xy[i - 1], xy[i]);
  let half = total / 2;
  for (let i = 1; i < xy.length; i++) {
    const seg = dist(xy[i - 1], xy[i]);
    if (seg >= half || i === xy.length - 1) {
      const t = seg > 0 ? Math.min(1, half / seg) : 0;
      const a = coords[i - 1], b = coords[i];
      // Bearing clockwise from north; horizontal text runs east (90°).
      const bearing = (Math.atan2(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y) * 180) / Math.PI;
      let rot = bearing - 90;
      while (rot > 90) rot -= 180;
      while (rot < -90) rot += 180;
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], rot };
    }
    half -= seg;
  }
  return null;
}

/** Undirected key for a side, so a line two result parcels share (or a
 *  parcel listed twice) is labelled once. ~10 cm rounding. */
function sideKey(coords) {
  const r = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
  return coords.map(r).sort().join('|');
}

/**
 * One Point per labelled side, at its middle, carrying the label text and
 * the rotation that lays it along the side.
 *
 * Points, not the sides' LineStrings: a GeoJSON source cuts lines at tile
 * boundaries, and `line-center` then labels EACH piece, so a side crossing a
 * tile edge came out with its length printed twice. A point is never cut.
 */
export function dimensionLabelFeatures(features) {
  const out = [];
  const seen = new Set();
  for (const f of features || []) {
    const dims = parcelDimensions(f?.geometry);
    if (!dims) continue;
    for (const part of dims.parts) {
      for (const s of labelledSides(part)) {
        const key = sideKey(s.coords);
        if (seen.has(key)) continue;
        seen.add(key);
        const anchor = sideLabelAnchor(s.coords);
        if (!anchor) continue;
        out.push({
          type: 'Feature',
          properties: {
            label: `${formatFeet(s.ft)} ft${s.arc ? ' arc' : ''}`,
            rot: Math.round(anchor.rot * 10) / 10,
          },
          geometry: { type: 'Point', coordinates: anchor.point },
        });
      }
    }
  }
  return out;
}
