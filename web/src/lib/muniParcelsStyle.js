/*
 * Assessment Parcels styling per basemap family. The fabric is
 * supporting context, so it calibrates to what it sits on: against the
 * cream CARTO streets (and the other light rasters — NRCan
 * transportation / elevation) a very light, thin grey traces lot lines
 * without shouting, over a near-invisible fill; against aerial imagery
 * the lines go WHITE and thicker — the classic cadastre-on-imagery
 * treatment, after a dark slate tried first washed into the fields
 * (Jason, 2026-08-22). Labels are unchanged.
 *
 * Pure logic — extracted from map.js so node tests can exercise the
 * basemap→preset decision with a stub map (maplibre-gl itself can't
 * load outside a browser).
 */

export const MUNI_PARCELS_LINE_STYLES = {
  light: {
    'line-color': '#d1d5db',
    'line-width': 0.75,
    'line-opacity': 0.6,
  },
  imagery: {
    'line-color': '#ffffff',
    'line-width': 2.25,
    'line-opacity': 0.95,
  },
};

// The grey wash under the lines. On Streets it drops to barely-there —
// the basemap's own colouring should read through untinted; imagery
// keeps the original 0.04, where a hint of wash helps the fabric read
// as one layer against busy ground.
export const MUNI_PARCELS_FILL_STYLES = {
  light:   { 'fill-opacity': 0.02 },
  imagery: { 'fill-opacity': 0.04 },
};

/**
 * Re-paint the muni-parcels fabric (boundary lines + fill wash) for
 * whatever basemap is currently visible. Reads layer visibility rather
 * than taking a mode argument so every basemap-switching path (the
 * menu, setBasemapSatellite, future ones) can call it without agreeing
 * on state names. Imagery = any of the aerial rasters (Esri satellite,
 * Wayback, MLI ortho) showing.
 */
export function applyMuniParcelsBasemapStyle(map) {
  const showing = (id) =>
    map.getLayer(id) && map.getLayoutProperty(id, 'visibility') === 'visible';
  const imagery = showing('esri-imagery') || showing('wayback-imagery') || showing('ortho-mb');
  const family = imagery ? 'imagery' : 'light';
  const targets = [
    ['muni-parcels-line', MUNI_PARCELS_LINE_STYLES[family]],
    ['muni-parcels-fill', MUNI_PARCELS_FILL_STYLES[family]],
  ];
  for (const [layer, style] of targets) {
    if (!map.getLayer(layer)) continue;
    for (const [prop, value] of Object.entries(style)) {
      map.setPaintProperty(layer, prop, value);
    }
  }
}
