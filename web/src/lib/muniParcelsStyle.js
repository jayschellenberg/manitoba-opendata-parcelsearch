/*
 * Assessment Parcels boundary styling per basemap family. The fabric is
 * supporting context, so its lines calibrate to what they sit on:
 * against the cream CARTO streets (and the other light rasters —
 * NRCan transportation / elevation) a thin light grey is enough to
 * trace lot lines without shouting; against aerial imagery that same
 * line washed out, so the imagery preset is darker and thicker
 * (Jason, 2026-08-22). Fill and labels are unchanged — only the
 * boundary lines swap.
 *
 * Pure logic — extracted from map.js so node tests can exercise the
 * basemap→preset decision with a stub map (maplibre-gl itself can't
 * load outside a browser).
 */

export const MUNI_PARCELS_LINE_STYLES = {
  light: {
    'line-color': '#9ca3af',
    'line-width': 1,
    'line-opacity': 0.7,
  },
  imagery: {
    'line-color': '#374151',
    'line-width': 2.25,
    'line-opacity': 0.95,
  },
};

/**
 * Re-paint muni-parcels-line for whatever basemap is currently visible.
 * Reads layer visibility rather than taking a mode argument so every
 * basemap-switching path (the menu, setBasemapSatellite, future ones)
 * can call it without agreeing on state names. Imagery = any of the
 * aerial rasters (Esri satellite, Wayback, MLI ortho) showing.
 */
export function applyMuniParcelsBasemapStyle(map) {
  if (!map.getLayer('muni-parcels-line')) return;
  const showing = (id) =>
    map.getLayer(id) && map.getLayoutProperty(id, 'visibility') === 'visible';
  const imagery = showing('esri-imagery') || showing('wayback-imagery') || showing('ortho-mb');
  const style = imagery ? MUNI_PARCELS_LINE_STYLES.imagery : MUNI_PARCELS_LINE_STYLES.light;
  for (const [prop, value] of Object.entries(style)) {
    map.setPaintProperty('muni-parcels-line', prop, value);
  }
}
