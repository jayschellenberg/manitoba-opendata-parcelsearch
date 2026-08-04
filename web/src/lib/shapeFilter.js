/*
 * Area-selection shape filter — the pure half of the Matrix-MLS-style
 * "draw a shape, only show those sales" feature. Geometry predicates
 * and ring builders only; the drawing state machine and map layers
 * live in ../drawShapes.js.
 *
 * A shape is one of:
 *   { id, kind: 'circle',    mode, center: {lng, lat}, radiusKm }
 *   { id, kind: 'rectangle', mode, ring: [[lng,lat], ...] }
 *   { id, kind: 'polygon',   mode, ring: [[lng,lat], ...] }
 * where `mode` is 'include' | 'exclude'.
 *
 * Membership is tested against the parcel CENTROID, not polygon
 * overlap — consistent with how the subject-distance and far-flung
 * filters measure, cheap at any result size, and unambiguous for a
 * parcel straddling a shape edge. Circles are tested by great-circle
 * distance to the centre; their rendered ring is display-only, so the
 * test and the drawing can never disagree by more than the ring's
 * segment error.
 */

import { haversineKm } from './routeSolver.js';

/**
 * Ray-casting point-in-ring. `ring` is [[lng, lat], ...], open or
 * closed — the walk wraps j = i-1 so a duplicated closing vertex is
 * harmless. Points exactly on an edge may land on either side; a
 * hand-drawn filter edge carries no legal meaning, so that ambiguity
 * is acceptable.
 */
export function pointInRing(pt, ring) {
  if (!pt || !Array.isArray(ring) || ring.length < 3) return false;
  const x = pt.lng;
  const y = pt.lat;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]; const yi = ring[i][1];
    const xj = ring[j][0]; const yj = ring[j][1];
    const crosses = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** True when the point falls inside one shape (of any kind). */
export function pointInShape(pt, shape) {
  if (!pt || !shape) return false;
  if (shape.kind === 'circle') {
    if (!shape.center || !Number.isFinite(shape.radiusKm)) return false;
    return haversineKm(pt, shape.center) <= shape.radiusKm;
  }
  return pointInRing(pt, shape.ring);
}

/**
 * Matrix include/exclude semantics:
 *   - No shapes at all → everything passes (the filter is off).
 *   - Inside ANY exclude shape → dropped. Exclude always wins, so an
 *     exclude hole cut into an include area behaves as expected.
 *   - With at least one include shape, the point must be inside one;
 *     with only exclude shapes, everything outside them passes.
 * A null/absent point fails once any shape exists: a row whose parcel
 * has no usable centroid cannot be placed, and silently passing it
 * would leak unplaceable rows into an area-narrowed comp set.
 */
export function passesShapeFilter(pt, shapes) {
  if (!Array.isArray(shapes) || shapes.length === 0) return true;
  if (!pt) return false;
  let hasInclude = false;
  let inInclude = false;
  for (const s of shapes) {
    const inside = pointInShape(pt, s);
    if (s.mode === 'exclude') {
      if (inside) return false;
    } else {
      hasInclude = true;
      if (inside) inInclude = true;
    }
  }
  return hasInclude ? inInclude : true;
}

/**
 * Display ring for a circle: `steps` segments on a local-tangent
 * approximation (fine at city/RM scale; the filter itself never reads
 * this ring — see the header note).
 */
export function circleRing(center, radiusKm, steps = 64) {
  const out = [];
  const latRad = (center.lat * Math.PI) / 180;
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.320 * Math.cos(latRad));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    out.push([center.lng + dLng * Math.cos(t), center.lat + dLat * Math.sin(t)]);
  }
  return out;
}

/** Closed 5-vertex ring from two opposite corners. */
export function rectRing(a, b) {
  return [
    [a.lng, a.lat],
    [b.lng, a.lat],
    [b.lng, b.lat],
    [a.lng, b.lat],
    [a.lng, a.lat],
  ];
}

function closeRing(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return ring || [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

/** "650 m" under a kilometre, "2.35 km" from there up — the radius
 *  readout while drawing and the committed circle's label. */
export function formatKm(km) {
  if (!Number.isFinite(km) || km < 0) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(2)} km`;
}

/** Label anchor for a shape: the true centre for a circle, the ring's
 *  bbox midpoint otherwise (may fall outside a concave polygon — fine
 *  for a badge; the fill click works everywhere regardless). */
function labelPoint(s) {
  if (s.kind === 'circle') return [s.center.lng, s.center.lat];
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const [x, y] of s.ring || []) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/**
 * Render FeatureCollection: every shape becomes one Polygon feature
 * (the fill/outline, coloured include-green / exclude-red) PLUS one
 * Point feature at its label anchor — the Matrix-style centre dot the
 * user clicks to flip Include/Exclude, with a text badge underneath.
 *
 * The badge is a Point feature, not a symbol on the Polygon, for the
 * same reason the survey-grid labels are (see map.js): MapLibre's
 * GeoJSON tiler treats each tile-clipped polygon fragment as its own
 * symbol-placement candidate, so an RM-sized shape would grow one
 * badge per tile it spans.
 *
 * Circle badges carry the radius ("Include · 2.35 km") because the
 * radius IS the definition of the shape and the number an appraiser
 * quotes; rectangle/polygon badges are just the mode word.
 */
export function shapesToFc(shapes) {
  const features = [];
  for (const s of shapes || []) {
    features.push({
      type: 'Feature',
      properties: { id: s.id, mode: s.mode, kind: s.kind },
      geometry: {
        type: 'Polygon',
        coordinates: [
          s.kind === 'circle' ? circleRing(s.center, s.radiusKm) : closeRing(s.ring),
        ],
      },
    });
    const modeWord = s.mode === 'exclude' ? 'Exclude' : 'Include';
    features.push({
      type: 'Feature',
      properties: {
        id: s.id,
        mode: s.mode,
        kind: s.kind,
        label: s.kind === 'circle'
          ? `${modeWord} · ${formatKm(s.radiusKm)}`
          : modeWord,
      },
      geometry: { type: 'Point', coordinates: labelPoint(s) },
    });
  }
  return { type: 'FeatureCollection', features };
}
