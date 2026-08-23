// Cheap centroid for parcel polygons.
//
// Two callers, and they need it to agree:
//   - map.js, for popup coordinates and the withheld-parcel test
//   - scripts/build-parcel-tiles.js, to place the one label point per
//     parcel that becomes the archive's `parcels-labels` source-layer
//
// That label layer exists because MapLibre places a polygon symbol at the
// centroid of each TILE-CLIPPED piece of the geometry, so a parcel
// straddling a tile boundary gets its roll number drawn 2-6× at high zoom.
// One Point per parcel, positioned once at build time, renders exactly once.

/** Bbox midpoint of any Polygon / MultiPolygon geometry. A cheap
 *  approximation of a centroid — exact enough for label placement, where
 *  we only need a point within or near the polygon.
 *
 *  Returns null for missing or non-polygon geometries. That null is
 *  load-bearing at map.js's callout sites: a withheld parcel is rendered
 *  as a Point, so a null here is how those sites detect one. */
export function polygonBboxMidpoint(geometry) {
  if (!geometry) return null;
  const type = geometry.type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (coords) => {
    if (!coords) return;
    if (typeof coords[0] === 'number') {
      if (coords[0] < minX) minX = coords[0];
      if (coords[0] > maxX) maxX = coords[0];
      if (coords[1] < minY) minY = coords[1];
      if (coords[1] > maxY) maxY = coords[1];
      return;
    }
    for (const c of coords) visit(c);
  };
  visit(geometry.coordinates);
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}
