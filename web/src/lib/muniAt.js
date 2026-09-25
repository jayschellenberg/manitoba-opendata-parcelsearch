// Which municipality is a point in?
//
// The Assessment Parcels overlay is scoped to the municipality picked in
// the dropdown (main.js scopedOverlayMunis), so "show me the parcels
// around me" first has to name the municipality under the GPS fix. The
// answer comes from the same 183-polygon boundary file the map's
// municipality layer draws (public/mb-municipalities.geojson), fetched
// once and kept; its MUNI_LIST_NAME_WITH_TYPE is exactly the dropdown's
// option value ("STEINBACH (CITY)"), so the caller can select it directly.

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

export const MUNI_GEOJSON_URL = 'mb-municipalities.geojson';

let loading = null;

async function features() {
  if (!loading) {
    loading = fetch(MUNI_GEOJSON_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((fc) => fc.features || [])
      .catch((err) => { loading = null; throw err; });
  }
  return loading;
}

/** The boundary features themselves (fetched once and shared). Rejects when
 *  the file can't be fetched. */
export function municipalityFeatures() {
  return features();
}

/**
 * Pure: the first feature whose polygon contains [lng, lat], as
 * { no, name, listName } — or null. Exported for the test; the async
 * municipalityAt() below is what the app calls.
 */
export function pickMunicipality(feats, lngLat) {
  const pt = { type: 'Point', coordinates: [lngLat.lng ?? lngLat[0], lngLat.lat ?? lngLat[1]] };
  for (const f of feats || []) {
    if (!f?.geometry) continue;
    let inside = false;
    try { inside = booleanPointInPolygon(pt, f); } catch { inside = false; }
    if (!inside) continue;
    const p = f.properties || {};
    return {
      no: p.MUNI_NO ?? null,
      name: p.MUNI_NAME || null,
      listName: p.MUNI_LIST_NAME_WITH_TYPE || null,
    };
  }
  return null;
}

/** The municipality under a point, or null (outside every boundary, or
 *  the boundary file could not be fetched). Never throws. */
export async function municipalityAt(lngLat) {
  try {
    return pickMunicipality(await features(), lngLat);
  } catch {
    return null;
  }
}
