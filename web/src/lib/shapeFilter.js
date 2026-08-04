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

/**
 * Render FeatureCollection: every shape becomes one Polygon feature
 * carrying { id, mode, kind } so the fill layer can colour include
 * green / exclude red and the click handler can find the shape back.
 */
export function shapesToFc(shapes) {
  return {
    type: 'FeatureCollection',
    features: (shapes || []).map((s) => ({
      type: 'Feature',
      properties: { id: s.id, mode: s.mode, kind: s.kind },
      geometry: {
        type: 'Polygon',
        coordinates: [
          s.kind === 'circle' ? circleRing(s.center, s.radiusKm) : closeRing(s.ring),
        ],
      },
    })),
  };
}
