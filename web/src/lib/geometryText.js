/*
 * Geometry → text, for the CSV export and the grid's Lat/Lon columns.
 *
 * Two jobs:
 *   parcelCentrePoint()  the parcel's centre as {lng, lat}
 *   geometryToWkt()      the full polygon as OGC Well-Known Text
 *
 * The centre is the BOUNDING-BOX MIDPOINT, deliberately — it's what the
 * popup's "GPS Coordinates" copy link, the subject-distance calculation
 * and the numbered map callouts already use, so the grid can never
 * disagree with the rest of the app about where a parcel is. Note the
 * consequence: on a strongly concave parcel (an L, a crescent) the
 * midpoint can fall outside the polygon itself. For quarter-sections
 * and the rectangular parcels this view is built around it sits where
 * you'd expect.
 *
 * WKT is the export format because QGIS and ArcGIS both load a CSV with
 * a WKT column directly as a geometry field, no conversion step.
 *
 * Pure (no DOM / no turf) so both are unit-testable.
 */

// Six decimals ≈ 0.11 m at Manitoba's latitude — far finer than parcel
// boundaries are surveyed, and it keeps a 500-parcel WKT export from
// carrying tens of thousands of meaningless digits. Matches the
// precision the popup's coordinate-copy link already uses.
const COORD_DP = 6;

/**
 * Bounding box of any GeoJSON geometry as [minLng, minLat, maxLng,
 * maxLat], or null when there's nothing finite to measure. Walks nested
 * coordinate arrays to whatever depth the geometry type implies, so
 * Polygon and MultiPolygon share one code path.
 */
export function geometryBbox(geometry) {
  const coords = geometry?.coordinates;
  if (!coords) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c) => {
    if (!c) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
      return;
    }
    for (const sub of c) visit(sub);
  };
  visit(coords);
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return [minX, minY, maxX, maxY];
}

/**
 * The parcel's centre as {lng, lat}, or null when the feature carries no
 * usable geometry. See the module header on why this is the bbox
 * midpoint rather than a centre of mass.
 */
export function parcelCentrePoint(feature) {
  const bbox = geometryBbox(feature?.geometry);
  if (!bbox) return null;
  const [minX, minY, maxX, maxY] = bbox;
  return { lng: (minX + maxX) / 2, lat: (minY + maxY) / 2 };
}

/** Fixed-decimal latitude, or '' when there's no geometry to measure. */
export function parcelLat(feature) {
  const c = parcelCentrePoint(feature);
  return c && Number.isFinite(c.lat) ? c.lat.toFixed(COORD_DP) : '';
}

/** Fixed-decimal longitude, or '' when there's no geometry to measure. */
export function parcelLon(feature) {
  const c = parcelCentrePoint(feature);
  return c && Number.isFinite(c.lng) ? c.lng.toFixed(COORD_DP) : '';
}

/** One "lng lat" pair. WKT is X-then-Y, i.e. longitude BEFORE latitude —
 *  the opposite order from how the popup shows a coordinate to a human. */
function wktPos(pos) {
  if (!Array.isArray(pos)) return null;
  const [x, y] = pos;
  // Reject null/undefined/'' BEFORE Number(), which maps all three of
  // them onto a perfectly finite 0 — that would silently place a
  // corrupt vertex on the equator instead of blanking the cell.
  if (x == null || y == null || x === '' || y === '') return null;
  const lng = Number(x);
  const lat = Number(y);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  // Number() drops the trailing zeros toFixed leaves behind, so a whole
  // degree reads "-96" rather than "-96.000000".
  return `${Number(lng.toFixed(COORD_DP))} ${Number(lat.toFixed(COORD_DP))}`;
}

/** A linear ring / line: "(x y, x y, …)". Null when any position is junk
 *  or the ring is empty, so a malformed ring can't emit broken WKT. */
function wktRing(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return null;
  const parts = [];
  for (const pos of ring) {
    const p = wktPos(pos);
    if (!p) return null;
    parts.push(p);
  }
  return `(${parts.join(', ')})`;
}

/** A polygon's rings: "((outer), (hole), …)". */
function wktRings(rings) {
  if (!Array.isArray(rings) || rings.length === 0) return null;
  const parts = [];
  for (const ring of rings) {
    const r = wktRing(ring);
    if (!r) return null;
    parts.push(r);
  }
  return `(${parts.join(', ')})`;
}

/**
 * GeoJSON geometry → OGC WKT string. Returns '' for anything missing or
 * malformed rather than throwing or emitting a half-formed string — a
 * broken cell in the middle of a CSV export is worse than a blank one.
 *
 * Covers the types Roll_Entry actually serves (Polygon, MultiPolygon)
 * plus the simple ones, so this stays useful if it's reused elsewhere.
 */
export function geometryToWkt(geometry) {
  const type = geometry?.type;
  const coords = geometry?.coordinates;
  if (!type || !coords) return '';
  switch (type) {
    case 'Point': {
      const p = wktPos(coords);
      return p ? `POINT (${p})` : '';
    }
    case 'LineString': {
      const r = wktRing(coords);
      return r ? `LINESTRING ${r}` : '';
    }
    case 'Polygon': {
      const r = wktRings(coords);
      return r ? `POLYGON ${r}` : '';
    }
    case 'MultiPolygon': {
      if (!Array.isArray(coords) || coords.length === 0) return '';
      const parts = [];
      for (const poly of coords) {
        const r = wktRings(poly);
        if (!r) return '';
        parts.push(r);
      }
      return `MULTIPOLYGON (${parts.join(', ')})`;
    }
    default:
      return '';
  }
}

/** `geometryToWkt` for a Feature. */
export function featureToWkt(feature) {
  return geometryToWkt(feature?.geometry);
}
