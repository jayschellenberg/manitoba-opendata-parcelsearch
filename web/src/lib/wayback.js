/*
 * Esri Wayback historical World Imagery — the pure, node-testable bits
 * (release list + tile-URL builder). map.js imports these; keeping them
 * out of map.js means the test suite can exercise them without pulling
 * in maplibre-gl.
 *
 * Wayback is the archive of the same World Imagery basemap the app
 * already uses (server.arcgisonline.com). Each "release" is a permanent,
 * dated snapshot identified by an immutable release number. We curate the
 * list to the release dates where imagery actually changed over Manitoba
 * — the same set the Esri Wayback app shows under "Only versions with
 * local changes" for the MB extent — so the dropdown stays short and
 * every entry is a real, visible change here. Newest first.
 *
 * To refresh: open https://livingatlas.arcgis.com/wayback over Manitoba
 * with "Only versions with local changes" on, read off the dates, and map
 * each to its release number via
 * https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json
 * (the itemTitle carries the date; the object key is the release number).
 */

export const WAYBACK_VERSIONS = [
  { date: '2022-11-02', release: 7110 },
  { date: '2020-05-20', release: 32645 },
  { date: '2019-06-26', release: 645 },
  { date: '2018-01-18', release: 13045 },
  { date: '2015-12-16', release: 28163 },
  { date: '2014-06-11', release: 31144 },
  { date: '2014-02-20', release: 10 },
];

/**
 * Wayback raster tile URL for a release number. The service's WMTS
 * template uses {level}/{row}/{col}; MapLibre's {z}/{y}/{x} maps 1:1
 * (same Web-Mercator default028mm scheme as the live Esri imagery, so no
 * reprojection). Tiles are CORS-enabled, so they survive the canvas
 * exports (Generate Map / snapshots).
 */
export function waybackTileUrl(release) {
  return `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${release}/{z}/{y}/{x}`;
}
