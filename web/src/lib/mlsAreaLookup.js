// MLS area lookup for the parcel popups (Jason, 2026-11-24): every parcel
// hover and click popup names the MLS area the parcel sits in, whether or
// not the MLS Areas overlay is switched on. The charts page's sale tooltips
// use it too.
//
// Same module as the Winnipeg ParcelSearch app's, bar this header. It is
// separate from lib/mlsAreas.js because that file is kept byte-identical
// between the two apps; it reuses that module's once-per-page fetch, so
// switching the overlay on later costs nothing more.
//
// Coverage is the three boards' areas only (Winnipeg Regional, Brandon,
// Portage la Prairie): a parcel anywhere else gets null and no line.
//
// The areas come largest first (nested ones after the area they sit in), so
// the LAST polygon containing the point is the one that draws on top, and
// the one the overlay's own click popup reports.

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import { fetchMlsAreas } from './mlsAreas.js';

let index = null; // [{ box: [minX, minY, maxX, maxY], feature }] in file order

/** Index a FeatureCollection for lookups. Exported for the tests. */
export function setMlsAreaLookupData(fc) {
  index = (fc?.features || [])
    .filter((f) => f?.geometry && f.properties?.area)
    .map((f) => ({ box: bbox(f), feature: f }));
}

/** Start the background load. Never rejects: a failed load just leaves the
 *  popups without the line (fetchMlsAreas retries on the next call). */
export function loadMlsAreaLookup(fetchFn) {
  return fetchMlsAreas(fetchFn)
    .then((fc) => { setMlsAreaLookupData(fc); return true; })
    .catch(() => false);
}

/** Properties ({ area, board, ... }) of the MLS area at [lng, lat], or null
 *  when the areas are not loaded yet or the point is in none of them. */
export function mlsAreaAt(point) {
  if (!index || !Array.isArray(point)) return null;
  const [x, y] = point;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (let i = index.length - 1; i >= 0; i--) {
    const { box, feature } = index[i];
    if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
    if (booleanPointInPolygon([x, y], feature)) return feature.properties;
  }
  return null;
}
