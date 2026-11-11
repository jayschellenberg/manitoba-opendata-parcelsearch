// Unit Labels overlay — townhouse/condo unit labels (A-1, B-2 …), civic
// numbers and building footprints, as Manitoba Assessment Online's map shows
// them (Jason, 2026-11-11).
//
// MAO does not get these from assessment data. Its web map's only data layers
// are ROLL_ENTRY and the boundaries; the labels are part of its basemap, Esri
// Canada's "Streets – Community Map of Canada", which draws from the
// Canada_Topographic vector tile service below. Municipalities contribute
// their address points and footprints to Esri's Community Maps program, so
// coverage is town by town: Thompson has unit labels, many RMs have nothing.
//
// The tiles are public (no key). Labels only: the points carry no roll
// number, so nothing here is searchable or joins to the grid.
//
// Tile fields, as found 2026-11-11:
//   source-layer 'Site Address Point' — `_name1` (with `_label_class1`) holds
//     building/unit labels like "A-1"; `_name` (with `_label_class` 0) holds
//     civic numbers. Contributors code these differently, so both are drawn.
//   source-layer 'BuildingFootprint' — footprint polygons.
// The service publishes LODs 0-16; MapLibre overzooms z16 past that.

export const UNIT_LABELS_SOURCE = 'esri-canada-topo';
export const UNIT_LABELS_TILES =
  'https://tiles.arcgis.com/tiles/B6yKvIZqzuOr0jBR/arcgis/rest/services/Canada_Topographic/VectorTileServer/tile/{z}/{y}/{x}.pbf';
export const UNIT_LABEL_LAYERS = [
  'unit-footprint-fill',
  'unit-footprint-line',
  'unit-civic-label',
  'unit-label',
];

/** Esri's own minzoom for the civic numbers; any further out they pile up. */
const LABEL_MINZOOM = 17;
/** Unit letters (A-1 …) come in one step earlier: they are sparse, one per
 *  unit on a few sites, and are the reason the layer exists (Jason, 2026-11-11). */
const UNIT_LABEL_MINZOOM = 16;

/** Add the vector source and the (hidden) layers. `footprintBeforeId` slots
 *  the footprints under the app's overlays; the labels go on top. Hidden
 *  layers fetch no tiles, so this costs nothing until the toggle is on. */
export function addUnitLabelLayers(map, { footprintBeforeId } = {}) {
  if (map.getSource(UNIT_LABELS_SOURCE)) return;
  map.addSource(UNIT_LABELS_SOURCE, {
    type: 'vector',
    tiles: [UNIT_LABELS_TILES],
    minzoom: 0,
    maxzoom: 16,
    // Esri's attribution rule for its basemap content outside ArcGIS:
    // "Powered by Esri" plus the data providers. MapLibre shows this only
    // while a layer on the source is visible, and Capture Map copies the
    // live credit text into the image, so both carry it.
    attribution:
      'Unit labels &amp; footprints: <a href="https://www.esri.ca/en-ca/community-maps" target="_blank" rel="noreferrer">Esri Canada Community Maps</a>, municipal contributors | Powered by <a href="https://www.esri.com" target="_blank" rel="noreferrer">Esri</a>',
  });
  const before = footprintBeforeId && map.getLayer(footprintBeforeId) ? footprintBeforeId : undefined;
  map.addLayer({
    id: 'unit-footprint-fill',
    type: 'fill',
    source: UNIT_LABELS_SOURCE,
    'source-layer': 'BuildingFootprint',
    minzoom: 15,
    layout: { visibility: 'none' },
    paint: { 'fill-color': '#f5f0c8', 'fill-opacity': 0.75 },
  }, before);
  map.addLayer({
    id: 'unit-footprint-line',
    type: 'line',
    source: UNIT_LABELS_SOURCE,
    'source-layer': 'BuildingFootprint',
    minzoom: 15,
    layout: { visibility: 'none', 'line-join': 'round' },
    paint: { 'line-color': '#c8bd8f', 'line-width': 0.8 },
  }, before);
  const textLayout = {
    visibility: 'none',
    // The app's glyph server has no Regular stack; Semibold is what
    // every other label here uses.
    'text-font': ['Open Sans Semibold'],
    'text-size': ['interpolate', ['linear'], ['zoom'], 16, 8.5, 17, 10, 20, 13],
    'text-allow-overlap': false,
    'text-padding': 1,
  };
  // Thompson's points carry plain civic numbers in `_name1` as well as unit
  // letters, so "is it a number" is what splits the two layers: to-number
  // falls back to -1 for "A-1" or "24A", which then count as unit labels.
  const name1IsNumber = ['!=', ['to-number', ['get', '_name1'], -1], -1];
  // Civic numbers first, so a unit label wins a collision with one.
  map.addLayer({
    id: 'unit-civic-label',
    type: 'symbol',
    source: UNIT_LABELS_SOURCE,
    'source-layer': 'Site Address Point',
    minzoom: LABEL_MINZOOM,
    filter: ['any', ['has', '_name'], ['all', ['has', '_name1'], name1IsNumber]],
    layout: {
      ...textLayout,
      'text-field': ['to-string', ['coalesce', ['get', '_name'], ['get', '_name1']]],
    },
    paint: { 'text-color': '#7a7a7a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
  });
  map.addLayer({
    id: 'unit-label',
    type: 'symbol',
    source: UNIT_LABELS_SOURCE,
    'source-layer': 'Site Address Point',
    minzoom: UNIT_LABEL_MINZOOM,
    filter: ['all', ['has', '_name1'], ['!', name1IsNumber]],
    layout: {
      ...textLayout,
      'text-field': ['to-string', ['get', '_name1']],
      // A townhouse row's labels sit a few metres apart, so near z16
      // collision thins a row to every second unit (A-1, A-3, A-5); they fill
      // in a half-step closer. Allowing overlap was tried and overprints the
      // row into an unreadable smear, so culling it is.
      'text-padding': 0,
    },
    paint: { 'text-color': '#4b4b3a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
  });
}

export function setUnitLabelsVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of UNIT_LABEL_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}
