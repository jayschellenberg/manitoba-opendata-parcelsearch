// MapLibre GL JS map setup with a free CARTO Voyager basemap.
// No API key required.
//
// Three GeoJSON sources, three matched layer pairs (fill + outline):
//
//   devplan-fill / devplan-line   bottom layer; toggled off by default
//     paint coloured by DES_CATEGORY
//   zoning-fill  / zoning-line    above dev-plan; toggled off by default
//     paint coloured by ZONE_CATEGORY
//   parcel-fill  / parcel-line    primary highlight; always on
//     red fill, dark-red outline
//
// All three layers carry click handlers — clicking a parcel (always on
// top) scrolls the table to the matching row; clicking a zoning or dev-
// plan polygon while its overlay is visible pops up a small description.

import maplibregl from 'maplibre-gl';
import bbox from '@turf/bbox';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import turfArea from '@turf/area';
import turfLength from '@turf/length';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { landCoverBreakdown, LAND_COVER_MIN_ACRES } from './lib/landcover.js';
import { overlayGroupExpanded } from './lib/overlayToggle.js';
import { formatRollSizeField } from './lib/acres.js';
import {
  addShapeLayers,
  initShapeDraw,
  shapeClickHandled,
  isShapeDrawing,
} from './drawShapes.js';
import { WAYBACK_VERSIONS, waybackTileUrl } from './lib/wayback.js';
import { MB_PARCEL_DATA_CDN, currentAadt } from './arcgis.js';
import {
  MASC_PALETTE,
  MASC_RATING_LABEL_MIN_ZOOM,
  MASC_RISK_SOURCE_OPTIONS,
  masccolor,
  mascDisplayRating,
  mascTextColor,
} from './masc.js';
import { SOIL_SURVEY_MAP_SOURCE_OPTIONS } from './soilSurvey.js';
import { safeExternalUrl } from './lib/safeUrl.js';
import { createMuniPicker } from './lib/muniPicker.js';
import {
  badgeRadius,
  calloutOffset,
  solveCalloutSlots,
} from './lib/calloutPlacement.js';
import { Protocol as PMTilesProtocol } from 'pmtiles';

// mapbox-gl-draw was written against the Mapbox GL `mapboxgl-*` DOM
// class names; MapLibre uses `maplibregl-*`. Patch the lookup table
// before construction so the control mounts cleanly into MapLibre's
// control container (and inherits our `.maplibregl-ctrl-group` styling).
MapboxDraw.constants.classes.CANVAS         = 'maplibregl-canvas';
MapboxDraw.constants.classes.CONTROL_BASE   = 'maplibregl-ctrl';
MapboxDraw.constants.classes.CONTROL_PREFIX = 'maplibregl-ctrl-';
MapboxDraw.constants.classes.CONTROL_GROUP  = 'maplibregl-ctrl-group';
MapboxDraw.constants.classes.ATTRIBUTION    = 'maplibregl-ctrl-attrib';

// Register the pmtiles:// protocol so MapLibre can read the optional aerial
// ortho basemap from a single .pmtiles archive on Cloudflare R2 (see
// ORTHO_PMTILES_URL below). Idempotent, and harmless when no ortho is pinned.
maplibregl.addProtocol('pmtiles', new PMTilesProtocol().tile);

// Initial view focuses on populated south-central Manitoba — from the
// US border up to ~Grahamdale and from RM of Pipestone east to the
// Ontario line. The vast majority of parcels and appraisal work
// happens in this band; the user can scroll/zoom out to reach the
// northern LGDs when needed.
const MB_CENTER = [-98.0, 50.3];
const MB_ZOOM = 7;

// Callout colour — RGB 149,18,30 (#95121e), a deep red. White number on a
// red badge, with the leader line + anchor dot in the same red so the
// whole callout reads as one mark.
const PARCEL_NUM_COLOR = '#95121e';

/** Build a legend descriptor [{ label, color }] from a flat MapLibre
 *  match-expression palette ([key, color, key, color, ...]). De-dupes
 *  aliases (the source data has typos like "Residental"/"Residential"
 *  pointing at the same swatch — only show one entry per swatch). */
export function paletteLegendEntries(palette) {
  const seenColors = new Set();
  const entries = [];
  for (let i = 0; i < palette.length; i += 2) {
    const label = palette[i];
    const color = palette[i + 1];
    if (seenColors.has(color)) continue;
    seenColors.add(color);
    entries.push({ label, color });
  }
  return entries;
}

/** Stable HSL colour from a string. Same input always produces the same
 *  colour, so a zoning code (e.g. "C2") looks identical across sessions
 *  and across the paint expression / legend swatch. The hue spread is
 *  golden-ratio-derived so adjacent codes never collide. */
export function colorForZoneCode(code) {
  if (!code) return '#cccccc';
  let hash = 0;
  const s = String(code);
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  // Golden-ratio hue spacing keeps distinct codes well-separated.
  const hue = ((hash >>> 0) * 0.61803398875) % 1;
  return hslToHex(hue, 0.55, 0.72);
}
function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Build the [match-key, color, ...] pair list MapLibre needs for a
 *  per-feature zoning paint, given the zoning-overlay FC currently on
 *  screen. Returns { matchPairs, legend } where each legend entry
 *  includes both the ZONE code and the ZONE_NAME label found alongside
 *  it in the source data, sorted by code for predictable rendering. If
 *  the same ZONE has multiple distinct ZONE_NAME values across polygons
 *  (rare but it happens — historical bylaw wording drift), the most
 *  common one wins. */
export function buildZoneCodePaint(zoningFc) {
  // codeToNames: code → Map<name, count> — pick the most-frequent name.
  const codeToNames = new Map();
  for (const f of zoningFc?.features || []) {
    const code = (f.properties?.ZONE || '').trim();
    if (!code) continue;
    const name = (f.properties?.ZONE_NAME || '').trim();
    if (!codeToNames.has(code)) codeToNames.set(code, new Map());
    if (name) {
      const counts = codeToNames.get(code);
      counts.set(name, (counts.get(name) || 0) + 1);
    } else {
      codeToNames.get(code); // ensure the code is registered even without a name
    }
  }
  const sorted = [...codeToNames.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const matchPairs = [];
  const legend = [];
  for (const code of sorted) {
    const color = colorForZoneCode(code);
    const names = codeToNames.get(code);
    let bestName = '';
    let bestCount = 0;
    for (const [name, count] of names) {
      if (count > bestCount) { bestName = name; bestCount = count; }
    }
    matchPairs.push(code, color);
    legend.push({
      code,
      name: bestName,
      label: bestName ? `${code} – ${bestName}` : code,
      color,
    });
  }
  return { matchPairs, legend };
}

// Categorical fill colors keyed off ZONE_CATEGORY. The real Manitoba
// Zoning dataset uses a long-tailed vocabulary (~30 distinct values
// including a few obvious typos like "Residental" and "Settlement Center"
// alongside the official spellings, plus leading-space duplicates). All
// distinct values from a live distinct-values sweep are mapped here so
// nothing falls through to grey unless the source adds a brand-new
// category. Aliases are listed adjacent to the canonical key.
export const ZONING_PALETTE = [
  // Residential family — warm yellows.
  'Residential',          '#fff4a3',
  'Residental',           '#fff4a3', // typo in source data
  'Rural Residential',    '#d9c8a3',
  ' Rural Residential',   '#d9c8a3', // leading-space dup in source data
  'Rural/Agricultural',   '#dec99a',
  // Commercial — pinks/reds.
  'Commercial',           '#f08d8d',
  'Mixed',                '#c8a2c8',
  'Mixed Use',            '#c8a2c8',
  // Industrial — purples.
  'Industrial',           '#b5b0cc',
  // Agricultural — earthy greens/yellows.
  'Agricultural',         '#e0d596',
  'Agriculture',          '#e0d596',
  'Community Pasture',    '#d6e0a8',
  // Parks/Recreation/Open Space — greens.
  'Parks and Recreation', '#9ccc9c',
  'Recreation',           '#9ccc9c',
  'Recreational',         '#9ccc9c',
  'Open Space',           '#c8e0c8',
  'Public Reserve',       '#b8d8b8',
  'Reserve',              '#b8d8b8',
  'Provincial Park',      '#7bb37b',
  'Provincial Forest',    '#6fa86f',
  'National Park',        '#5e9d5e',
  'Wildlife Refuge',      '#8fbf8f',
  'WMA',                  '#8fbf8f',
  'Crown Land',           '#a8c8a8',
  // Institutional/Education — blues.
  'Institutional',        '#a3c4e8',
  'Education',            '#a3c4e8',
  // Settlement / Other — oranges/greys.
  'Settlement Centre',    '#ffab80',
  'Settlement Center',    '#ffab80',
  ' Settlement Centre',   '#ffab80',
  'Airport',              '#d0c0a8',
  'Development',          '#e8c8a0',
  'Dyke',                 '#c2bda3',
  'First Nations',        '#e0c8d4',
  'Other',                '#d3d3d3',
];

// Same idea for DES_CATEGORY. The dev-plan dataset's category vocabulary
// is shorter (~25 distinct values) but includes some unique-to-dev-plan
// labels like "Floodway" and "Overlay - Policy 3.6". Muted vs. zoning so
// when both overlays are toggled simultaneously the user can still tell
// them apart.
const DEVPLAN_PALETTE = [
  'Residential',                            '#ffe5b3',
  'Rural Residential',                      '#cdb89a',
  'Rural/Agricultural',                     '#c8c08a',
  'Commercial',                             '#e2a0a0',
  'Mixed Use',                              '#b69abe',
  'Urban',                                  '#dca490',
  'Industrial',                             '#a8a4c0',
  'Institutional',                          '#9bb3d2',
  'Parks, Recreation, and Open Space',      '#a3c8a3',
  'Provincial Park',                        '#7bb37b',
  'Provincial Forest',                      '#6fa86f',
  'Wildlife Management Area/Provincial Forest', '#8fbf8f',
  'WIldlife Management Area',               '#8fbf8f', // typo in source
  'Reserve Land',                           '#b8d8b8',
  'Reserve Lands',                          '#b8d8b8',
  'Community Pasture',                      '#d6e0a8',
  'First Nations',                          '#e0c8d4',
  'First Nations Land',                     '#e0c8d4',
  'Floodway',                               '#9fc8d6',
  'City of Winnipeg',                       '#cccccc',
  'Settlement Centre',                      '#ffba91',
  'Overlay',                                '#e8d8a0',
  'Overlay - Policy 3.6',                   '#e8d8a0',
  'Other',                                  '#d3d3d3',
];

// Two basemap sources stacked under one style — only one is visible at a
// time. Lets the user flip between the default light street map and an
// Esri-hosted aerial without re-creating the map. Esri World Imagery is
// free for non-commercial / appraisal-research use and requires no key.
const BASEMAP_STYLE = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    'carto-voyager': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        'https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
    'esri-imagery': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
    // Esri Wayback historical imagery. Same imagery archive as
    // esri-imagery, but a specific dated snapshot. Tiles are swapped in
    // place (RasterTileSource.setTiles) when the user picks a date, so
    // the source stays put. Starts on the newest curated MB release.
    'wayback': {
      type: 'raster',
      tiles: [waybackTileUrl(WAYBACK_VERSIONS[0].release)],
      tileSize: 256,
      attribution: 'Historical imagery &copy; Esri, Maxar, Earthstar Geographics (Esri Wayback)',
    },
    // Transparent reference overlay (place names, road names,
    // boundaries) designed by Esri to layer on top of aerial imagery.
    // Visible only when a labelled raster basemap is active; the basemap
    // menu flips it in lockstep. Keeps the Streets
    // basemap clean (CARTO Voyager already carries its own labels).
    'esri-reference': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Reference &copy; Esri',
    },
    'esri-transportation': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Transportation &copy; Esri',
    },
    'nrcan-elevation': {
      type: 'raster',
      tiles: [
        '/proxy/nrcan-elevation?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=false&f=image',
      ],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 19,
      attribution:
        'Elevation basemap &copy; Natural Resources Canada, Open Government Licence - Canada',
    },
    'nrcan-transportation-geometry': {
      type: 'raster',
      tiles: [
        'https://maps-cartes.services.geo.ca/server2_serveur2/rest/services/BaseMaps/CBMT_CBCT_GEOM_3857/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 15,
      attribution:
        'Canada Base Map &copy; Natural Resources Canada, <a href="https://open.canada.ca/en/open-government-licence-canada">Open Government Licence - Canada</a>',
    },
    'nrcan-transportation-labels': {
      type: 'raster',
      tiles: [
        'https://maps-cartes.services.geo.ca/server2_serveur2/rest/services/BaseMaps/CBMT_TXT_3857/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 15,
    },
    // Local static XYZ pyramid of the 2020 Manitoba land-cover raster,
    // produced by r/build_landcover_tiles.R. Drives the Land Cover
    // overlay's "Detailed" mode — pixel-level mosaic vs the per-parcel
    // "Dominant" fill from the JSON shards. Zoom range matches the
    // pyramid the script generates (z6-z12); MapLibre overzooms beyond
    // maxzoom by upscaling the z12 tile, which is fine for the 30 m
    // source raster (z12 already at ~38 m/pixel, so z13+ tiles wouldn't
    // add real detail). When the pyramid hasn't been built the tiles
    // 404 silently; the webapp probes manifest.json on init to gate the
    // Detailed tri-state branch off in that case.
    'landcover-raster': {
      type: 'raster',
      // Served from the mb-parcel-data CDN repo (pinned commit — see
      // MB_PARCEL_DATA_CDN in arcgis.js). MapLibre interpolates the
      // {z}/{x}/{y} template into per-tile WebP requests.
      tiles: [`${MB_PARCEL_DATA_CDN}/landcover-tiles/{z}/{x}/{y}.webp`],
      tileSize: 256,
      minzoom: 6,
      maxzoom: 12,
      attribution: 'Land cover &copy; Province of Manitoba (LCR_RCT_2020)',
    },
  },
  layers: [
    // Carto streets layer is the default basemap. Satellite (Esri
    // imagery + transportation/reference label overlays) starts
    // hidden; the basemap toggle in the top-right swaps them.
    // Explicit `visibility: 'visible' / 'none'` on every layer so
    // getLayoutProperty returns a real string on first click —
    // skipping the explicit default tripped a two-click toggle
    // bug because the initial undefined read inverted the swap.
    // CARTO Voyager is the streets basemap: roads are drawn with real
    // casings + colour (major roads stand out) and place-name labels stay
    // crisp — unlike Positron, whose pale roads washed out and couldn't be
    // recovered with a raster tweak (that adjusts roads and background
    // together). No raster paint needed; Voyager reads well as-is.
    { id: 'carto-voyager',      type: 'raster', source: 'carto-voyager',      minzoom: 0, maxzoom: 20, layout: { visibility: 'visible' } },
    { id: 'esri-imagery',        type: 'raster', source: 'esri-imagery',        minzoom: 0, maxzoom: 20, layout: { visibility: 'none' } },
    // Wayback historical imagery — sits directly above esri-imagery and
    // below the reference/transportation overlays so place names + roads
    // still draw on top of the dated aerial.
    { id: 'wayback-imagery',     type: 'raster', source: 'wayback',            minzoom: 0, maxzoom: 20, layout: { visibility: 'none' } },
    { id: 'nrcan-transportation-geometry', type: 'raster', source: 'nrcan-transportation-geometry', minzoom: 0, maxzoom: 24, layout: { visibility: 'none' } },
    { id: 'nrcan-elevation',     type: 'raster', source: 'nrcan-elevation',     minzoom: 0, maxzoom: 19, layout: { visibility: 'none' } },
    { id: 'esri-transportation', type: 'raster', source: 'esri-transportation', minzoom: 0, maxzoom: 20, layout: { visibility: 'none' } },
    { id: 'esri-reference',      type: 'raster', source: 'esri-reference',      minzoom: 0, maxzoom: 20, layout: { visibility: 'none' } },
    { id: 'nrcan-transportation-labels', type: 'raster', source: 'nrcan-transportation-labels', minzoom: 0, maxzoom: 24, layout: { visibility: 'none' } },
    // Land-cover raster sits above the basemap tiles but below every
    // data overlay (zoning, MASC, parcels, etc.) added by initMap, so
    // those overlays still paint cleanly on top. Default opacity 0.65 —
    // tunable via setLandCoverRasterOpacity. Hidden until the Land
    // Cover overlay enters "Detailed" mode.
    { id: 'landcover-raster',    type: 'raster', source: 'landcover-raster',    minzoom: 0, maxzoom: 20, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.65 } },
  ],
};

// Optional MLI historical aerial basemap. r/build_mli_ortho.ps1 produces the
// full southern-Manitoba archive locally; set VITE_MLI_ORTHO_PMTILES_URL after
// that archive is hosted. Until then, the built app omits only this menu row.
// The committed year polygons remain available for provenance and future UI.
export const MLI_ORTHO_YEAR_RANGE = '2007-2013';
const MLI_ORTHO_PMTILES_URL = import.meta.env?.VITE_MLI_ORTHO_PMTILES_URL || '';
const MLI_ORTHO_ATTRIBUTION =
  '&copy; 2001 Her Majesty the Queen in Right of Manitoba, as represented by the Minister of Conservation. All rights reserved. MLI imagery acquired 2007-2013.';
if (MLI_ORTHO_PMTILES_URL) {
  BASEMAP_STYLE.sources['ortho-mb'] = {
    type: 'raster',
    url: `pmtiles://${MLI_ORTHO_PMTILES_URL}`,
    tileSize: 256,
    attribution: MLI_ORTHO_ATTRIBUTION,
  };
  // Insert the ortho layer directly ABOVE the Esri imagery (which shows through
  // beyond the ortho's extent / when overzoomed) and BELOW the transparent Esri
  // label overlays, so place + road names stay legible over the ortho.
  const insertAt = BASEMAP_STYLE.layers.findIndex((l) => l.id === 'esri-transportation');
  BASEMAP_STYLE.layers.splice(insertAt < 0 ? BASEMAP_STYLE.layers.length : insertAt, 0, {
    id: 'ortho-mb', type: 'raster', source: 'ortho-mb', minzoom: 0, maxzoom: 22, layout: { visibility: 'none' },
  });
}

/**
 * True while the measurement panel is open. MeasureControl owns the
 * `measuring` class on <body> — the bottom-right map legends already
 * hide off it in CSS — so reading it back here keeps the hover tooltips
 * in step with the panel without a second flag to keep synchronised.
 */
function isMeasuring() {
  return document.body.classList.contains('measuring');
}

// mapbox-gl-draw style spec for the measurement tool. High-contrast orange
// (#ff4d00) reads cleanly on both the cream CARTO Voyager streets basemap
// and the dark Esri imagery; white halo around each vertex keeps the
// click-targets visible on busy basemaps. Filters intentionally do NOT
// split active/inactive — keeping a single style per geometry kind
// avoids the rendering gap we saw with the default theme on MapLibre 4.
const MEASURE_DRAW_COLOR = '#ff4d00';
const MEASURE_DRAW_STYLES = [
  // Polygon fill (translucent so the underlying basemap reads through).
  {
    id: 'gl-draw-polygon-fill',
    type: 'fill',
    filter: ['all', ['==', '$type', 'Polygon']],
    paint: {
      'fill-color': MEASURE_DRAW_COLOR,
      'fill-outline-color': MEASURE_DRAW_COLOR,
      'fill-opacity': 0.18,
    },
  },
  // Polygon outline (the in-progress closing edge).
  {
    id: 'gl-draw-polygon-stroke',
    type: 'line',
    filter: ['all', ['==', '$type', 'Polygon']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': MEASURE_DRAW_COLOR, 'line-width': 2 },
  },
  // Line (the polyline being measured).
  {
    id: 'gl-draw-line',
    type: 'line',
    filter: ['all', ['==', '$type', 'LineString']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': MEASURE_DRAW_COLOR, 'line-width': 2 },
  },
  // Vertex halo — white ring under the orange dot so the vertex stays
  // visible on dark satellite tiles.
  {
    id: 'gl-draw-vertex-halo',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']],
    paint: {
      'circle-radius': 6,
      'circle-color': '#fff',
      'circle-stroke-width': 1,
      'circle-stroke-color': MEASURE_DRAW_COLOR,
    },
  },
  // Vertex dot — solid orange centre.
  {
    id: 'gl-draw-vertex',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']],
    paint: { 'circle-radius': 3.5, 'circle-color': MEASURE_DRAW_COLOR },
  },
  // Midpoint (smaller faded dot at each segment midpoint — lets the user
  // drag-to-insert a new vertex on completed shapes).
  {
    id: 'gl-draw-midpoint',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'midpoint'], ['==', '$type', 'Point']],
    paint: {
      'circle-radius': 3,
      'circle-color': MEASURE_DRAW_COLOR,
      'circle-opacity': 0.55,
    },
  },
];

/**
 * `parcel-fill`'s normal yellow opacity, hoisted so the water overlay can
 * suppress it and put it back byte-for-byte. Starred favourites 0.6, a
 * sale-group hover 0.5, otherwise 0.3.
 */
const PARCEL_FILL_OPACITY = [
  'case',
  ['boolean', ['feature-state', 'starred'], false],
  0.6,
  ['boolean', ['feature-state', 'groupHover'], false],
  0.5,
  0.3,
];

export function initMap(container, { onFeatureClick } = {}) {
  const map = new maplibregl.Map({
    container,
    style: BASEMAP_STYLE,
    center: MB_CENTER,
    zoom: MB_ZOOM,
    attributionControl: { compact: true },
    // preserveDrawingBuffer keeps the WebGL framebuffer readable so
    // canvas.toDataURL() works for the "Generate Static Map" feature.
    // Small perf cost on continuous interaction; fine for our scale.
    preserveDrawingBuffer: true,
  });
  // Expose for runtime debugging in any environment.
  window._map = map;

  map.on('error', (e) => console.error('[map error]', e?.error?.message || e, e));
  // Custom zoom buttons with a finer step than NavigationControl's fixed
  // ±1 (see FineZoomControl). Compass was already disabled, so nothing
  // from the stock control is lost by replacing it outright.
  map.addControl(new FineZoomControl(), 'top-right');
  map.addControl(new BasemapMenuControl(), 'top-right');
  // Distance / area measurement tool. mapbox-gl-draw owns the drawing
  // state and renders the in-progress line/polygon; MeasureControl wraps
  // it in a small panel that exposes the mode switch and live readout.
  // Explicit styles array: mapbox-gl-draw's default theme has gaps in
  // MapLibre 4.x — the active-vs-inactive filter splits silently fail to
  // render the in-progress vertex/line layers, so the geometry looks like
  // it disappears between clicks. A single set of unfiltered styles (one
  // per geometry kind) sidesteps the issue and keeps the visible shape
  // consistent across all draw modes.
  const measureDraw = new MapboxDraw({
    displayControlsDefault: false,
    controls: {},
    styles: MEASURE_DRAW_STYLES,
  });
  map.addControl(measureDraw);
  map.addControl(new MeasureControl(measureDraw), 'top-right');
  // Area-selection shape tools (radius / rectangle / polygon +
  // include/exclude). The buttons live in the TOPBAR next to
  // Hide/Expand Map; this binds them plus the map draw events.
  // Sales-mode only via CSS; see drawShapes.js.
  initShapeDraw(map);

  const ready = new Promise((resolve) => {
    // Setup runs once. Three triggers race: 'load', the first 'idle',
    // and a polled fallback that fires once the style reports loaded.
    // Some MapLibre 4.x builds + container-resize scenarios delay or
    // skip 'load' entirely; the multi-trigger guard keeps mapReady
    // from hanging the overlay toggles.
    let setupDone = false;
    const setupMap = () => {
      if (setupDone) return;
      setupDone = true;
      try {
      // Municipal boundaries — a stable reference layer that's on by
      // default. Drawn first so every other overlay (zoning, dev-plan,
      // muni parcels, search results) renders above. Light grey fill
      // with subtle dark-grey outline; readable on both Streets and
      // Satellite without competing with the data layers.
      map.addSource('muni-boundaries', { type: 'geojson', data: emptyFc() });
      // Hit-test surface for the Property Search muni picker. Fully
      // transparent by default — this is a click target, not a visible
      // layer — and lifts to a whisper of blue under the cursor so the
      // municipality about to be picked reads before the click lands.
      // Added BEFORE the outline so the outline always draws over it,
      // and it sits at the very bottom of the stack, so it never takes
      // a click away from a parcel or an overlay above it.
      map.addLayer({
        id: 'muni-boundaries-fill',
        type: 'fill',
        source: 'muni-boundaries',
        paint: {
          'fill-color': '#1d4ed8',
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false], 0.06,
            0,
          ],
        },
      });
      map.addLayer({
        id: 'muni-boundaries-line',
        type: 'line',
        source: 'muni-boundaries',
        paint: {
          // The selected municipality carries a strong blue outline —
          // the same treatment the Sales Analysis picker uses, so the
          // two tabs say "selected" the same way. Outline only: a fill
          // tint would wash over the parcels being read.
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'selected'], false], '#1d4ed8',
            '#555',
          ],
          // interpolate OUTSIDE, case inside each stop: a ['zoom']
          // expression may only be the input to a top-level interpolate /
          // step, so nesting the zoom ramp inside the case is a style
          // validation error rather than a fallback. The selected muni
          // keeps a ramp of its own so it stays findable zoomed out
          // without going clumsy at street level.
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            5,  ['case', ['boolean', ['feature-state', 'selected'], false], 1.8, 0.5],
            10, ['case', ['boolean', ['feature-state', 'selected'], false], 2.4, 1.0],
            14, ['case', ['boolean', ['feature-state', 'selected'], false], 3.0, 1.4],
          ],
          'line-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false], 1,
            0.55,
          ],
        },
      });
      map.addLayer({
        id: 'muni-boundaries-label',
        type: 'symbol',
        source: 'muni-boundaries',
        minzoom: 7,
        maxzoom: 12,
        layout: {
          'text-field': ['get', 'MUNI_NAME'],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            7, 9,
            10, 11,
            12, 12,
          ],
          'symbol-placement': 'point',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#333',
          'text-halo-color': '#fff',
          'text-halo-width': 1.4,
        },
      });

      // Dev-plan overlay (bottom). Source starts empty; main.js populates it
      // after each search. Hidden until the user toggles it on.
      map.addSource('devplan', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'devplan-fill',
        type: 'fill',
        source: 'devplan',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': ['match', ['get', 'DES_CATEGORY'], ...DEVPLAN_PALETTE, '#cccccc'],
          'fill-opacity': 0.40,
          'fill-outline-color': '#555',
        },
      });
      map.addLayer({
        id: 'devplan-line',
        type: 'line',
        source: 'devplan',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#444', 'line-width': 0.6, 'line-opacity': 0.6 },
      });
      // Dev-plan label — DES_NAME at each polygon centroid. Designation
      // names tend to be longer than zoning ZONE codes (e.g. "Park,
      // Institution, and Open Space Area") so we render slightly later
      // than the zoning-label layer to avoid clutter at province-wide
      // zooms, and use line-wrap so multi-word names break instead of
      // overflowing the polygon. Collision detection is on so adjacent
      // polygons don't pile labels on top of each other; text-allow-
      // overlap is false but text-ignore-placement is true so the dev-
      // plan label can coexist with parcel / zoning labels at the same
      // anchor without one suppressing the other.
      map.addLayer({
        id: 'devplan-label',
        type: 'symbol',
        source: 'devplan',
        minzoom: 8,
        layout: {
          visibility: 'none',
          'text-field': ['coalesce', ['get', 'DES_NAME'], ['get', 'DES_CATEGORY'], ''],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            8, 10,
            12, 12,
            15, 13,
          ],
          'text-max-width': 9,
          // Always render — the muni-parcels roll-number label was
          // previously winning the collision and suppressing this one
          // when both layers were on. Pairs with the roll-number
          // label's semi-transparent paint above so designation names
          // visually dominate where they overlap.
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#1a3a4a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.2,
        },
      });

      // Zoning overlay (above dev-plan, below parcels).
      map.addSource('zoning', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'zoning-fill',
        type: 'fill',
        source: 'zoning',
        layout: { visibility: 'none' },
        paint: {
          // Seed paint reads ZONE; the real per-search match-expression is
          // pushed in by main.js via setZoningPaint() once we know which
          // codes are on screen. Until then everything renders grey.
          'fill-color': '#cccccc',
          'fill-opacity': 0.45,
          'fill-outline-color': '#444',
        },
      });
      map.addLayer({
        id: 'zoning-line',
        type: 'line',
        source: 'zoning',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#333', 'line-width': 0.6, 'line-opacity': 0.7 },
      });
      map.addLayer({
        id: 'zoning-label',
        type: 'symbol',
        source: 'zoning',
        layout: {
          visibility: 'none',
          'text-field': [
            'case',
            ['<=', ['length', ['coalesce', ['get', 'ZONE'], '']], 6],
            ['get', 'ZONE'],
            '',
          ],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            13, 12,
            14, 13,
            17, 14,
            19, 15,
          ],
          // Always render the zoning code — never suppress it because a
          // parcel roll-number label landed on the same pixel. Combined
          // with the upward text-offset below, this lets the code sit
          // visibly above the roll number rather than stacking on top
          // of it or being silently dropped by the collision system.
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          // Anchor at the bottom of the text and shift it well above
          // the polygon centroid so the zoning code clears the roll-
          // number label below (which renders centered on each parcel
          // centroid in muni-parcels-label). Negative-y in em units;
          // -1.2 em ≈ 13 px gap above the centroid before the text.
          'text-anchor': 'bottom',
          'text-offset': [0, -1.2],
        },
        paint: { 'text-color': '#1a1a1a', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
      });

      // Contaminated-sites overlay — point layer above zoning/dev-plan but
      // below the parcel highlight so a search result still wins. Coloured
      // by CSGROUP: red = Designated Contaminated, orange = Designated
      // Impacted, grey = Not Designated. Hidden until the user toggles it.
      map.addSource('contam', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'contam-circle',
        type: 'circle',
        source: 'contam',
        layout: { visibility: 'none' },
        paint: {
          // Sized to be findable, not just present: these sites are the
          // point of turning the overlay on, and a fixed 6 px dot
          // vanished against satellite imagery at municipal zooms. Ramp
          // rather than a bigger constant so close-in the dot doesn't
          // swallow the parcel it flags.
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            8,  8,
            12, 11,
            16, 15,
          ],
          'circle-color': [
            'match', ['get', 'CSGROUP'],
            'Designated Contaminated Site', '#c0392b',
            'Designated Impacted Site',     '#e67e22',
            '#7f8c8d', // Not Designated / unknown
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fff',
          'circle-opacity': 0.9,
        },
      });

      // MHTIS Traffic Flow polylines coloured by AADT volume. Drawn under
      // the station points so the points still pop out when both are on.
      // The colour breaks roughly match MHTIS's own flow-map convention
      // (light → green → yellow → orange → red → dark red as AADT climbs).
      map.addSource('traffic-flow', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'traffic-flow-line',
        type: 'line',
        source: 'traffic-flow',
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          // AADT_2023 first: the MHTIS 2023 layer keeps a stale carried-forward
          // `AADT` alongside the current count, so reading the obvious field
          // name would paint the overlay with several-year-old volumes. Mirrors
          // currentAadt() in arcgis.js — keep the two in step. Coalesce picks
          // the first non-null BEFORE to-number, so an absent AADT_2023 falls
          // through rather than being coerced to 0 and winning.
          'line-color': [
            'step', ['to-number', ['coalesce', ['get', 'AADT_2023'], ['get', 'AADT'], 0]],
            '#cccccc',
            500,    '#a8d8a8',
            2000,   '#f4d35e',
            5000,   '#ee964b',
            10000,  '#d62828',
            25000,  '#6d191b',
          ],
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            6, 1.5,
            10, 3,
            14, 5,
          ],
          'line-opacity': 0.85,
        },
      });

      // AADT label rendered along each flow segment so the numbers are
      // legible without clicking. Symbol-along-line placement keeps the
      // text following the road; minzoom prevents the labels from
      // shotgunning the map at province-wide zoom levels (where most
      // segments would just stack on top of each other).
      map.addLayer({
        id: 'traffic-flow-label',
        type: 'symbol',
        source: 'traffic-flow',
        minzoom: 8,
        layout: {
          visibility: 'none',
          'text-field': ['to-string', ['coalesce', ['get', 'AADT_2023'], ['get', 'AADT'], '']],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            8, 9,
            12, 11,
            14, 13,
          ],
          'symbol-placement': 'line',
          'symbol-spacing': 220,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-pitch-alignment': 'viewport',
          'text-rotation-alignment': 'map',
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.6,
        },
      });

      // Complete provincial road network, current to 2023. This remains a
      // separate overlay so Manitoba route geometry can be combined with
      // Satellite or MLI imagery as well as any other basemap.
      map.addSource('mb-highways', {
        type: 'geojson',
        data: emptyFc(),
        attribution: 'Road network &copy; Government of Manitoba (2023)',
      });
      map.addLayer({
        id: 'mb-highways-casing',
        type: 'line',
        source: 'mb-highways',
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': 'rgba(255,255,255,0.92)',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            5, ['match', ['get', 'RteType'], '-PTH', 2.4, '-PR', 1.9, 1.2],
            11, ['match', ['get', 'RteType'], '-PTH', 6.5, '-PR', 5, 3.2],
            15, ['match', ['get', 'RteType'], '-PTH', 10, '-PR', 8, 5],
          ],
          'line-opacity': 0.9,
        },
      });
      map.addLayer({
        id: 'mb-highways-line',
        type: 'line',
        source: 'mb-highways',
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match', ['get', 'RteType'],
            '-PTH', '#c83e32',
            '-PR', '#d18a00',
            '-ACCESS', '#476b87',
            '-WR', '#1684a5',
            '-SVCRD', '#66737c',
            '-RAMP', '#8f5e42',
            '-LOOP', '#8f5e42',
            '-RTCO', '#8f5e42',
            '#7a858d',
          ],
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            5, ['match', ['get', 'RteType'], '-PTH', 1.4, '-PR', 1.1, 0.7],
            11, ['match', ['get', 'RteType'], '-PTH', 4.5, '-PR', 3.4, 2],
            15, ['match', ['get', 'RteType'], '-PTH', 7, '-PR', 5.5, 3.2],
          ],
          'line-opacity': 0.94,
        },
      });
      map.addLayer({
        id: 'mb-highways-label',
        type: 'symbol',
        source: 'mb-highways',
        minzoom: 7,
        filter: ['in', ['get', 'RteType'], ['literal', ['-PTH', '-PR']]],
        layout: {
          visibility: 'none',
          'symbol-placement': 'line',
          'symbol-spacing': 300,
          'text-field': [
            'concat',
            ['match', ['get', 'RteType'], '-PTH', 'PTH ', '-PR', 'PR ', ''],
            ['to-string', ['coalesce', ['get', 'CommonRoadName_004'], '']],
          ],
          'text-font': ['Open Sans Semibold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10, 12, 12, 15, 14],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-pitch-alignment': 'viewport',
          'text-rotation-alignment': 'map',
        },
        paint: {
          'text-color': '#23282c',
          'text-halo-color': 'rgba(255,255,255,0.96)',
          'text-halo-width': 1.8,
        },
      });

      // MHTIS traffic-count station locations. Small dark dot with a yellow
      // ring — distinct from the contam circles so both can be visible
      // simultaneously without confusion.
      map.addSource('traffic', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'traffic-circle',
        type: 'circle',
        source: 'traffic',
        layout: { visibility: 'none' },
        paint: {
          // Same zoom-graduated sizing as contam-circle (slightly
          // smaller so the two stay tellable-apart when both are on):
          // a fixed 5 px station dot disappeared against satellite
          // imagery at municipal zooms.
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            8,  7,
            12, 10,
            16, 13,
          ],
          'circle-color': '#1a3a4a',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffd166',
          'circle-opacity': 0.95,
        },
      });

      // MASC soil-rating overlay — quarter-section polygons coloured by
      // rating (A → J). Polygons are constructed client-side from the
      // MASC CSV shard's lat/lon centroids (see masc.js). The fill
      // expression matches against the rating code; any unrecognized
      // value falls through to neutral grey. Hidden until the user
      // toggles it on with a muni selected.
      map.addSource('masc', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'masc-fill',
        type: 'fill',
        source: 'masc',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': [
            'match', ['get', 'rating'],
            // A→J palette — single source in masc.js (see mascPalette.test.js
            // which pins this exact spread byte-for-byte).
            ...MASC_PALETTE,
            '#cccccc',
          ],
          'fill-opacity': 0.35,
          'fill-outline-color': 'rgba(0, 0, 0, 0.3)',
        },
      });

      // MASC ratings on river-lot polygons. The quarter-section CSV
      // doesn't cover river lots, so we ship a separately-built
      // GeoJSON of rated KMZ polygons (built by build_parcel_masc.R
      // from the join of MB-RIVER-LOTS.kmz × masc_soil_ratings_
      // riverlots.csv). Same A→J palette as the quarter-section
      // squares so the two sources read as one overlay; visibility
      // toggles together via setMascVisible().
      map.addSource('masc-riverlots', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'masc-riverlots-fill',
        type: 'fill',
        source: 'masc-riverlots',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': [
            'match', ['get', 'rating'],
            // A→J palette — single source in masc.js (see mascPalette.test.js
            // which pins this exact spread byte-for-byte).
            ...MASC_PALETTE,
            '#cccccc',
          ],
          'fill-opacity': 0.35,
          'fill-outline-color': 'rgba(0, 0, 0, 0.3)',
        },
      });
      map.addLayer({
        id: 'masc-riverlots-label',
        type: 'symbol',
        source: 'masc-riverlots',
        minzoom: MASC_RATING_LABEL_MIN_ZOOM,
        layout: {
          visibility: 'none',
          'text-field': ['coalesce', ['get', 'ratings'], ['get', 'rating'], ''],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            13, 11, 16, 14, 18, 16,
          ],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });

      // Official MASC Risk Areas. Separate from the soil-rating quarters:
      // Risk_Area comes from the Manitoba Maps MASC_Risk_Areas polygon
      // layer, not from the compact `ra` field in the soil CSV shard.
      map.addSource('masc-risk-areas', {
        type: 'geojson',
        data: emptyFc(),
        ...MASC_RISK_SOURCE_OPTIONS,
      });
      map.addLayer({
        id: 'masc-risk-area-fill',
        type: 'fill',
        source: 'masc-risk-areas',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': [
            'match', ['get', 'Risk_Area'],
            '1', '#8dd3c7',
            '2', '#ffffb3',
            '3', '#bebada',
            '4', '#fb8072',
            '5', '#80b1d3',
            '6', '#fdb462',
            '7', '#b3de69',
            '8', '#fccde5',
            '9', '#d9d9d9',
            '10', '#bc80bd',
            '11', '#ccebc5',
            '12', '#ffed6f',
            '14', '#9ecae1',
            '15', '#fdae6b',
            '16', '#a1d99b',
            '#dddddd',
          ],
          'fill-opacity': 0.08,
        },
      });
      map.addLayer({
        id: 'masc-risk-area-line',
        type: 'line',
        source: 'masc-risk-areas',
        layout: { visibility: 'none', 'line-join': 'round' },
        paint: {
          'line-color': '#111827',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            5, 0.8,
            9, 1.4,
            13, 2.2,
          ],
          'line-opacity': 0.75,
        },
      });

      // ---- WALLAS water rights (see src/wallas.js) ----
      // Three independently-toggled layers, all licensed records only.
      // Cyan family throughout so they read as one group against the
      // greens/browns the agricultural overlays own.

      // Licensed tile-drainage areas — the field footprint applied for.
      // Fill sits low-opacity so the parcel fabric, MASC rating, and land
      // cover underneath all stay legible through it; the outline carries
      // the actual boundary.
      map.addSource('wallas-tile', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'wallas-tile-fill',
        type: 'fill',
        source: 'wallas-tile',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#06b6d4', 'fill-opacity': 0.22 },
      });
      map.addLayer({
        id: 'wallas-tile-line',
        type: 'line',
        source: 'wallas-tile',
        layout: { visibility: 'none', 'line-join': 'round' },
        paint: {
          'line-color': '#0e7490',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            6, 0.8,
            11, 1.8,
            15, 2.6,
          ],
        },
      });
      map.addLayer({
        id: 'wallas-tile-label',
        type: 'symbol',
        source: 'wallas-tile',
        // Below this the footprints are too small to hang a licence
        // number off without the labels colliding into noise.
        minzoom: 11,
        layout: {
          visibility: 'none',
          'text-field': ['coalesce', ['get', 'LICENCE_NO'], 'Tile drainage'],
          'text-font': ['Open Sans Semibold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 15, 13],
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#155e75',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.8,
        },
      });

      // The tile network itself — lateral/header runs and their outlets.
      // Viewport-scoped (85k lines province-wide), so main.js refetches
      // these on map idle while the layer is on.
      map.addSource('wallas-tile-network', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'wallas-tile-network-line',
        type: 'line',
        source: 'wallas-tile-network',
        layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#0891b2',
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 14, 1.2, 17, 2],
          'line-opacity': 0.85,
        },
      });
      map.addSource('wallas-tile-outlets', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'wallas-tile-outlet-point',
        type: 'circle',
        source: 'wallas-tile-outlets',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 15, 5],
          'circle-color': '#164e63',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
        },
      });

      // Licensed irrigation. Point of Diversion (where water is taken)
      // and Point of Use (where it's applied) share one source and split
      // on _wallasKind, stamped in wallas.js — they're two halves of the
      // same licence and the user reads them together.
      map.addSource('wallas-irrigation', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'wallas-irrigation-fill',
        type: 'fill',
        source: 'wallas-irrigation',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': [
            'match', ['get', '_wallasKind'],
            'diversion', '#2563eb',
            'use', '#7c3aed',
            '#2563eb',
          ],
          'fill-opacity': 0.25,
        },
      });
      map.addLayer({
        id: 'wallas-irrigation-line',
        type: 'line',
        source: 'wallas-irrigation',
        layout: { visibility: 'none', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match', ['get', '_wallasKind'],
            'diversion', '#1d4ed8',
            'use', '#6d28d9',
            '#1d4ed8',
          ],
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 13, 1.6],
        },
      });

      // Canada Land Inventory — Soil Capability for Agriculture.
      // Federal AAFC dataset rated 1 (best) to 7 (worst). Painted by
      // CLASS_A (the dominant class for the polygon). Subclass codes
      // (W=excess water, T=topography, F=low fertility, etc.) come
      // along on the feature for popup/tooltip use. Hidden until the
      // user toggles it on with a muni selected.
      // CLI Soil Capability — painted by the first character of
      // AGCAP_CLS1 (Manitoba Soil_Survey_MB's agricultural-capability
      // class for the dominant soil). Distinct values: "1"-"7" (the
      // standard CLI scale), "O3"-"O7" (organic soils, class implied
      // by the digit), "$ML"/"$UL"/"$UR"/"$ZZ" (mineral landscape,
      // urban, urban-residential, water — no agricultural rating).
      //
      // Source switched from AAFC's federal cli_agr_cap_250k to
      // Manitoba's Soil_Survey_MB on 2026-05-20 (per AgriMaps'
      // authoritative source). See arcgis.js fetchCliAgrForMuni for
      // the source-switch context.
      map.addSource('cli-agr', {
        type: 'geojson',
        data: emptyFc(),
        ...SOIL_SURVEY_MAP_SOURCE_OPTIONS,
      });
      map.addLayer({
        id: 'cli-agr-fill',
        type: 'fill',
        source: 'cli-agr',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': [
            'match',
            ['slice', ['coalesce', ['get', 'AGCAP_CLS1'], '?'], 0, 1],
            '1', '#1a6b26',  // dark green   — prime
            '2', '#4fab57',  // medium green — minor limitations
            '3', '#a6e29f',  // light green  — moderate
            '4', '#f2d640',  // yellow       — severe / marginal
            '5', '#f4a040',  // orange       — perennial only
            '6', '#a8754f',  // brown        — native pasture only
            '7', '#9c27b0',  // purple       — no agricultural capability
            'O', '#5e3b1a',  // dark brown   — organic (O3-O7)
            '$', '#cfd6dd',  // pale slate   — urban / water specials
            '#cccccc',       // fallback — AGCAP_CLS1 missing
          ],
          'fill-opacity': 0.35,
          'fill-outline-color': 'rgba(0, 0, 0, 0.25)',
        },
      });
      map.addLayer({
        id: 'cli-agr-label',
        type: 'symbol',
        source: 'cli-agr',
        minzoom: 11,
        layout: {
          visibility: 'none',
          // AGRI_CAP1 already concatenates class + subclass (e.g.
          // "2W", "3MT", "O5") so we use it directly rather than
          // assembling pieces. Helps appraisers read the map without
          // clicking each polygon.
          'text-field': ['coalesce', ['get', 'AGRI_CAP1'], ''],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            11, 10, 14, 12, 17, 14,
          ],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.4,
        },
      });

      // Manitoba Soil Survey — provincial soil-association polygons.
      // Painted by `_paintColor`, which main.js's
      // applySoilSurveyPalette() stamps onto each polygon based on
      // its SOIL_CODE1's area-rank within the loaded muni. This makes
      // Soil Survey a soil-IDENTITY layer (Red River vs Osborne vs
      // Scanterbury at a glance) rather than a duplicate of the CLI
      // overlay's 1=prime → 7=no-capability scale. The capability
      // rating is still surfaced in the polygon-click popup as text
      // alongside each soil's name; the colour is just about identity.
      //
      // The initial expression below is a placeholder ('#bfbfbf' for
      // everything) — there's no data until the user toggles the
      // overlay on, at which point applySoilSurveyPalette overwrites
      // this via setPaintProperty.
      //
      // Companion 'soil-survey-labels' source carries point centroids
      // for the MAPUNITNOM symbol layer, rendered alongside the fill
      // so the user can read the soil-unit symbol without clicking.
      map.addSource('soil-survey', {
        type: 'geojson',
        data: emptyFc(),
        ...SOIL_SURVEY_MAP_SOURCE_OPTIONS,
      });
      map.addLayer({
        id: 'soil-survey-fill',
        type: 'fill',
        source: 'soil-survey',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': ['coalesce', ['get', '_paintColor'], '#bfbfbf'],
          'fill-opacity': 0.5,
          'fill-outline-color': 'rgba(0, 0, 0, 0.3)',
        },
      });
      // Label source kept (unused now but the setSoilSurveyLabelsData
      // setter still pushes to it) so any external code that still
      // references this source ID doesn't break. The label LAYER now
      // reads directly from the polygon source — MapLibre auto-derives
      // a placement point per polygon, which saves the ~5K-feature
      // labels-FeatureServer fetch (parallel to the polygon fetch,
      // doubling network time on a busy muni like St Clements).
      map.addSource('soil-survey-labels', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'soil-survey-label',
        type: 'symbol',
        source: 'soil-survey',
        minzoom: 11,
        layout: {
          visibility: 'none',
          // MAPUNITNOM is the Manitoba Soil Survey unit symbol that
          // appears on the printed soil maps (e.g. "ALMv-S2").
          'text-field': ['coalesce', ['get', 'MAPUNITNOM'], ''],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            11, 9, 14, 11, 17, 13,
          ],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.4,
        },
      });

      // Section-township grid — line layer derived from the
      // MB_LegalDesc point centroids by aggregating quarters into
      // section bounding boxes (see masc.js sectionLinesFromRows).
      // Lines only; the grid sits visually above zoning/dev-plan
      // overlays but below the muni-parcels and search-result layers.
      map.addSource('survey-grid', { type: 'geojson', data: emptyFc() });
      // Separate Point source for the section-grid LABEL layer. The
      // line layer above stays on the polygon source (for outlines).
      // The label layer needs Point geometry because MapLibre's
      // symbol-placement:'point' on large Polygons clips per vector
      // tile and renders one label PER TILE the polygon spans —
      // sections at zoom 16+ span 2-4 tiles, producing 2-4 visible
      // labels for the same feature. Pre-computed centroid points
      // sidestep the clip entirely (a Point is in exactly one tile).
      map.addSource('survey-grid-points', { type: 'geojson', data: emptyFc() });
      // Section-grid lines (DLS): grey dashed. The MapLibre line-dasharray
      // paint property doesn't accept a per-feature `case` expression, so
      // sections and river lots must live on separate layers — same source,
      // different kind filter, different paint.
      map.addLayer({
        id: 'survey-grid-line',
        type: 'line',
        source: 'survey-grid',
        filter: ['!=', ['get', 'kind'], 'riverlot'],
        layout: { visibility: 'none', 'line-cap': 'square' },
        paint: {
          'line-color': '#444',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            8,  0.4,
            12, 0.9,
            16, 1.4,
          ],
          'line-opacity': 0.7,
          'line-dasharray': [4, 3],
        },
      });
      // River lots match the section grid paint exactly — same dark
      // grey dashed stroke, same zoom ramp, same opacity. Kept as a
      // separate filtered layer (filter on kind === 'riverlot') so
      // either lot type can diverge later without touching the other.
      map.addLayer({
        id: 'survey-grid-riverlot',
        type: 'line',
        source: 'survey-grid',
        filter: ['==', ['get', 'kind'], 'riverlot'],
        layout: { visibility: 'none', 'line-cap': 'square' },
        paint: {
          'line-color': '#444',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            8,  0.4,
            12, 0.9,
            16, 1.4,
          ],
          'line-opacity': 0.7,
          'line-dasharray': [4, 3],
        },
      });
      map.addLayer({
        id: 'survey-grid-label',
        type: 'symbol',
        // Read from the dedicated Point source — see survey-grid-points
        // comment above for why. River-lot features never enter that
        // source, so the kind!=riverlot filter from the previous setup
        // is no longer needed.
        source: 'survey-grid-points',
        minzoom: 11,
        layout: {
          visibility: 'none',
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            11, 11,
            14, 13,
            17, 15,
          ],
          'text-allow-overlap': false,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#333',
          'text-halo-color': '#fff',
          'text-halo-width': 1.2,
        },
      });

      // Muni-wide parcel fabric — every Roll_Entry parcel in the selected
      // municipality, rendered in muted grey under the search-result
      // parcels. Toggleable; off by default since fetching can take a few
      // seconds for big RMs. Lets the user see the surrounding parcel
      // pattern without filtering every search to that level of detail.
      map.addSource('muni-parcels', { type: 'geojson', data: emptyFc() });
      // Parallel Point source carrying one feature per parcel at its
      // bbox-midpoint centroid. The label symbol layers below use THIS
      // source instead of muni-parcels (the Polygon source) because
      // MapLibre's GeoJSON tile clipper treats each tile-clipped polygon
      // fragment as a separate symbol-placement candidate. Without the
      // Point source, a polygon that crosses internal tile boundaries
      // gets its roll/civic labels rendered 2-6× — once per fragment —
      // at high zoom. Point features render exactly once.
      map.addSource('muni-parcels-labels', { type: 'geojson', data: emptyFc() });
      // Light shading so the muni's parcel fabric reads at a glance on
      // either basemap. Cool light-blue is neutral against the cream
      // CARTO streets and the dark Esri imagery, and the moderate alpha
      // lets the basemap show through without looking washed-out.
      // Outline does the precise per-parcel definition — royal blue
      // contrasts cleanly against both basemaps without competing with
      // the search-result red on top.
      map.addLayer({
        id: 'muni-parcels-fill',
        type: 'fill',
        source: 'muni-parcels',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#6b7280', 'fill-opacity': 0.04 },
      });
      // Land-cover choropleth on the muni-wide fabric — colours every parcel
      // in the selected municipality by its dominant 2020 land-cover bucket
      // (driven by `_lcColor`, stamped in main.js from the land-cover shard;
      // parcels below the threshold or with no data draw nothing). Hidden until the Land
      // Cover overlay is on. Added before the lines/labels so boundaries and
      // roll numbers still read on top of the fill.
      map.addLayer({
        id: 'muni-parcels-landcover-fill',
        type: 'fill',
        source: 'muni-parcels',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': ['coalesce', ['get', '_lcColor'], 'rgba(0,0,0,0)'],
          'fill-opacity': ['case', ['has', '_lcColor'], 0.6, 0],
        },
      });
      map.addLayer({
        id: 'muni-parcels-line',
        type: 'line',
        source: 'muni-parcels',
        layout: { visibility: 'none' },
        paint: {
          // Soft slate-grey so the muni-wide parcel fabric reads as
          // pure supporting context — visible enough to trace lot
          // boundaries when looking for it but invisible enough that
          // zoning / MASC / CLI overlays paint cleanly on top.
          'line-color': '#6b7280',
          'line-width': 1.5,
          'line-opacity': 0.8,
        },
      });

      // ----- HISTORICAL (as-of-year) compare overlay -----
      // Sources fed from the mb-parcel-history CDN shards (setHistoricalData).
      // Parcels render as DASHED amber boundaries over the current fabric so
      // you can see a pre-subdivision parcel against today's lots; zoning and
      // dev-plan render as translucent tinted fills you can click for the
      // historical zone/designation. All hidden until Historical mode is on.
      map.addSource('historical-parcels', { type: 'geojson', data: emptyFc() });
      map.addSource('historical-zoning',  { type: 'geojson', data: emptyFc() });
      map.addSource('historical-devplan', { type: 'geojson', data: emptyFc() });
      // Seed paint only — the real per-category match expression is pushed in
      // by setHistoricalData() once the shard is loaded and we know which
      // codes are present, exactly as the live zoning layer works.
      //
      // These used to be FLAT: one purple for all 1,554 of Brandon's zoning
      // polygons, one teal for all 92 dev-plan designations. A single colour
      // over the whole city says "this is all one zone" as plainly as a legend
      // would, and it was read that way — the subject clicked as RHD, the map
      // showed no variation, so the whole city looked RHD (Jason, 2026-08-13).
      // It was 47% RSD / 27% RLD / 11% RMD, with RHD at 1.2%.
      //
      // Opacity is up from 0.12 / 0.10 because these are opt-in now (see
      // HISTORICAL_LAYER_IDS): switching a zoning overlay on deliberately is a
      // good reason to be able to read it. Neutral outlines rather than
      // self-coloured ones so two adjacent zones always separate.
      map.addLayer({
        id: 'historical-zoning-fill', type: 'fill', source: 'historical-zoning',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#7c3aed', 'fill-opacity': 0.35, 'fill-outline-color': '#5b21b6' },
      });
      map.addLayer({
        id: 'historical-devplan-fill', type: 'fill', source: 'historical-devplan',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#0d9488', 'fill-opacity': 0.30, 'fill-outline-color': '#115e59' },
      });
      // _sizeBand is stamped in main.js (stampHistoricalSizeChanges) by matching
      // each historical parcel to today's parcel of the same roll: 'major'
      // (|Δ| > 25%) = red, 'minor' (> 5%) = orange, 'gone' (roll no longer
      // exists) = grey, everything else (incl. unmatched) = the default amber.
      const SIZE_LINE_COLOR = ['match', ['get', '_sizeBand'],
        'major', '#dc2626', 'minor', '#ea580c', 'gone', '#6b7280',
        /* same / unknown / absent */ '#b45309'];
      const SIZE_FILL_COLOR = SIZE_LINE_COLOR;
      map.addLayer({
        id: 'historical-parcels-fill', type: 'fill', source: 'historical-parcels',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': SIZE_FILL_COLOR,
          // Tint changed parcels a touch more so they read at a glance.
          //
          // The baseline band covers EVERY parcel in the muni — 17,153 of them
          // in Brandon — so whatever it is set to is a wall-to-wall wash over
          // the whole town, not an accent. At 0.06 it read as "the map has been
          // shaded" rather than as context (Jason, 2026-08-13). Dropped to a
          // near-nothing 0.025 and the changed bands roughly halved with it,
          // which also widens the unchanged→major contrast (2.7× → 4×) so the
          // size-change signal carries better than it did when everything was
          // darker. The dashed amber outline is what marks a parcel historical;
          // this fill only needs to tint the changed ones and stay clickable.
          //
          // Must stay > 0: this layer is the click target behind the historical
          // parcel popup (wireHist below), so unchanged parcels cannot go
          // fill-less without losing their tooltip.
          'fill-opacity': ['match', ['get', '_sizeBand'], 'major', 0.10, 'minor', 0.06, 0.025],
        },
      });
      map.addLayer({
        id: 'historical-parcels-line', type: 'line', source: 'historical-parcels',
        layout: { visibility: 'none' },
        paint: {
          'line-color': SIZE_LINE_COLOR,    // amber = historical; red/orange = size-changed
          'line-width': ['match', ['get', '_sizeBand'], 'major', 2.6, 'minor', 2.2, 1.8],
          'line-opacity': 0.95,
          'line-dasharray': [3, 2],
        },
      });
      // Roll-number labels at each parcel's centroid. Polygon symbol
      // placement uses the polygon's centroid by default (MapLibre falls
      // back to the largest interior anchor point if the centroid is
      // outside the geometry). minzoom 13 keeps the labels from piling
      // on each other at province-wide views while still surfacing roll
      // numbers one step further out than before — appraisers comparing
      // a few neighbouring parcels at zoom 13 can read the rolls without
      // needing to zoom in another step. White halo keeps it legible
      // against either basemap or the parcels' own light-blue fill.
      map.addLayer({
        id: 'muni-parcels-label',
        type: 'symbol',
        // Point source — see comment on muni-parcels-labels source above.
        source: 'muni-parcels-labels',
        minzoom: 13,
        layout: {
          visibility: 'none',
          // _rollDisplay is the .000-stripped form stamped onto each
          // muni-parcels feature in arcgis.js's
          // fetchAllParcelsInMunicipality. Falls back to Roll_No_Txt if
          // the stamp didn't take (older cached responses, edge cases).
          'text-field': ['coalesce', ['get', '_rollDisplay'], ['get', 'Roll_No_Txt'], ''],
          'text-font': ['Open Sans Semibold'],
          // Two-dimensional interpolation: text-size scales by both
          // zoom AND parcel acreage (_acres is stamped on every
          // muni-parcels feature in arcgis.js's
          // fetchAllParcelsInMunicipality, computed via @turf/area).
          // The outer interpolate is over zoom; at each zoom stop the
          // inner interpolate maps acreage to a px size. Net effect:
          //   - tiny urban lots (0.1 ac) get small labels at every
          //     zoom — easier on dense Carman / Steinbach / Selkirk
          //     core grids
          //   - quarter sections (160 ac) and full sections (640 ac)
          //     get larger labels — easier to read in rural townships
          //   - middle-ground rural lots (1-10 ac) sit between.
          // text-allow-overlap:false + text-padding still applies on
          // top, so anything that would still collide gets culled.
          // Acreage breakpoints: 0.1 (urban lot), 1, 10, 80
          // (half-quarter), 640 (section). Stops between zooms 13/14/
          // 17/19 mirror the existing zoom-only ramp's general shape
          // but with per-area variation at each level.
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            13, [
              'interpolate', ['linear'], ['to-number', ['get', '_acres'], 1],
              0.1, 7,
              1,   9,
              10,  11,
              80,  12,
              640, 14,
            ],
            14, [
              'interpolate', ['linear'], ['to-number', ['get', '_acres'], 1],
              0.1, 7,
              1,   10,
              10,  12,
              80,  13,
              640, 15,
            ],
            17, [
              'interpolate', ['linear'], ['to-number', ['get', '_acres'], 1],
              0.1, 9,
              1,   12,
              10,  14,
              80,  16,
              640, 18,
            ],
            19, [
              'interpolate', ['linear'], ['to-number', ['get', '_acres'], 1],
              0.1, 11,
              1,   14,
              10,  16,
              80,  18,
              640, 20,
            ],
          ],
          // Auto-cull overlapping labels so dense urban grids
          // (Carman, Steinbach core, Selkirk Main St) stay readable
          // while rural townships still show every roll. The earlier
          // allow-overlap:true setting forced every label to render
          // and made dense areas a black soup of stacked numbers.
          //
          // - allow-overlap:false → MapLibre hides any roll-number
          //   that would collide with a previously-drawn label.
          //   moveLayer() puts this layer at the top of the stack, so
          //   "previously drawn" means earlier roll numbers within
          //   the same layer plus any survey-grid label below it; in
          //   practice that means urban areas auto-thin while rural
          //   stays full.
          // - ignore-placement:true → roll numbers don't reserve
          //   space against OTHER label layers (dev-plan, zoning,
          //   masc, cli), so those overlay labels still render even
          //   when a roll number sits at the same anchor.
          // - text-padding:2 gives a small breathing zone around each
          //   label so the cull triggers a touch earlier than the
          //   strict glyph-bbox would, which reads more pleasant in
          //   medium-density mid-zoom views.
          'text-allow-overlap': false,
          'text-ignore-placement': true,
          'text-padding': 2,
          'symbol-placement': 'point',
        },
        paint: {
          // 75% text opacity + 1.0 px solid white halo — softens the
          // roll number a touch so it reads as a label rather than
          // dominating the parcel cell, while the solid halo still
          // keeps it legible on top of the search-result red fill,
          // MASC/CLI fills, etc.
          'text-color': '#1a1a1a',
          'text-opacity': 0.75,
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.0,
        },
      });

      // Civic-address labels. Renders below the roll number on every
      // parcel that has a real civic address (Property_Address
      // distilled to non-empty via civicAddressOrEmpty in arcgis.js).
      //
      // History on the filter expression: tried ['all', ['has', key],
      // ['!=', value, '']] and then ['to-boolean', ['get', key]] —
      // both silently dropped every feature on the bundled MapLibre
      // build (no console error, just a non-rendering layer). The
      // legacy filter syntax ['!=', propName, ''] works reliably and
      // is parsed by both the legacy filter path AND the expression
      // path, so it's the safest form.
      //
      // Font matches the roll-number layer (Open Sans Semibold) so
      // the glyph atlas already has every needed character — Open
      // Sans Regular wasn't ALWAYS in the loaded fontstack which
      // would explain a silent non-render on some basemap glyph URLs.
      map.addLayer({
        id: 'muni-parcels-civic-label',
        type: 'symbol',
        // Point source — see comment on muni-parcels-labels source above.
        source: 'muni-parcels-labels',
        minzoom: 16.5,
        filter: ['!=', '_civicAddress', ''],
        layout: {
          visibility: 'none',
          'text-field': ['get', '_civicAddress'],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            16.5, 10,
            18,   12,
            20,   14,
          ],
          // Allow overlap with the roll number above — they share the
          // same centroid anchor with different offsets; forcing both
          // through collision detection was causing the civic label
          // to lose silently.
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-anchor': 'top',
          'text-offset': [0, 1.4],
          'symbol-placement': 'point',
          'text-max-width': 14,
        },
        paint: {
          'text-color': '#1f2937',
          'text-opacity': 0.92,
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.4,
        },
      });

      // Parcel highlight — primary layer, always on. Yellow fill (exact
      // colours/opacity in the parcel-fill / parcel-line paint blocks below)
      // so the selected parcel pops against both the cream street basemap
      // and the dark satellite imagery. Fill opacity is intentionally light
      // so the basemap and any underlying overlay (zoning category, muni
      // parcel fabric) remain readable beneath the highlight; the line
      // stroke does the heavy lifting for parcel boundary visibility.
      // promoteId tells MapLibre to use the OBJECTID property as the
      // feature id at the source level. setFeatureState({source, id})
      // can then key into each parcel by OBJECTID — required by the
      // multi-parcel-sale sibling-highlight which calls setFeatureState
      // for every OBJECTID in `_saleGroupRollIds`. Setting f.id at the
      // GeoJSON-Feature level alone wasn't reliably picked up after
      // tile re-generation, so promoteId is the canonical path.
      map.addSource('parcels', { type: 'geojson', data: emptyFc(), promoteId: 'OBJECTID' });
      map.addLayer({
        id: 'parcel-fill',
        type: 'fill',
        source: 'parcels',
        // Yellow highlight (Mat. yellow-A400). Jumps opacity when the
        // feature carries a `groupHover` state — used by the sales-
        // CSV multi-parcel sibling-highlight: hovering one parcel in
        // a group lights up every parcel in the same sale at the same
        // time. Default 0.40 reads cleanly against the dark Esri
        // imagery basemap (yellow blends toward khaki at lower
        // opacities); hover bumps to 0.50 so the lit-up group is
        // unmistakable.
        // Starred parcels (favourites) override the yellow fill with
        // dark-red so the user can spot their chosen comps on the
        // map at a glance, even when zoomed out. The `starred`
        // feature-state is set by main.js after each render (walks
        // favoriteKeys + setFeatureState per matched OBJECTID).
        paint: {
          // The fill does NOT distinguish sale groups — every selected
          // parcel gets the same yellow body. A 30% fill is the worst
          // possible carrier for a subtle colour cue: it dilutes toward
          // whatever is beneath it, so the same hex reads differently over
          // cream basemap, dark tree cover and bare soil, and the group
          // shift ended up looking like an artefact of the imagery rather
          // than a signal. The group cue lives entirely on the outline
          // below, which draws at 75% and stays true.
          'fill-color': [
            'case',
            ['boolean', ['feature-state', 'starred'], false],
            '#8b0000',
            '#ffea00',
          ],
          'fill-opacity': PARCEL_FILL_OPACITY,
        },
      });
      map.addLayer({
        id: 'parcel-line',
        type: 'line',
        source: 'parcels',
        // Bright yellow outline that matches the fill — reads as a
        // single, vivid highlight against both the cream CARTO Streets
        // basemap and the dark Esri Satellite imagery. Width jumps
        // 2.0 → 3.0 px on the groupHover feature-state so a hovered
        // sale-group's parcels still pop visually without changing
        // colour. Starred parcels (favourites) override the yellow
        // with dark-red so chosen comps still stand apart from the
        // rest of the result set.
        //
        // This outline is also the sole marker of a multi-parcel sale
        // group — see the line-color case below. The fill is deliberately
        // identical for grouped and single parcels.
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'starred'], false],
            '#8b0000',
            // Multi-parcel sale group (imported sales list, a sales CSV, or
            // rolls joined with + & | in the Roll # field). The ONLY thing
            // that marks a group: same hue as the single-parcel yellow to
            // within 0.1°, just ~17% less bright. Not a second colour — the
            // same colour, a shade down.
            //
            // Darker rather than warmer because the fill above no longer
            // carries the cue, so this thin dashed line is the whole signal,
            // and brightness survives on a 2 px stroke where a small hue
            // shift does not. The border alternates with the black underlay,
            // which gives the eye a fixed reference to read the yellow
            // against — a dimmer yellow reads as dimmer there regardless of
            // what the parcel is sitting on.
            ['>', ['to-number', ['coalesce', ['get', '_saleGroupSize'], 1]], 1],
            '#e6d300',
            '#ffea00',
          ],
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'groupHover'], false],
            3.0,
            2.0,
          ],
          // Dashed outline so the highlight reads as a "selection"
          // rather than competing visually with solid parcel-fabric
          // lines (Roll Layer, zoning boundaries, etc.). Equal dash/gap
          // ([3,3], in line-widths) so the solid black parcel-line-underlay
          // beneath shows through the gaps as equal-length black dashes —
          // an alternating black/yellow "caution-tape" border that stays
          // legible on the pale Voyager basemap where a plain yellow
          // outline washed out.
          'line-dasharray': [3, 3],
          // Border eased to 75% opacity (−25%) so the black/yellow dashes
          // read clearly without dominating the map. Matched on the
          // underlay below so the whole border softens together.
          'line-opacity': 0.75,
        },
      });
      // Solid black under-stroke for the selection outline. Sits directly
      // beneath parcel-line (same width) so the dashed colour on top
      // alternates with black in its gaps. Kept color-agnostic — it backs
      // the yellow result outline, the amber sale-group outline, and the
      // dark-red starred outline alike, giving every highlight a
      // high-contrast black component against washed-out basemap tiles.
      map.addLayer({
        id: 'parcel-line-underlay',
        type: 'line',
        source: 'parcels',
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': '#000000',
          // Match parcel-line's width (incl. the groupHover bump) exactly
          // so the black never peeks out as a casing around the colour.
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'groupHover'], false],
            3.0,
            2.0,
          ],
          // Same 75% opacity as parcel-line so the black backing eases
          // in step with the colour on top.
          'line-opacity': 0.75,
        },
      }, 'parcel-line');
      // Land-cover overlay fill — colours each result parcel by its
      // dominant 2020 land-cover bucket (Cultivated / Pasture / Bush /
      // Wetland / Other). Driven by `_lcColor`, stamped per parcel in
      // main.js from the pre-baked land-cover shards; parcels without a
      // stamp (below the threshold or no land-cover data) draw nothing. Hidden until
      // the Land Cover overlay is turned on. Inserted before parcel-line
      // so the yellow selection outline still reads on top of the colour.
      map.addLayer({
        id: 'landcover-fill',
        type: 'fill',
        source: 'parcels',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': ['coalesce', ['get', '_lcColor'], 'rgba(0,0,0,0)'],
          'fill-opacity': ['case', ['has', '_lcColor'], 0.6, 0],
        },
      }, 'parcel-line');

      // Water-influence overlay fill — colours each result parcel by its
      // waterfront classification. Driven by `_waterColor`, stamped per parcel
      // in main.js from the pre-baked water shards (lib/water.js owns the
      // palette). One blue ramp, DARK = strongest influence: frontage takes the
      // dark half (Direct / Waterfront / Reserve separated), near-water the
      // light half (Road separated / Corridor blocked). A lot fronting the Red River and a lot across the
      // road from it are not comparable, and the map has to show that at a
      // glance — keep the two groups visibly apart if the palette is retuned.
      //
      // Higher opacity than the land-cover fill (0.7 vs 0.6): this paints a
      // sparse subset — 12% of parcels province-wide — rather than a
      // wall-to-wall choropleth, so individual parcels need to carry.
      map.addLayer({
        id: 'water-fill',
        type: 'fill',
        source: 'parcels',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': ['coalesce', ['get', '_waterColor'], 'rgba(0,0,0,0)'],
          'fill-opacity': ['case', ['has', '_waterColor'], 0.7, 0],
        },
      }, 'parcel-line');
      // Outline in the same colour. Added with NO beforeId, so it sits ABOVE
      // `parcel-line` rather than beneath it — deliberately, and this is what
      // makes the overlay legible.
      //
      // `parcel-line` is a bright yellow (#ffea00 at 0.75) selection outline.
      // On the narrow lakefront lots this feature is most useful for, that
      // outline covers nearly the whole parcel at town-wide zoom, so the water
      // fill underneath was invisible and the map still read as yellow. Drawing
      // the water colour on top means a waterfront parcel reads as waterfront
      // at the zoom people actually browse at; the yellow returns as soon as
      // the overlay is switched off. Still below the numbering callouts, which
      // are added after this point and must stay on top.
      map.addLayer({
        id: 'water-outline',
        type: 'line',
        source: 'parcels',
        layout: { visibility: 'none' },
        paint: {
          'line-color': ['coalesce', ['get', '_waterColor'], 'rgba(0,0,0,0)'],
          'line-width': ['case', ['has', '_waterColor'], 2.2, 0],
          'line-opacity': 0.95,
        },
      });

      // ---- Parcel numbering (leader-line callouts) -------------------
      // When a multi-parcel result set is numbered (main.js stamps a
      // stable 1..N `_seq` per parcel, sorted by municipality then
      // Roll #), each parcel gets a numbered badge offset from its
      // centroid with a thin leader line pointing back to it. Result
      // parcels are often tiny shapes, so a number drawn INSIDE the
      // polygon would shrink below readable size — the callout keeps the
      // badge a constant screen size no matter the parcel or the zoom.
      //
      // Everything here is GL (not HTML markers) on purpose: the
      // "Generate Map" / snapshot exports read the WebGL canvas
      // (map.getCanvas()), and DOM markers wouldn't be captured — GL
      // layers are. The leader geometry is screen-space: the badge sits
      // a pixel offset from the centroid, re-projected on every camera
      // move (see the 'move' handler + repositionParcelNumbers) so the
      // offset stays constant in pixels rather than growing with zoom.
      // That offset is per-badge, not shared — parcels close together on
      // screen would otherwise stack their badges on the same spot, so
      // lib/calloutPlacement.js bumps the crowded ones outward to clear
      // space and the leader lines keep each number tied to its parcel.
      //
      //   parcel-num-anchors — Point per numbered parcel at its centroid
      //                        (static; drives the on-parcel dot).
      //   parcel-num-leaders — LineString centroid→badge (recomputed on move).
      //   parcel-num-labels  — Point at the badge position (recomputed on move).
      map.addSource('parcel-num-anchors', { type: 'geojson', data: emptyFc() });
      map.addSource('parcel-num-leaders', { type: 'geojson', data: emptyFc() });
      map.addSource('parcel-num-labels',  { type: 'geojson', data: emptyFc() });
      // Per-map numbering state so the visible map and the offscreen
      // export map (initMap runs for both) never share anchors. The
      // export map never calls setParcelNumberData, so its state stays
      // empty and the 'move' handler no-ops there.
      map._parcelNumbers = {
        anchors: [],       // [{ key, lng, lat, seq, seqStr, radius }]
        visible: false,
        rafPending: false,
        // key -> candidate slot chosen by the last de-confliction pass.
        // Carried across frames so a bumped badge stays put while its
        // slot holds up, instead of re-shuffling on every camera nudge.
        slots: new Map(),
      };
      // Leader casing (white, wider) under a dark hairline so the line
      // reads on both the cream streets basemap and the dark satellite
      // imagery.
      map.addLayer({
        id: 'parcel-num-leader-casing',
        type: 'line',
        source: 'parcel-num-leaders',
        layout: { visibility: 'none', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'parcel-num-leader',
        type: 'line',
        source: 'parcel-num-leaders',
        layout: { visibility: 'none', 'line-cap': 'round' },
        paint: { 'line-color': PARCEL_NUM_COLOR, 'line-width': 1.4 },
      });
      // Small dot on the parcel itself — the leader's anchor end, so a
      // tiny parcel is unmistakably tagged even when its badge is offset
      // away from it.
      map.addLayer({
        id: 'parcel-num-anchor-dot',
        type: 'circle',
        source: 'parcel-num-anchors',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 3,
          'circle-color': PARCEL_NUM_COLOR,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.25,
        },
      });
      // Numbered badge — a filled red disc (RGB 149,18,30) with a white
      // number, ringed white so it reads on both the light streets
      // basemap and the dark satellite imagery. Grows a little for 2-
      // and 3-digit numbers.
      //
      // These radii and the stroke width are mirrored by badgeRadius() in
      // lib/calloutPlacement.js, which decides whether two callouts are
      // judged to collide — resize the badge here and you MUST resize it
      // there, or the de-confliction pass will measure the wrong disc.
      map.addLayer({
        id: 'parcel-num-badge',
        type: 'circle',
        source: 'parcel-num-labels',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': ['step', ['length', ['to-string', ['get', '_seq']]], 11, 2, 12.65, 3, 14.85],
          'circle-color': PARCEL_NUM_COLOR,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2.2,
        },
      });
      map.addLayer({
        id: 'parcel-num-text',
        type: 'symbol',
        source: 'parcel-num-labels',
        layout: {
          visibility: 'none',
          'text-field': ['get', '_seqStr'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 14.3,
          // Numbers must always draw — never cull a callout as a
          // colliding label. The leader lines disambiguate any overlap.
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': PARCEL_NUM_COLOR,
          'text-halo-width': 0.6,
        },
      });
      // Keep the badge offset in pixels constant across zoom levels by
      // re-projecting the leader + label positions whenever the camera
      // moves. rAF-throttled and gated on visibility so it costs nothing
      // when numbering is off (the common case).
      map.on('move', () => {
        const st = map._parcelNumbers;
        if (!st || !st.visible || st.anchors.length === 0 || st.rafPending) return;
        st.rafPending = true;
        requestAnimationFrame(() => {
          st.rafPending = false;
          repositionParcelNumbers(map);
        });
      });

      // Subject parcel — separate source/layers from the result set so
      // the blue highlight stands out against the yellow sale parcels.
      // Stacked AFTER parcel-line so the blue outline reads on top
      // even when the subject is also one of the sales (rare but
      // possible — the subject may legitimately be a recent comp).
      map.addSource('subject', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'subject-fill',
        type: 'fill',
        source: 'subject',
        paint: {
          'fill-color': '#1e6fd9',
          'fill-opacity': 0.32,
        },
      });
      map.addLayer({
        id: 'subject-line',
        type: 'line',
        source: 'subject',
        paint: {
          'line-color': '#0c3a78',
          'line-width': 3.5,
        },
      });
      // Subject-distance ring — a dashed blue circle of the user-typed
      // Max Distance value, centered on the subject's centroid. Gives
      // the radius filter a visual reference so it's obvious why a
      // sale near the edge of the filter passed or failed. The fill is
      // very translucent so it doesn't obscure parcels or basemap
      // detail; the dashed line carries the visual weight.
      map.addSource('subject-radius', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'subject-radius-fill',
        type: 'fill',
        source: 'subject-radius',
        paint: { 'fill-color': '#1e6fd9', 'fill-opacity': 0.05 },
      });
      map.addLayer({
        id: 'subject-radius-line',
        type: 'line',
        source: 'subject-radius',
        paint: {
          'line-color': '#1e6fd9',
          'line-width': 2,
          'line-dasharray': [4, 3],
          'line-opacity': 0.75,
        },
      });
      // Route planner overlays — start-point marker, ordered-stop
      // pins (with rank label), and the driving-route polyline. All
      // hidden until the route panel populates them.
      map.addSource('route-start', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'route-start-pt',
        type: 'circle',
        source: 'route-start',
        paint: {
          'circle-radius': 8,
          'circle-color': '#16a34a',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'route-start-label',
        type: 'symbol',
        source: 'route-start',
        layout: {
          'text-field': 'Start',
          'text-font': ['Open Sans Semibold'],
          'text-size': 12,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#0f172a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.6,
        },
      });
      map.addSource('route-line', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'route-line-stroke',
        type: 'line',
        source: 'route-line',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#1d4ed8',
          'line-width': 4,
          'line-opacity': 0.85,
        },
      });
      map.addSource('route-stops', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'route-stop-pt',
        type: 'circle',
        source: 'route-stops',
        paint: {
          'circle-radius': 11,
          'circle-color': '#1d4ed8',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'route-stop-rank',
        type: 'symbol',
        source: 'route-stops',
        layout: {
          // `rank` is the 1-based visit order stamped by setRouteData().
          'text-field': ['to-string', ['get', 'rank']],
          'text-font': ['Open Sans Bold'],
          'text-size': 12,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': '#ffffff' },
      });
      // Area-selection shapes draw above everything a filter can act
      // on — the user just drew them, they must never hide under a
      // fill. Sources + fill/line/label + dashed preview.
      addShapeLayers(map);
      // MASC label overlay is intentionally above the parcel/roll-fabric
      // layers so the rating letter stays visible when the user turns
      // MASC on after a parcel search.
      map.addLayer({
        id: 'masc-label',
        type: 'symbol',
        source: 'masc',
        minzoom: MASC_RATING_LABEL_MIN_ZOOM,
        layout: {
          visibility: 'none',
          'text-field': ['coalesce', ['get', 'ratings'], ['get', 'rating'], ''],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            13, 12,
            16, 15,
            18, 17,
          ],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });
      map.addLayer({
        id: 'masc-risk-area-label',
        type: 'symbol',
        source: 'masc-risk-areas',
        minzoom: 6,
        layout: {
          visibility: 'none',
          'text-field': ['concat', 'Risk ', ['to-string', ['get', 'Risk_Area']]],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            6, 11,
            10, 14,
            14, 18,
          ],
          'text-allow-overlap': false,
          'text-ignore-placement': true,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#111827',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.8,
        },
      });

      // Section-township grid labels and Roll Layer roll-number
      // labels always render on top of every other overlay (parcels,
      // MASC, CLI, etc). Layers in MapLibre stack in addLayer() order,
      // so we re-anchor both to the top once every other layer has
      // been registered. moveLayer() with no `before` arg moves to
      // the very top — the LAST call wins, so muni-parcels-label
      // ends up above survey-grid-label. Both are text-only with
      // halos, so where they coincide the roll number reads on top
      // without occluding the section grid significantly.
      // Esri reference overlays (road / place names) added in
      // BASEMAP_STYLE sit at the bottom of the layer stack by default
      // — which means every data overlay (zoning, MASC, CLI, Roll
      // Layer fill) would paint over them. Move them above the data
      // fills so road names stay visible in Satellite mode, then the
      // subject-radius and label layers below land on top of them
      // (with their halos / dashed strokes, those still read cleanly).
      // WALLAS water-rights layers were registered next to the MASC
      // overlays, which put them underneath the Roll Layer fabric, the
      // soil/CLI fills and the search-result parcels — everything added
      // after them. Since a muni-scoped search auto-enables the parcel
      // fabric, the layer you just switched on could end up buried under
      // things you didn't. Re-anchor them directly beneath 'parcel-fill'
      // so they sit above every other overlay but still below the yellow
      // search highlight and the parcel-number callouts, which have to
      // stay readable. Moving each one before the same reference layer
      // preserves the order they're listed in here.
      for (const id of [
        'wallas-irrigation-fill', 'wallas-irrigation-line',
        'wallas-tile-fill', 'wallas-tile-line',
        'wallas-tile-network-line', 'wallas-tile-outlet-point',
        'wallas-tile-label',
      ]) {
        if (map.getLayer(id) && map.getLayer('parcel-fill')) {
          map.moveLayer(id, 'parcel-fill');
        }
      }

      if (map.getLayer('esri-transportation'))       map.moveLayer('esri-transportation');
      if (map.getLayer('esri-reference'))            map.moveLayer('esri-reference');
      if (map.getLayer('nrcan-transportation-labels')) map.moveLayer('nrcan-transportation-labels');
      if (map.getLayer('subject-radius-fill'))       map.moveLayer('subject-radius-fill');
      if (map.getLayer('subject-radius-line'))       map.moveLayer('subject-radius-line');
      if (map.getLayer('survey-grid-label'))         map.moveLayer('survey-grid-label');
      if (map.getLayer('muni-parcels-civic-label'))  map.moveLayer('muni-parcels-civic-label');
      if (map.getLayer('muni-parcels-label'))        map.moveLayer('muni-parcels-label');
      // Parcel-number callouts ride ABOVE the roll-number labels — the
      // whole point is that the number is the thing you can always read.
      // Order within the group: casing → leader → dot → badge → text,
      // so the badge disc covers the leader's far end and the number
      // reads on top of the badge.
      for (const id of [
        'parcel-num-leader-casing', 'parcel-num-leader', 'parcel-num-anchor-dot',
        'parcel-num-badge', 'parcel-num-text',
      ]) {
        if (map.getLayer(id)) map.moveLayer(id);
      }

      // Hover popup — works on every layer that's currently visible. Text
      // composed from whichever layer was hit (parcels take priority).
      // maxWidth 760 px keeps the 2-column parcel popup layout from
      // wrapping the per-soil "Land features" sub-lines (slope / stones
      // / salinity / etc.) — see parcelHtml + .parcel-popup-2col CSS.
      // Single-column popups still constrain via CSS.
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '760px' });
      // Soil-under-cursor hover popup, anchored to open BELOW the
      // cursor (anchor='top' = top edge of the popup at lngLat). The
      // main hover popup above (for parcels / subject / zoning /
      // devplan) opens ABOVE the cursor with the default anchor —
      // splitting the two means hovering a muni-parcel with the CLI
      // overlay on shows muni info above the cursor and the soil
      // breakdown below, stacked instead of overlapping. The popup
      // is kept narrow (340 px) so the descriptor block reads as a
      // single column. Offset 14 px keeps the popup's tip clear of
      // the cursor icon itself.
      const cliHoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        maxWidth: '340px',
        anchor: 'top',
        offset: 14,
      });
      // Sales-CSV multi-parcel sibling highlight. When the cursor sits
      // on a parcel that's part of a multi-parcel sale (its
      // _saleGroupRollIds property carries the OBJECTIDs of every
      // sibling), set feature-state groupHover:true on every sibling
      // so the paint expression bumps the fill opacity + outline
      // width on all of them at once. Cleared as the cursor moves
      // off the layer.
      let activeGroupOids = [];
      const clearGroupHover = () => {
        for (const oid of activeGroupOids) {
          map.setFeatureState({ source: 'parcels', id: oid }, { groupHover: false });
        }
        activeGroupOids = [];
      };
      const setGroupHover = (oids) => {
        if (!Array.isArray(oids) || oids.length === 0) {
          clearGroupHover();
          return;
        }
        // No-op if the same group is already lit.
        if (activeGroupOids.length === oids.length
            && activeGroupOids.every((v, i) => v === oids[i])) return;
        clearGroupHover();
        for (const oid of oids) {
          if (oid == null) continue;
          map.setFeatureState({ source: 'parcels', id: oid }, { groupHover: true });
          activeGroupOids.push(oid);
        }
      };
      // Expose for runtime debugging — call window.__setGroupHover([oid1, oid2])
      // to manually verify the feature-state path independent of the hover handler.
      window.__setGroupHover = setGroupHover;
      window.__clearGroupHover = clearGroupHover;

      // Single funnel for the hover cursor, used by every layer that
      // turns the pointer into a hand. While the measurement panel is
      // open the request is dropped: mapbox-gl-draw sets its crosshair
      // through a CSS class on the canvas, and an inline style — which
      // is what these handlers write — beats a class every time, so a
      // hover over any clickable overlay would otherwise steal the
      // crosshair mid-measurement.
      const setHoverCursor = (cursor) => {
        map.getCanvas().style.cursor = isMeasuring() ? '' : cursor;
      };

      // Everything a hover leaves behind, undone in one place: both
      // tooltips, the pointer cursor and the sale-group highlight. Three
      // callers need exactly this — an empty hit-test, the pointer
      // leaving the canvas, and the measurement tool taking over.
      const clearHover = () => {
        popup.remove();
        cliHoverPopup.remove();
        setHoverCursor('');
        clearGroupHover();
      };

      map.on('mousemove', (e) => {
        if (!map.isStyleLoaded()) return;
        // The measurement tool owns the pointer while its panel is open:
        // every click is placing a vertex, and a tooltip tracking the
        // cursor sits over the very point being aimed at. Stand the hover
        // down for the duration — this also clears a popup left showing
        // when the panel opened, on the first move after it opens, and
        // keeps the pointer cursor out of draw's crosshair.
        if (isMeasuring() || isShapeDrawing()) {
          clearHover();
          return;
        }
        const visibleLayers = ['parcel-fill'];
        // Subject parcel is on a separate source/layer — include its
        // fill in the hit-test so hovering the subject also pops a
        // tooltip (with the "Subject parcel" header via _isSubject).
        if (map.getLayer('subject-fill')) visibleLayers.push('subject-fill');
        if (map.getLayoutProperty('zoning-fill', 'visibility') === 'visible') visibleLayers.push('zoning-fill');
        if (map.getLayoutProperty('devplan-fill', 'visibility') === 'visible') visibleLayers.push('devplan-fill');
        // CLI overlay (cli-agr-fill) gets queried too so the bare-CLI
        // hover branch can fire from this same handler without a
        // second popup instance competing. Only added when the layer
        // is visible — same gating as the other conditional layers.
        if (map.getLayer('cli-agr-fill') &&
            map.getLayoutProperty('cli-agr-fill', 'visibility') === 'visible') {
          visibleLayers.push('cli-agr-fill');
        }
        const hits = map.queryRenderedFeatures(e.point, { layers: visibleLayers });
        if (!hits.length) {
          clearHover();
          return;
        }
        // Light up parcels that are part of a sale group on hover —
        // single-parcel sales get their one parcel highlighted, multi-
        // parcel sales get every sibling lit at once. Non-sales searches
        // skip this (no _saleGroupRollIds stamped).
        const parcelHit = hits.find((h) => h.layer.id === 'parcel-fill');
        const oids = readSaleGroupOids(parcelHit?.properties);
        // Always-on diagnostic snapshot — readable as window.__lastHover
        // from the devtools console without flipping a flag. Lets the
        // user verify the multi-parcel-sale sibling-highlight pipeline
        // is wired up correctly even when the visual state change isn't
        // obvious (e.g. small-area parcels where the opacity bump is
        // hard to see). Set window.__hoverDebug = true to also stream
        // each hover to the console.
        window.__lastHover = {
          featureId: parcelHit?.id,
          featureIdType: typeof parcelHit?.id,
          roll: parcelHit?.properties?.Roll_No_Txt,
          groupSize: parcelHit?.properties?._saleGroupSize,
          groupOidsRaw: parcelHit?.properties?._saleGroupRollIds,
          groupOidsRawType: typeof parcelHit?.properties?._saleGroupRollIds,
          parsedOids: oids,
          wouldHighlight: !!(oids && oids.length > 1),
        };
        if (window.__hoverDebug) console.log('[hover]', window.__lastHover);
        if (oids && oids.length >= 1) setGroupHover(oids);
        else clearGroupHover();
        setHoverCursor('pointer');
        // Parcel info, then a separator line per overlay hit (deduped by layer).
        // Subject takes precedence over parcel-fill — when the subject
        // overlaps a sale parcel (legitimate when the subject is also
        // a comp), the blue subject header should win the header.
        const blocks = [];
        const subject = hits.find((h) => h.layer.id === 'subject-fill');
        if (subject) {
          blocks.push(`<div><strong style="color:#1e6fd9">Subject</strong><br>${parcelHtml(subject.properties)}</div>`);
        }
        const parcel = hits.find((h) => h.layer.id === 'parcel-fill');
        if (parcel && !subject) blocks.push(`<div><strong style="color:#7a5c00">Parcel</strong><br>${parcelHtml(parcel.properties)}</div>`);
        const zone = hits.find((h) => h.layer.id === 'zoning-fill');
        if (zone) blocks.push(`<div><strong style="color:#1a2a4a">Zoning</strong><br>${zoningHtml(zone.properties)}</div>`);
        const dev = hits.find((h) => h.layer.id === 'devplan-fill');
        if (dev) blocks.push(`<div><strong style="color:#1a2a4a">Dev Plan</strong><br>${devPlanHtml(dev.properties)}</div>`);
        // ABOVE-CURSOR popup: parcel / subject / zoning / dev-plan info.
        // Remove when no content blocks remain so we don't render an
        // empty popup over a bare CLI hover (in that case only the
        // BELOW-CURSOR cliHoverPopup will be visible).
        if (blocks.length) {
          popup
            .setLngLat(e.lngLat)
            .setHTML(blocks.join('<hr style="margin:6px 0;border:none;border-top:1px solid #ddd">'))
            .addTo(map);
        } else {
          popup.remove();
        }
        // BELOW-CURSOR popup: soil-under-cursor breakdown for the CLI
        // polygon under the cursor. Lives in its own popup instance so
        // it stacks under the above-cursor popup instead of overlapping
        // it (anchor='top' on construction). Suppressed when hovering
        // a search-result parcel-fill / subject-fill polygon — those
        // popups already carry a rolled-up `Soil composition` right
        // column from parcelHtml, so showing the polygon-under-cursor
        // breakdown again below would just duplicate the same info.
        // For muni-parcels-fill (Assessment Parcels layer), the
        // muniHoverPopup shows above-cursor in its own handler and
        // this cliHoverPopup shows below — the stacked layout the
        // user asked for.
        const cli = hits.find((h) => h.layer.id === 'cli-agr-fill');
        if (cli && !subject && !parcel) {
          const soil = soilSurveyHoverHtml(cli.properties);
          if (soil) {
            cliHoverPopup
              .setLngLat(e.lngLat)
              .setHTML(`<div style="line-height:1.4;font-size:12px">${soil}</div>`)
              .addTo(map);
          } else {
            cliHoverPopup.remove();
          }
        } else {
          cliHoverPopup.remove();
        }
      });
      map.on('mouseout', () => clearHover());

      // Click on a search-result parcel → open a sticky popup with the
      // parcel detail. The popup includes an explicit action for scrolling
      // the results table to this parcel; opening the popup itself must not
      // move the page away from the map.
      //
      // The sticky popup is needed because
      // the global hover popup disappears on mouseout, so the user could
      // never reach the Assessment-report link sitting at the bottom of
      // it. Reuses parcelHtml so hover and click show identical content.
      // focusAfterOpen:false also prevents MapLibre from changing the page's
      // scroll position while it focuses the newly opened popup.
      const parcelClickPopup = new maplibregl.Popup({ closeButton: true, focusAfterOpen: false, maxWidth: '760px' });
      map.on('click', 'parcel-fill', (e) => {
        // Shape tools own the click while armed (placing geometry) or
        // when a committed shape sits under the cursor (mode toggle) —
        // either way the parcel popup stands down.
        if (shapeClickHandled(map, e)) return;
        const f = e.features?.[0];
        if (!f) return;
        const key = f.properties?._rowKey;
        // Hide the hover popup so the sticky popup doesn't render on top
        // of itself when the user hovers back over the same parcel.
        popup.remove();
        parcelClickPopup
          .setLngLat(e.lngLat)
          .setHTML(parcelHtml(f.properties, {
            showJumpToList: key != null && typeof onFeatureClick === 'function',
          }))
          .addTo(map);
        wireJumpToList(parcelClickPopup, key, onFeatureClick);
        // Wire the Coordinates copy link. e.features only carries
        // properties from the symbol/fill layer hit; for the geometry
        // we need the rendered feature. Fall back to the click point
        // when no polygon geometry is available.
        const rendered = map.queryRenderedFeatures(e.point, { layers: ['parcel-fill'] })[0];
        const center = polygonBboxMidpoint(rendered?.geometry)
          ?? [e.lngLat.lng, e.lngLat.lat];
        wireCoordsCopy(parcelClickPopup, center);
      });

      // Muni-parcels hover popup. The muni-parcels source carries a richer
      // property set than the parcel hover (Roll #, Address, DU, area,
      // value), so a quick mouseover surfaces enough info to triage which
      // parcel the user is looking at. Reuses the same combined-popup
      // instance to avoid stacking a second popup over the search-result
      // hover. Only attaches when the muni-parcels layer is visible — when
      // search-result parcels also sit at the cursor those win (queried
      // first in the layer list).
      const muniHoverPopup = new maplibregl.Popup({
        maxWidth: '760px',
        closeButton: false,
        closeOnClick: false,
      });
      map.on('mousemove', 'muni-parcels-fill', (e) => {
        if (map.getLayoutProperty('muni-parcels-fill', 'visibility') !== 'visible') return;
        // Stands down with the rest of the hover while measuring — this
        // popup has its own handler, so the global guard doesn't cover it.
        if (isMeasuring()) {
          muniHoverPopup.remove();
          setHoverCursor('');
          return;
        }
        // If a search-result parcel is also under the cursor, defer to its
        // popup (handled by the global mousemove above) and hide ours.
        const overSearchResult = map.queryRenderedFeatures(e.point, { layers: ['parcel-fill'] }).length > 0;
        if (overSearchResult) { muniHoverPopup.remove(); return; }
        const p = e.features?.[0]?.properties;
        if (!p) return;
        // Pull zoning + dev-plan info from whatever overlay layers are
        // currently visible at the cursor so the muni-parcel popup is
        // as informative as the search-result popup. Without this, hover
        // on a non-result parcel showed only the Roll Entry attributes.
        const overlay = readOverlaysAt(map, e.point);
        muniHoverPopup
          .setLngLat(e.lngLat)
          .setHTML(muniParcelHtml(p, { overlay }))
          .addTo(map);
        setHoverCursor('pointer');
      });
      map.on('mouseleave', 'muni-parcels-fill', () => {
        muniHoverPopup.remove();
        setHoverCursor('');
      });

      // Click on a muni-parcel polygon → sticky popup (so the user can
      // copy the roll number, click the assessment-report link, etc).
      // Same content as the hover popup but with a close button.
      const muniClickPopup = new maplibregl.Popup({ closeButton: true, maxWidth: '760px' });
      map.on('click', 'muni-parcels-fill', (e) => {
        if (shapeClickHandled(map, e)) return;
        if (map.getLayoutProperty('muni-parcels-fill', 'visibility') !== 'visible') return;
        // Defer to the search-result click handler when both layers
        // overlap — keeps the table-scroll behaviour intact.
        const overSearchResult = map.queryRenderedFeatures(e.point, { layers: ['parcel-fill'] }).length > 0;
        if (overSearchResult) return;
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const overlay = readOverlaysAt(map, e.point);
        muniClickPopup
          .setLngLat(e.lngLat)
          .setHTML(muniParcelHtml(p, { withReportLink: true, overlay }))
          .addTo(map);
        // Same Coordinates-copy wiring as the parcel-fill click
        // handler: pull the full geometry via queryRenderedFeatures,
        // compute the bbox-midpoint centroid, attach the listener.
        const rendered = map.queryRenderedFeatures(e.point, { layers: ['muni-parcels-fill'] })[0];
        const center = polygonBboxMidpoint(rendered?.geometry)
          ?? [e.lngLat.lng, e.lngLat.lat];
        wireCoordsCopy(muniClickPopup, center);
      });

      // Historical (as-of-date) overlay click popups — one per layer, each
      // gated on its own visibility so they only fire in Historical mode.
      // PRIORITY: the zoning + dev-plan context fills blanket the whole muni,
      // so a click on a parcel also lands on them. Each layer defers to the
      // higher-priority historical layers under the same point (parcel > zoning
      // > dev-plan), so clicking a parcel shows the PARCEL — not the dev-plan
      // designation that happens to sit beneath it. Without this, the three
      // handlers raced on one shared popup and dev-plan (wired last) won.
      const histClickPopup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px' });
      const wireHist = (layerId, htmlFn, deferTo = []) => {
        map.on('click', layerId, (e) => {
          if (map.getLayoutProperty(layerId, 'visibility') !== 'visible') return;
          for (const other of deferTo) {
            if (map.getLayer(other) &&
                map.getLayoutProperty(other, 'visibility') === 'visible' &&
                map.queryRenderedFeatures(e.point, { layers: [other] }).length > 0) {
              return;   // a higher-priority historical feature owns this click
            }
          }
          const p = e.features?.[0]?.properties;
          if (!p) return;
          histClickPopup.setLngLat(e.lngLat).setHTML(htmlFn(p, historicalYear ?? '')).addTo(map);
        });
        map.on('mouseenter', layerId, () => { setHoverCursor('pointer'); });
        map.on('mouseleave', layerId, () => { setHoverCursor(''); });
      };
      wireHist('historical-parcels-fill', historicalParcelHtml);
      wireHist('historical-zoning-fill',  historicalZoningHtml,  ['historical-parcels-fill']);
      wireHist('historical-devplan-fill', historicalDevplanHtml, ['historical-parcels-fill', 'historical-zoning-fill']);

      // Bare CLI-polygon click — sticky popup for "Parcel Boundaries
      // off, CLI on" workflows where the user wants to click a polygon
      // and keep its soil info on screen. Hover for bare CLI polygons
      // is folded into the global mousemove handler above so there's
      // only ONE popup instance racing on each mouse event; the
      // previous standalone cli-agr-fill mousemove + its own popup
      // instance ended up competing with the global popup and the
      // muni-parcels popup, making hover inconsistent when CLI was
      // on over search-result parcels. Click defers to parcel-fill
      // / muni-parcels-fill / subject-fill the same way the hover
      // path does.
      function shouldDeferToParcelLayer(point) {
        if (map.queryRenderedFeatures(point, { layers: ['parcel-fill'] }).length > 0) return true;
        if (map.getLayer('subject-fill') &&
            map.queryRenderedFeatures(point, { layers: ['subject-fill'] }).length > 0) return true;
        if (map.getLayer('muni-parcels-fill') &&
            map.getLayoutProperty('muni-parcels-fill', 'visibility') === 'visible' &&
            map.queryRenderedFeatures(point, { layers: ['muni-parcels-fill'] }).length > 0) return true;
        return false;
      }
      const cliClickPopup = new maplibregl.Popup({ closeButton: true, maxWidth: '340px' });
      map.on('click', 'cli-agr-fill', (e) => {
        if (map.getLayoutProperty('cli-agr-fill', 'visibility') !== 'visible') return;
        if (shouldDeferToParcelLayer(e.point)) return;
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const body = soilSurveyHoverHtml(p);
        if (!body) return;
        cliClickPopup
          .setLngLat(e.lngLat)
          .setHTML(`<div style="line-height:1.4;font-size:12px">${body}</div>`)
          .addTo(map);
      });

      // Click a contaminated-site point → small popup with the registry
      // designation + a link out to the official page for that site.
      const contamPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'contam-circle', (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        contamPopup.setLngLat(e.lngLat).setHTML(contamHtml(p)).addTo(map);
      });
      map.on('mouseenter', 'contam-circle', () => {
        if (map.getLayoutProperty('contam-circle', 'visibility') === 'visible') {
          setHoverCursor('pointer');
        }
      });
      map.on('mouseleave', 'contam-circle', () => { setHoverCursor(''); });

      // Click an official MASC risk-area polygon → small popup with the
      // Risk_Area number from Manitoba Maps.
      const riskAreaPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'masc-risk-area-fill', (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        riskAreaPopup.setLngLat(e.lngLat).setHTML(riskAreaHtml(p)).addTo(map);
      });
      map.on('mouseenter', 'masc-risk-area-fill', () => {
        if (map.getLayoutProperty('masc-risk-area-fill', 'visibility') === 'visible') {
          setHoverCursor('pointer');
        }
      });

      // WALLAS water-rights popups. One shared popup across all four
      // clickable layers so opening a second closes the first — these
      // overlap constantly (an outlet sits inside its own tile area,
      // which can sit inside an irrigation footprint) and stacking
      // popups would bury the map.
      const wallasPopup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px' });
      const wireWallas = (layerId, htmlFn) => {
        map.on('click', layerId, (e) => {
          if (map.getLayoutProperty(layerId, 'visibility') !== 'visible') return;
          const p = e.features?.[0]?.properties;
          if (!p) return;
          wallasPopup.setLngLat(e.lngLat).setHTML(htmlFn(p)).addTo(map);
        });
        map.on('mouseenter', layerId, () => {
          if (map.getLayoutProperty(layerId, 'visibility') === 'visible') {
            setHoverCursor('pointer');
          }
        });
        map.on('mouseleave', layerId, () => { setHoverCursor(''); });
      };
      // Outlets and network lines wire before the area fill so a click on
      // the small features wins over the large polygon beneath them —
      // MapLibre dispatches to the most recently added handler last, and
      // the popup is shared, so the last writer wins.
      wireWallas('wallas-tile-fill', tileDrainageHtml);
      wireWallas('wallas-irrigation-fill', irrigationHtml);
      wireWallas('wallas-tile-network-line', tileNetworkHtml);
      wireWallas('wallas-tile-outlet-point', tileOutletHtml);
      map.on('mouseleave', 'masc-risk-area-fill', () => { setHoverCursor(''); });

      // Click a CLI polygon → popup listing every class slot the
      // polygon carries (A through F) with class number, percentage,
      // and subclass codes. Most polygons have a single dominant
      // class but transition zones can carry mixed ratings like
      // "60% 3W, 40% 4T" — the popup makes that visible without
      // having to dig through the raw FeatureServer attributes.
      // The CLI overlay no longer has a polygon-click popup. With the
      // per-parcel composition section now in the main parcel popup
      // (top-3 soils with capability chips), the polygon popup was
      // redundant — a click on a search-result parcel that lay over
      // a CLI polygon would fire two popups stacked on top of each
      // other. Removed at the user's request.
      //
      // If we ever want the polygon-click behaviour back, the cliHtml
      // builder lower in this file is still here.

      // Manitoba Soil Survey popup. Walks SOIL_{1,2,3} slots showing
      // soil name + extent percent + capability-class chip + surface
      // texture. Closes with the map-unit symbol (MAPUNITNOM) and
      // the source-report citation so the user can trace the data
      // back to the printed soil survey.
      const soilSurveyPopup = new maplibregl.Popup({ closeButton: true, maxWidth: '340px' });
      map.on('click', 'soil-survey-fill', (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        soilSurveyPopup.setLngLat(e.lngLat).setHTML(soilSurveyHtml(p)).addTo(map);
      });
      map.on('mouseenter', 'soil-survey-fill', () => {
        if (map.getLayoutProperty('soil-survey-fill', 'visibility') === 'visible') {
          setHoverCursor('pointer');
        }
      });
      map.on('mouseleave', 'soil-survey-fill', () => { setHoverCursor(''); });

      // Click a traffic-count station → popup with station / highway /
      // location and the AADT (when the Traffic Flow layer has been loaded
      // and indexed; main.js stamps the matched AADT onto each station
      // feature's properties before pushing them to the source).
      const trafficPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'traffic-circle', (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        trafficPopup.setLngLat(e.lngLat).setHTML(trafficHtml(p)).addTo(map);
      });
      map.on('mouseenter', 'traffic-circle', () => {
        if (map.getLayoutProperty('traffic-circle', 'visibility') === 'visible') {
          setHoverCursor('pointer');
        }
      });
      map.on('mouseleave', 'traffic-circle', () => { setHoverCursor(''); });

      // Click an AADT flow segment → popup with the road / highway, the
      // segment kilometre range, and the AADT estimate for that segment.
      const flowPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'traffic-flow-line', (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        flowPopup.setLngLat(e.lngLat).setHTML(trafficFlowHtml(p)).addTo(map);
      });
      map.on('mouseenter', 'traffic-flow-line', () => {
        if (map.getLayoutProperty('traffic-flow-line', 'visibility') === 'visible') {
          setHoverCursor('pointer');
        }
      });
      map.on('mouseleave', 'traffic-flow-line', () => { setHoverCursor(''); });

      const highwaysPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'mb-highways-line', (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        highwaysPopup.setLngLat(e.lngLat).setHTML(mbHighwayHtml(p)).addTo(map);
      });
      map.on('mouseenter', 'mb-highways-line', () => {
        if (map.getLayoutProperty('mb-highways-line', 'visibility') === 'visible') {
          setHoverCursor('pointer');
        }
      });
      map.on('mouseleave', 'mb-highways-line', () => { setHoverCursor(''); });

      } catch (err) {
        // Setup ran before the style was ready — back off and let
        // the next trigger try again. We re-arm setupDone here.
        setupDone = false;
        return;
      }
      resolve();
    };

    // Three triggers race to call setupMap. addSource throws "Style
    // is not done loading" if fired too early; the catch above
    // re-arms setupDone so the next trigger retries.
    map.on('load', setupMap);
    map.on('idle', setupMap);
    map.on('styledata', (e) => {
      // The 'data' event with `dataType: 'style'` is MapLibre's
      // own signal that the style finished loading. Without
      // filtering, styledata also fires for tile data.
      if (!e || e.dataType === 'style' || e.dataType === 'sourcedata') {
        setupMap();
      }
    });
    // Poll fallback. Some builds deliver none of the events in
    // time; the poll runs setupMap, which guards via setupDone +
    // catch-on-throw.
    const pollId = setInterval(() => {
      if (setupDone) { clearInterval(pollId); return; }
      setupMap();
    }, 120);
    // Failsafe so the UI doesn't hang forever in pathological cases
    // (style genuinely failing to load). Resolves mapReady so the
    // overlay toggles don't get stuck on "Loading…" — setVis on a
    // missing layer is a silent no-op.
    setTimeout(() => {
      if (setupDone) return;
      console.warn('Map setup did not complete after 30s — some overlays may not render until you reload.');
      clearInterval(pollId);
      resolve();
    }, 30000);
  });

  return { map, ready };
}

/**
 * Push the parcel results onto the map and fit to them. Empty FC resets
 * the viewport to the province-wide default so the user sees something
 * familiar after Clear. Pass `{ fit: false }` to push the same set of
 * features again without re-fitting the viewport — used after sales-CSV
 * upload to refresh the source with computeSaleGroupTotals stamps so
 * the hover-highlight feature-state can find _saleGroupRollIds.
 */
export function showResults(map, parcelFc, { fit = true } = {}) {
  const src = map.getSource('parcels');
  if (src) src.setData(parcelFc);
  if (!fit) return;
  if (!parcelFc.features.length) {
    map.flyTo({ center: MB_CENTER, zoom: MB_ZOOM });
    return;
  }
  try {
    const [minLon, minLat, maxLon, maxLat] = bbox(parcelFc);
    map.fitBounds(
      [[minLon, minLat], [maxLon, maxLat]],
      { padding: 60, maxZoom: 18, duration: 800 }
    );
  } catch (err) {
    console.warn('fit bounds failed', err);
  }
}

// ---- Parcel numbering (leader-line callouts) -----------------------

/**
 * Load the anchor set for the numbered callouts. `features` are the
 * result parcels; those carrying a stamped `_seq` (assigned by main.js
 * via lib/parcelNumbering.js) get a callout. Computes each parcel's
 * centroid once (the leader's fixed anchor end) and stashes it on the
 * per-map state; the leader + badge positions are derived from these on
 * every camera move. Call whenever the result set changes — pushing an
 * empty / _seq-less set clears the callouts.
 */
export function setParcelNumberData(map, features) {
  const st = map._parcelNumbers;
  if (!st) return;
  const anchors = [];
  const anchorFeatures = [];
  for (const f of features || []) {
    const seq = f?.properties?._seq;
    if (seq == null) continue;
    const c = polygonBboxMidpoint(f.geometry);
    if (!c) continue;
    const seqStr = String(seq);
    anchors.push({ lng: c[0], lat: c[1], seq, seqStr, radius: badgeRadius(seqStr) });
    anchorFeatures.push({
      type: 'Feature',
      properties: { _seq: seq },
      geometry: { type: 'Point', coordinates: c },
    });
  }
  // Placement order low→high: the de-confliction pass hands out slots
  // first-come, so the lowest numbers keep the canonical up-right
  // position and later ones give way.
  anchors.sort((a, b) => a.seq - b.seq);
  // Key by position in that order — stable for the life of a result set,
  // and unique even when two parcels share a Site # override.
  anchors.forEach((a, i) => { a.key = String(i); });
  st.anchors = anchors;
  // A new result set is a new placement problem; don't carry slots over.
  st.slots = new Map();
  const anchorSrc = map.getSource('parcel-num-anchors');
  if (anchorSrc) anchorSrc.setData({ type: 'FeatureCollection', features: anchorFeatures });
  repositionParcelNumbers(map);
}

/** Show or hide the numbered callouts (all five layers). Re-projects the
 *  leader/badge positions on show so they're correct immediately, before
 *  the next camera move. */
export function setParcelNumbersVisible(map, on) {
  const st = map._parcelNumbers;
  if (!st) return;
  st.visible = !!on;
  const vis = on ? 'visible' : 'none';
  for (const id of [
    'parcel-num-leader-casing', 'parcel-num-leader', 'parcel-num-anchor-dot',
    'parcel-num-badge', 'parcel-num-text',
  ]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  }
  repositionParcelNumbers(map);
}

/**
 * Recompute the leader lines and badge points from the stored anchors.
 * Each badge sits a pixel offset from its centroid IN SCREEN SPACE:
 * project the centroid to pixels, add the offset, un-project back to a
 * lng/lat for the badge, and draw the leader between the two. Doing this
 * per-move keeps the callout a constant size/offset at every zoom.
 *
 * The offset is per-badge, not shared: since the whole set is in pixel
 * space here, this is where the callouts get de-conflicted. Badges that
 * fit at the canonical up-right offset keep it; the rest are bumped
 * outward to a clear slot by lib/calloutPlacement.js. Feeding the last
 * pass's slots back in gives the solve hysteresis, so a bumped badge
 * holds position through a pan rather than hopping every frame. No-op
 * (and clears the sources) when hidden or empty.
 */
function repositionParcelNumbers(map) {
  const st = map._parcelNumbers;
  if (!st) return;
  const leaderSrc = map.getSource('parcel-num-leaders');
  const labelSrc = map.getSource('parcel-num-labels');
  if (!leaderSrc || !labelSrc) return;
  if (!st.visible || st.anchors.length === 0) {
    leaderSrc.setData(emptyFc());
    labelSrc.setData(emptyFc());
    return;
  }
  const projected = st.anchors.map((a) => {
    const pt = map.project([a.lng, a.lat]);
    return { key: a.key, x: pt.x, y: pt.y, r: a.radius };
  });
  const canvas = map.getCanvas();
  st.slots = solveCalloutSlots(projected, st.slots, {
    width: canvas.clientWidth || canvas.width,
    height: canvas.clientHeight || canvas.height,
  });
  const leaders = [];
  const labels = [];
  st.anchors.forEach((a, i) => {
    const [dx, dy] = calloutOffset(st.slots.get(a.key));
    const p = projected[i];
    const lp = map.unproject([p.x + dx, p.y + dy]);
    leaders.push({
      type: 'Feature',
      properties: { _seq: a.seq },
      geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [lp.lng, lp.lat]] },
    });
    labels.push({
      type: 'Feature',
      properties: { _seq: a.seq, _seqStr: a.seqStr },
      geometry: { type: 'Point', coordinates: [lp.lng, lp.lat] },
    });
  });
  leaderSrc.setData({ type: 'FeatureCollection', features: leaders });
  labelSrc.setData({ type: 'FeatureCollection', features: labels });
}

export function flyToFeature(map, feature) {
  if (!feature?.geometry) return;
  try {
    const [minLon, minLat, maxLon, maxLat] = bbox(feature);
    map.fitBounds(
      [[minLon, minLat], [maxLon, maxLat]],
      { padding: 80, maxZoom: 19, duration: 700 }
    );
  } catch (err) {
    console.warn('flyToFeature: bbox failed', err);
  }
}

export function setZoningData(map, fc) {
  const src = map.getSource('zoning');
  if (src) src.setData(fc);
}

/**
 * Colour the PARCELS by their zoning code instead of the normal yellow.
 *
 * This is what the zoning toggle's "selection" state uses. Drawing the
 * zoning polygons that intersect the parcels does not answer "what are
 * these parcels zoned" — a zoning polygon covers a whole block, so the
 * colour bleeds across everything around the parcels and the selection is
 * no easier to read than the full overlay. Painting the parcels
 * themselves puts the colour exactly on the subject and nowhere else.
 *
 * `pairs` is the flat [code, colour, …] list from buildZoneCodePaint, so
 * parcel colours and the zoning legend come from one assignment and cannot
 * drift. Pass null to restore the ordinary selection fill.
 *
 * The starred override stays on top either way — a chosen comparable must
 * stay findable whatever the fill is showing.
 */
export function setParcelZoneColoring(map, pairs) {
  if (!map.getLayer('parcel-fill')) return;
  const starred = ['boolean', ['feature-state', 'starred'], false];
  map.setPaintProperty('parcel-fill', 'fill-color',
    (pairs && pairs.length)
      ? ['case', starred, '#8b0000',
         ['match', ['coalesce', ['get', '_zoneCode'], ''], ...pairs, '#cccccc']]
      : ['case', starred, '#8b0000', '#ffea00']);
  // Zone fills need more body than the highlight yellow: they carry meaning
  // rather than just marking a selection.
  map.setPaintProperty('parcel-fill', 'fill-opacity',
    (pairs && pairs.length) ? 0.55 : PARCEL_FILL_OPACITY);
}

/**
 * Swap the zoning-fill paint to a `match` expression keyed on ZONE code.
 * `pairs` is the flat [code, color, code, color, ...] list returned from
 * buildZoneCodePaint(). Falls back to grey for any unmatched codes (which
 * shouldn't happen since pairs are derived from the same FC) and clears
 * to a flat grey when there are no pairs.
 */
export function setZoningPaint(map, pairs) {
  if (!map.getLayer('zoning-fill')) return;
  if (!pairs || pairs.length === 0) {
    map.setPaintProperty('zoning-fill', 'fill-color', '#cccccc');
    return;
  }
  map.setPaintProperty('zoning-fill', 'fill-color',
    ['match', ['get', 'ZONE'], ...pairs, '#cccccc']);
}
export function setDevPlanData(map, fc) {
  const src = map.getSource('devplan');
  if (src) src.setData(fc);
}

export function setZoningVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['zoning-fill', 'zoning-line', 'zoning-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}
export function setDevPlanVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['devplan-fill', 'devplan-line', 'devplan-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

export function setContamData(map, fc) {
  const src = map.getSource('contam');
  if (src) src.setData(fc);
}
export function setContamVisible(map, visible) {
  if (map.getLayer('contam-circle')) {
    map.setLayoutProperty('contam-circle', 'visibility', visible ? 'visible' : 'none');
  }
}

export function setTrafficData(map, fc) {
  const src = map.getSource('traffic');
  if (src) src.setData(fc);
}
export function setTrafficVisible(map, visible) {
  if (map.getLayer('traffic-circle')) {
    map.setLayoutProperty('traffic-circle', 'visibility', visible ? 'visible' : 'none');
  }
}

export function setTrafficFlowData(map, fc) {
  const src = map.getSource('traffic-flow');
  if (src) src.setData(fc);
}
export function setTrafficFlowVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['traffic-flow-line', 'traffic-flow-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

export function setMbHighwaysData(map, fc) {
  const src = map.getSource('mb-highways');
  if (src) src.setData(fc);
}
export function setMbHighwaysVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['mb-highways-casing', 'mb-highways-line', 'mb-highways-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

/** Push the subject parcel onto its dedicated map layer. Pass an
 *  empty FC (or null) to clear the highlight. */
export function setSubjectData(map, fc) {
  const src = map.getSource('subject');
  if (src) src.setData(fc || { type: 'FeatureCollection', features: [] });
}

/**
 * Draw a circle of the supplied radius (km) around the centroid on the
 * subject-radius layer. Pass null/zero/no centroid to clear the ring.
 * The geometry is a 96-vertex polygon ring built with an equirectangular
 * approximation — accurate to <0.5 % at any latitude Manitoba covers,
 * which is well below the precision of the visual indicator anyway.
 */
export function setSubjectRadius(map, centroid, radiusKm) {
  const src = map.getSource('subject-radius');
  if (!src) return;
  if (!centroid || !Number.isFinite(radiusKm) || radiusKm <= 0) {
    src.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  const lng = centroid.lng ?? centroid[0];
  const lat = centroid.lat ?? centroid[1];
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    src.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  const STEPS = 96;
  const R = 6371; // mean earth radius in km
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const coords = [];
  for (let i = 0; i <= STEPS; i++) {
    const theta = (i / STEPS) * 2 * Math.PI;
    const dx = radiusKm * Math.cos(theta);
    const dy = radiusKm * Math.sin(theta);
    const dLat = (dy / R) * (180 / Math.PI);
    const dLng = (dx / R) * (180 / Math.PI) / cosLat;
    coords.push([lng + dLng, lat + dLat]);
  }
  src.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { radiusKm },
      geometry: { type: 'Polygon', coordinates: [coords] },
    }],
  });
}

export function setMascData(map, fc) {
  const src = map.getSource('masc');
  if (src) src.setData(fc);
}
export function setMascRiverlotsData(map, fc) {
  const src = map.getSource('masc-riverlots');
  if (src) src.setData(fc);
}
export function setMascVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of [
    'masc-fill', 'masc-label',
    'masc-riverlots-fill', 'masc-riverlots-label',
  ]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

export function setMascRiskAreasData(map, fc) {
  const src = map.getSource('masc-risk-areas');
  if (src) src.setData(fc);
}
export function setMascRiskAreasVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['masc-risk-area-fill', 'masc-risk-area-line', 'masc-risk-area-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

// ---- WALLAS water rights ----

export function setTileDrainageData(map, fc) {
  const src = map.getSource('wallas-tile');
  if (src) src.setData(fc);
}
export function setTileDrainageVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['wallas-tile-fill', 'wallas-tile-line', 'wallas-tile-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

/** Lines and outlets arrive together from one viewport fetch, so they
 *  set and hide together — a tile run with no outlet (or the reverse)
 *  would just look like missing data. */
export function setTileNetworkData(map, { lines, outlets }) {
  const lineSrc = map.getSource('wallas-tile-network');
  if (lineSrc) lineSrc.setData(lines || { type: 'FeatureCollection', features: [] });
  const outletSrc = map.getSource('wallas-tile-outlets');
  if (outletSrc) outletSrc.setData(outlets || { type: 'FeatureCollection', features: [] });
}
export function setTileNetworkVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['wallas-tile-network-line', 'wallas-tile-outlet-point']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

export function setIrrigationData(map, fc) {
  const src = map.getSource('wallas-irrigation');
  if (src) src.setData(fc);
}
export function setIrrigationVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['wallas-irrigation-fill', 'wallas-irrigation-line']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

export function setCliAgrData(map, fc) {
  const src = map.getSource('cli-agr');
  if (src) src.setData(fc);
}
export function setCliAgrVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['cli-agr-fill', 'cli-agr-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

// CLI tri-state mode mirror. main.js's toggleCliOverlay owns the cycle
// (null → 'capability' → 'identity' → null); it broadcasts each change
// in here so readOverlaysAt can stamp the right label onto muniParcelHtml
// hover/click popups without main.js having to leak into map.js. Stays
// null when the CLI layer is off — readOverlaysAt skips the CLI block
// in that case, same as it does for any hidden overlay.
let currentCliPaintMode = null;
export function setCliPaintMode(mode) {
  currentCliPaintMode = mode || null;
}

export function setSoilSurveyData(map, fc) {
  const src = map.getSource('soil-survey');
  if (src) src.setData(fc);
}
export function setSoilSurveyLabelsData(map, fc) {
  const src = map.getSource('soil-survey-labels');
  if (src) src.setData(fc);
}
export function setSoilSurveyVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['soil-survey-fill', 'soil-survey-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

export function setSurveyGridData(map, fc) {
  const src = map.getSource('survey-grid');
  if (src) src.setData(fc);
  // Push a parallel Point FC into the dedicated label source. Each
  // input polygon (DLS section) becomes one Point at its centroid —
  // labels rendered from a Point can't be tile-clipped into multiple
  // copies the way a Polygon can. River-lot features (kind='riverlot')
  // are filtered out so they don't get section-style labels.
  const ptSrc = map.getSource('survey-grid-points');
  if (ptSrc) ptSrc.setData(sectionLabelPointsFc(fc));
}

function sectionLabelPointsFc(fc) {
  const out = [];
  for (const f of fc?.features || []) {
    if (f?.properties?.kind === 'riverlot') continue;
    const c = polygonCentroid(f);
    if (!c) continue;
    out.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: c },
      properties: { ...(f.properties || {}) },
    });
  }
  return { type: 'FeatureCollection', features: out };
}

function polygonCentroid(f) {
  const coords = f?.geometry?.coordinates?.[0];
  if (!Array.isArray(coords) || coords.length === 0) return null;
  let cx = 0, cy = 0, n = 0;
  // Skip the closing duplicate point (last == first in a GeoJSON
  // ring) so the average isn't biased.
  const last = coords.length - 1;
  const ringEnd = (
    coords[last] && coords[0]
    && coords[last][0] === coords[0][0]
    && coords[last][1] === coords[0][1]
  ) ? last : coords.length;
  for (let i = 0; i < ringEnd; i++) {
    const p = coords[i];
    if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
      cx += p[0]; cy += p[1]; n++;
    }
  }
  return n > 0 ? [cx / n, cy / n] : null;
}
export function setSurveyGridVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['survey-grid-line', 'survey-grid-riverlot', 'survey-grid-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

/**
 * Feature id for each municipality, keyed by MUNI_LIST_NAME_WITH_TYPE —
 * the field the Property Search dropdown's values match against. Built
 * when the boundaries FC lands, and needed because setFeatureState
 * addresses features by id, not by a property value.
 */
let muniBoundaryIdByName = new Map();

/** The id currently carrying the `selected` state, so clearing it is one
 *  write rather than a sweep across all ~190 municipalities. */
let muniBoundarySelectedId = null;

export function setMuniBoundariesData(map, fc) {
  // Positional ids: MUNI_LIST_NAME_WITH_TYPE is the natural key but is a
  // string, and MapLibre feature ids must be numeric to be addressable
  // by setFeatureState. Stamp the index and keep the name lookup beside it.
  muniBoundaryIdByName = new Map();
  // New data means every feature-state is gone; forget which id held the
  // selection so the next clear doesn't write to a stale one.
  muniBoundarySelectedId = null;
  (fc?.features || []).forEach((f, i) => {
    f.id = i;
    const name = f.properties?.MUNI_LIST_NAME_WITH_TYPE;
    if (name) muniBoundaryIdByName.set(String(name), i);
  });
  const src = map.getSource('muni-boundaries');
  if (src) src.setData(fc);
}

/**
 * Paint the blue "selected" outline on one municipality, clearing any
 * previous one. Pass a falsy name to clear the selection outright.
 *
 * The name is matched against MUNI_LIST_NAME_WITH_TYPE; callers holding a
 * Roll-Entry `Muni_Name_With_Typ` value that differs in punctuation should
 * resolve it first (main.js owns that tolerant match). An unmatched name
 * clears rather than throwing — the outline is a cue, not state.
 */
export function setMuniBoundarySelected(map, muniName) {
  if (!map.getSource('muni-boundaries')) return;
  if (muniBoundarySelectedId != null) {
    map.setFeatureState(
      { source: 'muni-boundaries', id: muniBoundarySelectedId },
      { selected: false },
    );
    muniBoundarySelectedId = null;
  }
  const id = muniName ? muniBoundaryIdByName.get(String(muniName)) : undefined;
  if (id == null) return;
  map.setFeatureState({ source: 'muni-boundaries', id }, { selected: true });
  muniBoundarySelectedId = id;
}

/**
 * Click a municipality on the map to drive the Property Search dropdown —
 * the same "point at it rather than find it in a list of 180" affordance
 * the Sales Analysis tab has.
 *
 * `isEnabled()` is consulted on every event rather than the handlers being
 * attached and detached, so the caller can gate it on live state (which tab
 * is showing, whether a search has already run) without re-wiring. While it
 * returns false the layer is inert: no pointer cursor, no hover tint, no
 * click — it must not look clickable when it isn't.
 *
 * `onPick(muniName)` receives the MUNI_LIST_NAME_WITH_TYPE value.
 */
export function wireMuniBoundaryPicker(map, { onPick, isEnabled } = {}) {
  // The gating logic lives in lib/muniPicker.js so it can be tested under
  // node — this file can't be, and the map needs a compositing canvas to
  // initialise at all. Everything here is the MapLibre plumbing.
  const picker = createMuniPicker({
    isEnabled,
    onPick,
    setHover: (id, on) => {
      if (id == null) return;
      map.setFeatureState({ source: 'muni-boundaries', id }, { hover: on });
    },
    setCursor: (cursor) => { map.getCanvas().style.cursor = cursor; },
  });

  map.on('mousemove', 'muni-boundaries-fill', (e) => picker.mouseMove(e.features?.[0]?.id));
  map.on('mouseleave', 'muni-boundaries-fill', () => picker.mouseLeave());
  map.on('click', 'muni-boundaries-fill', (e) => {
    // Shape tools own the click while armed, exactly as the parcel popup
    // stands down for them.
    if (shapeClickHandled(map, e)) return;
    picker.click(e.features?.[0]?.properties?.MUNI_LIST_NAME_WITH_TYPE);
  });

  // Gating is state the caller changes at will; expose the nudge so a
  // freshly-disabled layer drops its stale hover tint immediately rather
  // than at the next mouse move.
  return { refresh: () => picker.refresh() };
}

export function setMuniParcelsData(map, fc) {
  const src = map.getSource('muni-parcels');
  if (src) src.setData(fc);
  // Build a parallel Point FC: one Point feature per parcel at its
  // bbox-midpoint centroid, carrying the same properties (so the
  // label symbol layers can still read _rollDisplay, _civicAddress,
  // _acres, etc.). See the comment on the muni-parcels-labels source
  // in initMap for why this is necessary — tile-clipped Polygon
  // fragments cause duplicate label placement at high zoom.
  const labelSrc = map.getSource('muni-parcels-labels');
  if (labelSrc) {
    const features = [];
    for (const f of fc?.features || []) {
      const c = polygonBboxMidpoint(f.geometry);
      if (!c) continue;
      features.push({
        type: 'Feature',
        properties: f.properties || {},
        geometry: { type: 'Point', coordinates: c },
      });
    }
    labelSrc.setData({ type: 'FeatureCollection', features });
  }
}

/** Bbox midpoint of any Polygon / MultiPolygon geometry. Cheap
 *  approximation of a centroid — exact enough for label placement
 *  (we only need a point within or near the polygon). Returns null
 *  for missing or non-polygon geometries. */
function polygonBboxMidpoint(geometry) {
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

/**
 * Wire up a `.parcel-coords-copy` anchor inside the supplied popup so
 * clicking it copies the centroid as "lat, lng" (six-decimal precision)
 * to the clipboard. Briefly flips the link text to "Copied!" to confirm.
 * The popup's getElement() is the rendered DOM container; querying for
 * the anchor from there scopes the listener to THIS popup instance
 * (multiple popups stacked from different layers each get their own).
 */
function wireCoordsCopy(popup, lngLat) {
  if (!popup || !Array.isArray(lngLat)) return;
  const el = popup.getElement?.();
  const anchor = el?.querySelector('.parcel-coords-copy');
  if (!anchor) return;
  const [lng, lat] = lngLat;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
  const text = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  anchor.addEventListener('click', (ev) => {
    ev.preventDefault();
    const onSuccess = () => {
      const original = anchor.textContent;
      anchor.textContent = 'Copied!';
      setTimeout(() => { anchor.textContent = original; }, 1500);
    };
    const onFailure = () => { anchor.textContent = 'Copy failed'; };
    // navigator.clipboard requires a secure context (HTTPS / localhost);
    // fall back to the legacy execCommand path on http://0.0.0.0-style
    // dev hosts where it's missing.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(onSuccess, onFailure);
    } else {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        onSuccess();
      } catch { onFailure(); }
    }
  });
}

/** Wire the click-popup action that reveals this parcel's results-table row. */
function wireJumpToList(popup, rowKey, onFeatureClick) {
  if (rowKey == null || typeof onFeatureClick !== 'function') return;
  const anchor = popup.getElement?.()?.querySelector('.parcel-jump-to-list');
  if (!anchor) return;
  anchor.addEventListener('click', (ev) => {
    ev.preventDefault();
    // Keep this popup-only action from bubbling back through the map's
    // parcel click handlers. The table callback must have exactly one
    // invocation path: this explicit link.
    ev.stopPropagation();
    onFeatureClick(rowKey);
  });
}

export function setMuniParcelsVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['muni-parcels-fill', 'muni-parcels-line', 'muni-parcels-label', 'muni-parcels-civic-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

/**
 * Force the basemap to satellite (Esri imagery + reference/transportation
 * overlays) or back to streets (CARTO Voyager). Same layer-visibility swap
 * the top-right basemap menu performs, exposed as a function so the
 * offscreen snapshot-export map can switch to satellite without a UI control.
 */
export function setBasemapSatellite(map, on) {
  const imgVis = on ? 'visible' : 'none';
  const cartoVis = on ? 'none' : 'visible';
  for (const id of ['esri-imagery', 'esri-transportation', 'esri-reference']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', imgVis);
  }
  if (map.getLayer('carto-voyager')) {
    map.setLayoutProperty('carto-voyager', 'visibility', cartoVis);
  }
  if (map.getLayer('nrcan-elevation')) {
    map.setLayoutProperty('nrcan-elevation', 'visibility', 'none');
  }
  for (const id of ['nrcan-transportation-geometry', 'nrcan-transportation-labels']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  }
  // The optional aerial ortho (present only when configured) underlays Esri
  // outside MLI coverage. Force it off here so callers that request satellite,
  // notably snapshot export, get deterministic Esri imagery. The menu re-shows
  // it only for the explicit MLI state.
  if (map.getLayer('ortho-mb')) map.setLayoutProperty('ortho-mb', 'visibility', 'none');
}

/** Show / hide the Wayback historical-imagery basemap layer. */
export function setWaybackVisible(map, on) {
  if (map.getLayer('wayback-imagery')) {
    map.setLayoutProperty('wayback-imagery', 'visibility', on ? 'visible' : 'none');
  }
}

/** Swap the Wayback source to a specific release's tiles in place. Uses
 *  RasterTileSource.setTiles so the source (and its place in the layer
 *  stack) stays put — no remove/re-add flicker. */
export function setWaybackRelease(map, release) {
  const src = map.getSource('wayback');
  if (src && typeof src.setTiles === 'function') {
    src.setTiles([waybackTileUrl(release)]);
  }
}

/**
 * Show / hide the land-cover overlay fill (result parcels coloured by
 * dominant 2020 land-cover bucket). The colour comes from each parcel's
 * `_lcColor`, stamped in main.js; this only flips the layer's visibility.
 */
export function setLandCoverVisible(map, on) {
  const vis = on ? 'visible' : 'none';
  for (const id of ['landcover-fill', 'muni-parcels-landcover-fill']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  }
}

/**
 * Show / hide the water-influence overlay (result parcels coloured by
 * waterfront classification, plus a same-colour outline so the parcel still
 * reads under a zoning or dev-plan fill). Colour comes from each parcel's
 * `_waterColor`, stamped in main.js from the water shards; this only flips
 * visibility.
 *
 * Unlike the land-cover toggle there is no muni-wide fabric twin — the water
 * shards are stamped onto the RESULT SET only, so painting the whole fabric
 * would show a mostly-empty layer that silently disagrees with the grid.
 */
export function setWaterInfluenceVisible(map, on) {
  const vis = on ? 'visible' : 'none';
  for (const id of ['water-fill', 'water-outline']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  }
  // Suppress the generic yellow result fill while water colouring is on.
  // `water-fill` paints at 0.7 OVER `parcel-fill`'s #ffea00, so the yellow
  // tinted through every water colour — blues came out muddied and greenish,
  // and the paler the class the worse it got. Silencing the yellow is what
  // lets a genuinely light near-water blue read as blue.
  //
  // Opacity, NOT visibility: `parcel-fill` is the hit-test layer for parcel
  // hover and click (queryRenderedFeatures against 'parcel-fill' in several
  // handlers below), and `visibility: none` would drop it out of those
  // queries and kill the popups. A zero-opacity layer still hit-tests.
  if (map.getLayer('parcel-fill')) {
    map.setPaintProperty('parcel-fill', 'fill-opacity', on ? 0 : PARCEL_FILL_OPACITY);
  }
}

// Year the historical layers are currently showing — read by the historical
// click popups so each tooltip can state its as-of year.
let historicalYear = null;
// by_roll lineage map for the loaded muni (predecessors/successors per roll).
let historicalLineage = null;
// roll → today's MAO assessment-report URL (Map), stamped from the current
// muni fetch in main.js. Lets popups link a historical roll (and its lineage
// "→ became" rolls) to the CURRENT MAO page.
let historicalCurrentUrls = null;

/**
 * Feed the historical (as-of-date) compare layers. `data` carries any of
 * { parcels, zoning, devplan } GeoJSON FeatureCollections (or null to clear
 * that layer) plus the `year` they're from, the `lineage` by_roll map, and
 * `currentUrls` (roll → today's MAO URL). main.js fetches these for the muni.
 */
export function setHistoricalData(map, data = {}) {
  historicalYear = data.year ?? historicalYear;
  if ('lineage' in data) historicalLineage = data.lineage;
  if ('currentUrls' in data) historicalCurrentUrls = data.currentUrls;
  const set = (srcId, fc) => { const s = map.getSource(srcId); if (s) s.setData(fc || emptyFc()); };
  set('historical-parcels', data.parcels);
  set('historical-zoning',  data.zoning);
  set('historical-devplan', data.devplan);
  // Colour each polygon by its own category, so the layer shows the muni's
  // actual mix instead of one flat wash. Returned for the legend.
  historicalZoningLegend  = setHistoricalCategoryPaint(map, 'historical-zoning-fill',  data.zoning,  'ZONE',     '#7c3aed');
  historicalDevplanLegend = setHistoricalCategoryPaint(map, 'historical-devplan-fill', data.devplan, 'DES_NAME', '#0d9488');
}

// Legend rows for whatever the last setHistoricalData() loaded — [{code, color}],
// read by main.js to render the swatch list beside the map.
let historicalZoningLegend = [];
let historicalDevplanLegend = [];
export function getHistoricalLegend(which) {
  return which === 'zoning' ? historicalZoningLegend : historicalDevplanLegend;
}

/**
 * Paint one historical fill layer by a categorical property.
 *
 * Colours come from `colorForZoneCode`, the SAME hash palette the live zoning
 * overlay uses, so a given zone code is the identical colour in the historical
 * and current views. That is the point: comparing eras means comparing
 * colours, and a per-layer palette would have made RSD-then and RSD-now look
 * like different zones.
 *
 * @returns {Array<{code:string,color:string}>} legend rows, sorted by code.
 */
function setHistoricalCategoryPaint(map, layerId, fc, field, fallback) {
  if (!map.getLayer(layerId)) return [];
  const codes = new Set();
  for (const f of fc?.features || []) {
    const v = String(f?.properties?.[field] ?? '').trim();
    if (v && v !== 'null') codes.add(v);
  }
  const sorted = [...codes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const legend = sorted.map((code) => ({ code, color: colorForZoneCode(code) }));
  // `match` needs at least one pair; with none, fall back to the flat colour.
  if (legend.length === 0) {
    map.setPaintProperty(layerId, 'fill-color', fallback);
    return [];
  }
  const pairs = [];
  for (const { code, color } of legend) pairs.push(code, color);
  map.setPaintProperty(layerId, 'fill-color',
    ['match', ['coalesce', ['get', field], ''], ...pairs, fallback]);
  return legend;
}

// Today's MAO URL for a roll, if that roll still exists in current data.
function currentMaoUrl(roll) {
  if (!roll || !historicalCurrentUrls) return null;
  const u = historicalCurrentUrls.get ? historicalCurrentUrls.get(roll) : historicalCurrentUrls[roll];
  return safeExternalUrl(u);
}

// Render a roll as a link to its CURRENT MAO page when one exists, else plain.
function rollMaoLink(roll, title) {
  const txt = escapeHtml(String(roll));
  const safe = currentMaoUrl(roll);
  return safe
    ? `<a href="${safe}" target="_blank" rel="noreferrer" title="${escapeHtml(title)}">${txt}</a>`
    : txt;
}

// Inferred lineage block for a historical parcel popup (from the by_roll map).
function lineageHtml(roll) {
  const rec = historicalLineage ? historicalLineage[roll] : null;
  if (!rec) return '';
  // Successors ("→ became") are TODAY's parcels — link each to its current MAO
  // page. Predecessors ("← from") are older rolls that usually no longer exist,
  // so they stay plain text.
  const list = (arr, max = 6, linked = false) => {
    const rolls = (arr || []).map((x) => x.roll);
    const shown = rolls.slice(0, max).map((r) =>
      linked ? rollMaoLink(r, `Open roll ${r} on Manitoba Assessment Online (current)`) : escapeHtml(String(r)));
    const extra = rolls.length > max ? ` +${rolls.length - max} more` : '';
    return shown.join(', ') + extra;
  };
  const rows = [];
  if (rec.predecessors?.length) rows.push(`<strong>← from</strong> ${list(rec.predecessors)}`);
  if (rec.successors?.length)   rows.push(`<strong>→ became</strong> ${list(rec.successors, 6, true)} (${rec.successors.length})`);
  if (!rows.length) return '';
  const conf = Number.isFinite(rec.confidence) ? ` · ${Math.round(rec.confidence * 100)}% conf` : '';
  return `<div style="margin-top:5px;border-top:1px solid #eee;padding-top:4px">`
    + `<strong style="color:#b45309">Lineage</strong> <span style="color:#888">(${escapeHtml(rec.type || '')}${conf})</span><br>`
    + rows.join('<br>')
    + `<br><small style="color:#888">Inferred from geometry — verify against the registered plan / title.</small></div>`;
}

/**
 * The three historical context layers, each independently switchable.
 *
 * They are separate controls because each one blankets the WHOLE
 * municipality: the zoning and dev-plan fills were ~90% of the translucent
 * wash between them, over a parcel fabric that outlines every lot in the muni
 * in dashed amber. Switching all three on together buried the parcel the user
 * had just searched for (Jason, 2026-08-13). None is on by default now — see
 * main.js `historicalLayersOn`.
 *
 * Note the searched parcel's own as-of boundary does NOT live here. That is
 * the yellow result highlight, driven by lib/historicalHighlight.js, and it
 * shows whenever an as-of date is active regardless of these toggles.
 */
export const HISTORICAL_LAYER_IDS = {
  parcels: ['historical-parcels-fill', 'historical-parcels-line'],
  zoning:  ['historical-zoning-fill'],
  devplan: ['historical-devplan-fill'],
};

/** Show/hide ONE historical context layer. `key` indexes HISTORICAL_LAYER_IDS. */
export function setHistoricalLayerVisible(map, key, on) {
  const vis = on ? 'visible' : 'none';
  for (const id of HISTORICAL_LAYER_IDS[key] || []) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  }
}

/**
 * Master switch — hides every historical context layer at once.
 *
 * Only ever called with `false` now (deactivating Historical). Turning the
 * overlay ON applies the per-layer state instead, so the caller decides what
 * comes back rather than everything doing so unbidden.
 */
export function setHistoricalVisible(map, on) {
  for (const key of Object.keys(HISTORICAL_LAYER_IDS)) {
    setHistoricalLayerVisible(map, key, on);
  }
}

function historicalParcelHtml(p, year) {
  const lines = [`<strong style="color:#b45309">Historical parcel${year ? ` (${escapeHtml(year)})` : ''}</strong>`];
  if (p.Roll_No_Txt) {
    // Link the roll to TODAY's MAO page when the parcel still exists (current
    // URL harvested in main.js); else fall back to the archived report URL the
    // snapshot carried; else plain text.
    const safe = currentMaoUrl(p.Roll_No_Txt) || safeExternalUrl(p.Asmt_Rpt_Url);
    const rollTxt = escapeHtml(p.Roll_No_Txt);
    lines.push(`<strong>Roll #</strong> ` + (safe
      ? `<a href="${safe}" target="_blank" rel="noreferrer" title="Open this roll on Manitoba Assessment Online${currentMaoUrl(p.Roll_No_Txt) ? ' (current)' : ' (as-of snapshot)'}">${rollTxt}</a>`
      : rollTxt));
  }
  if (p.Property_Address)   lines.push(escapeHtml(p.Property_Address));
  if (p.Muni_Name_With_Typ) lines.push(`<em>${escapeHtml(p.Muni_Name_With_Typ)}</em>`);
  if (p.Frontage_or_Area)   lines.push(`<strong>Area</strong> ${escapeHtml(p.Frontage_or_Area)}`);
  if (p.Total_Value)        lines.push(`<strong>Assessed</strong> ${escapeHtml(p.Total_Value)}`);
  if (p.Asmt_Roll)          lines.push(`<small style="color:#777">${escapeHtml(p.Asmt_Roll)}</small>`);
  lines.push('<small style="color:#888">Display geometry simplified — verify boundary/area against the archived source-of-record.</small>');
  return `<div class="parcel-popup">${lines.join('<br>')}${sizeChangeHtml(p)}${lineageHtml(p.Roll_No_Txt || '')}</div>`;
}

// Size-change block: this snapshot's acreage vs today's for the same roll
// (stamped in main.js). Pointer to investigate, NOT proof — a change can be a
// real subdivision/consolidation, a re-survey/geometry correction, or (for
// frontage-only parcels) a simplification artifact.
function sizeChangeHtml(p) {
  const band = p._sizeBand;
  if (!band || band === 'same' || band === 'unknown') return '';
  const color = band === 'major' ? '#dc2626' : band === 'minor' ? '#ea580c' : '#6b7280';
  const ac = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
  let body;
  if (band === 'gone') {
    body = `roll not present in current data (removed / merged away)`;
  } else {
    const d = Number(p._deltaPct);
    const sign = d > 0 ? '+' : '';
    body = `${ac(Number(p._histAcres))} ac → ${ac(Number(p._curAcres))} ac `
      + `(<strong>${sign}${Number.isFinite(d) ? d.toFixed(0) : '?'}%</strong>)`;
  }
  return `<div style="margin-top:5px;border-top:1px solid #eee;padding-top:4px">`
    + `<strong style="color:${color}">Size change</strong> ${body}`
    + `<br><small style="color:#888">Could be subdivision/consolidation, re-survey, or (frontage-only) a simplification artifact — verify against the registered plan / title.</small></div>`;
}

function historicalZoningHtml(p, year) {
  const lines = [`<strong style="color:#7c3aed">Historical zoning${year ? ` (${escapeHtml(year)})` : ''}</strong>`];
  if (p.ZONE || p.ZONE_NAME) lines.push(`<strong>${escapeHtml(p.ZONE || '')}</strong>${p.ZONE_NAME ? ' — ' + escapeHtml(p.ZONE_NAME) : ''}`);
  if (p.ZONE_CATEGORY)       lines.push(`<em>${escapeHtml(p.ZONE_CATEGORY)}</em>`);
  if (p.ZBL)                 lines.push(`<strong>By-law</strong> ${escapeHtml(p.ZBL)}`);
  lines.push('<small style="color:#888">Pointer only — verify the by-law as of this date with the municipality / planning district.</small>');
  return `<div class="parcel-popup">${lines.join('<br>')}</div>`;
}

function historicalDevplanHtml(p, year) {
  const lines = [`<strong style="color:#0d9488">Historical dev-plan${year ? ` (${escapeHtml(year)})` : ''}</strong>`];
  if (p.DES_NAME)     lines.push(`<strong>${escapeHtml(p.DES_NAME)}</strong>`);
  if (p.DES_CATEGORY) lines.push(`<em>${escapeHtml(p.DES_CATEGORY)}</em>`);
  if (p.DP_BYLAW)     lines.push(`<strong>By-law</strong> ${escapeHtml(p.DP_BYLAW)}`);
  lines.push('<small style="color:#888">Pointer only — verify the designation as of this date with the planning district.</small>');
  return `<div class="parcel-popup">${lines.join('<br>')}</div>`;
}

/**
 * Show / hide the pixel-level land-cover raster overlay (Detailed mode).
 * Source is the local XYZ pyramid produced by r/build_landcover_tiles.R;
 * MapLibre silently 404s missing tiles, so the webapp gates the Detailed
 * tri-state branch behind the manifest probe in main.js — once the
 * pyramid is built and the manifest lands, this setter is fed by the
 * Land Cover toggle's Detailed state.
 */
export function setLandCoverRasterVisible(map, on) {
  if (map.getLayer('landcover-raster')) {
    map.setLayoutProperty('landcover-raster', 'visibility', on ? 'visible' : 'none');
  }
}

/** Set the land-cover raster opacity (0-1). Drives the legend's opacity
 *  slider so the user can dial in how strongly the cover paints against
 *  the basemap underneath. */
export function setLandCoverRasterOpacity(map, opacity) {
  if (map.getLayer('landcover-raster')) {
    map.setPaintProperty('landcover-raster', 'raster-opacity', opacity);
  }
}

// ---------- popup builders ----------

export function parcelHtml(p, { showJumpToList = false } = {}) {
  const lines = [];
  // Subject parcel gets a distinctive blue header above the standard
  // identity block. _isSubject is stamped onto the subject feature by
  // main.js's applySubjectFromInput so subjectHtml() (the dedicated
  // builder for the subject popup) and this fallback share a single
  // signal for "render this as the subject."
  if (p._isSubject) {
    lines.push('<strong style="color:#1e6fd9">Subject parcel</strong>');
  }
  if (p.Roll_No_Txt) {
    // Roll # is hyperlinked to the Manitoba Assessment Online report
    // for this parcel — the natural single-click destination for
    // "open the assessment report" instead of stashing the link at
    // the bottom of the popup. Falls back to plain text when there's
    // no report URL on the parcel feature.
    const display = escapeHtml(rollDisplayFor(p));
    const safeReport = safeExternalUrl(p.Asmt_Rpt_Url);
    const rollLine = safeReport
      ? `<a href="${escapeHtml(safeReport)}" target="_blank" rel="noreferrer" title="Open Manitoba Assessment report">${display}</a>`
      : display;
    lines.push(`<strong>Roll #</strong> ${rollLine}`);
  }
  if (p.Property_Address)   lines.push(escapeHtml(p.Property_Address));
  if (p.Muni_Name_With_Typ) lines.push(`<em>${escapeHtml(p.Muni_Name_With_Typ)}</em>`);
  // As-of boundary. With the Historical overlay on, the highlight traces this
  // parcel as it stood at the snapshot date while every attribute below it —
  // address, value, area, legal, land cover — is still TODAY's record. Say so
  // right under the identity block: on a parcel that has been subdivided since,
  // the shape and the numbers describe two different things.
  if (p._asOfGeom) {
    lines.push(
      `<strong style="color:#b45309">Boundary as of ${escapeHtml(p._asOfDate || 'the selected snapshot')}</strong>`
      + '<br><small style="color:#888">Details below are current. Display geometry simplified —'
      + ' verify boundary/area against the archived source-of-record.</small>',
    );
  }
  // Sale Date / Sale Price / Primary Property — populated only when
  // this parcel was surfaced via a sales-CSV upload
  // (handleSalesUpload in main.js stamps these onto each matched
  // feature). Sale info reads first because it's the appraisal-
  // relevant payload of the upload. Sold and Price get their own
  // lines so the price reads cleanly when it's a long figure.
  if (p._saleDate)  lines.push(`<strong>Sold</strong> ${escapeHtml(p._saleDate)}`);
  if (p._salePrice) lines.push(`<strong>Price</strong> ${escapeHtml(p._salePrice)}`);
  // Repeat sale — the upload holds more than one transaction for this
  // parcel, but only the most recent one's feature is drawn (the map
  // shows each parcel once). Listing the full history here keeps the
  // popup from implying the parcel sold only once; every sale also has
  // its own row in the results table.
  const saleCount = Number(p._saleCount);
  if (Number.isFinite(saleCount) && saleCount > 1 && p._saleHistoryText) {
    lines.push(
      `<strong>${saleCount} sales in this upload</strong> ${escapeHtml(p._saleHistoryText)}`,
    );
  }
  // Far-flung warning. main.js stamps `_farFlungReason` at render time
  // (it depends on the user's current threshold, not on anything
  // intrinsic to the parcel), so the popup shows exactly what the grid
  // badge shows. Absent when the sale isn't flagged.
  if (p._farFlungReason) {
    lines.push(`<strong>⚠ ${escapeHtml(p._farFlungReason)}</strong>`);
  }
  if (p._primaryProperty) {
    lines.push(`<strong>Primary Property</strong> ${escapeHtml(p._primaryProperty)}`);
  }
  // Multi-parcel sale: list every roll # in the sale on a single line
  // formatted as `Parcels: (N) — roll1, roll2, …`. Only shown when the
  // group has more than one parcel — for a single-parcel sale the
  // existing Roll # line at the top already covers it. The per-rate
  // breakdown (Price/SF · Price/Acre · Price/Lot) is appended at the
  // very bottom of the popup below, after the parcel-detail lines, so
  // those summary rates are easy to find regardless of group size.
  const groupSize = Number(p._saleGroupSize);
  if (Number.isFinite(groupSize) && groupSize > 1) {
    const rolls = readSaleGroupRolls(p);
    if (rolls && rolls.length > 0) {
      lines.push(`<strong>Parcels:</strong> (${escapeHtml(groupSize)}) — ${escapeHtml(rolls.join(', '))}`);
    } else {
      // Fallback when the rolls list didn't survive tile encoding — keeps
      // the user informed of the group size at least.
      lines.push(`<strong>Parcels:</strong> (${escapeHtml(groupSize)})`);
    }
  }
  if (p._legalDescription)  lines.push(`<strong>Legal</strong> ${escapeHtml(p._legalDescription)}`);
  if (p._certificatesOfTitle) lines.push(`<strong>Title</strong> ${escapeHtml(p._certificatesOfTitle)}`);
  // Land Size — _acres stamped onto each parcel feature by main.js
  // after the search lands (same shape as the muni-parcels-fill
  // popup). Format mirrors muniParcelHtml so both popups read the
  // same on the same parcel.
  const landSize = formatLandSize(p._acres);
  if (landSize) lines.push(`<strong>Land Size</strong> ${landSize}`);
  // What the roll itself states. Worth its own line rather than folding into
  // Land Size above: on a frontage-feet parcel the two say different KINDS of
  // thing (a width vs a computed area), and on an acres parcel showing them
  // together is how a disputed figure becomes visible.
  const rollSize = formatRollSizeField(p.Frontage_or_Area);
  if (rollSize) lines.push(`<strong>Roll States</strong> ${escapeHtml(rollSize)}`);
  // Flag the nominal-roll guard: the assessor area looked like a placeholder
  // (e.g. "0.01 Acres" on a large polygon), so the figure above is the
  // geometry area, not the roll. Surfaced so the appraiser doesn't mistake it.
  if (p._acresRollNominal) {
    const rv = Number(p._rollNominalAcres);
    lines.push(`<small style="color:#b45309">⚠ roll area looks nominal`
      + `${Number.isFinite(rv) ? ` (states ${rv} ac)` : ''} — showing geometry area; verify against plan/title.</small>`);
  }
  // Roll and polygon disagree by more than the tolerance. Show both figures:
  // which one is right isn't knowable from here, and a subdivision that has
  // reached only one half of the provincial record looks exactly like this.
  else if (p._acresMismatch) {
    const gv = Number(p._acresGeomValue);
    const pct = Number(p._acresVariancePct);
    lines.push(`<small style="color:#b45309">⚠ roll area disagrees with parcel shape`
      + `${Number.isFinite(gv) ? ` (shape measures ${gv.toFixed(1)} ac` : ''}`
      + `${Number.isFinite(pct) ? `, ${(pct * 100).toFixed(0)}% apart)` : ')'}`
      + ` — verify on MAO.</small>`);
  }
  // Current zoning and DU get separate lines so both regular-search and
  // Sales Analysis popups present zoning immediately before DU. Zoning is
  // stamped by main.js after its area-weighted join; Sales Analysis runs
  // the same full enrichment before enabling export.
  if (p._zoneCode) {
    lines.push(`<strong>Zoning</strong> ${escapeHtml(p._zoneCode)}`);
  }
  if (p.Dwelling_Units != null) {
    lines.push(`<strong>DU</strong> ${escapeHtml(p.Dwelling_Units)}`);
  }
  // GPS Coordinates link sits right under Zoning/DU so
  // it's discoverable without scrolling to the bottom of the popup.
  // .parcel-coords-copy is wired by the click handler in initMap to
  // copy the parcel centroid to the clipboard; the hover popup
  // renders the same line but mouse-out closes the popup before the
  // user can click, so it's effectively click-only — same UX as the
  // previous bottom-of-popup placement.
  lines.push(`<a href="#" class="parcel-coords-copy" role="button" title="Copy parcel centroid (lat, lng) to clipboard">GPS Coordinates</a>`);
  if (showJumpToList) {
    lines.push(`<a href="#" class="parcel-jump-to-list" role="button" title="Scroll to this parcel in the results table">Jump to parcel in list</a>`);
  }
  // Pending amendment text — same shape as the Changes column in the
  // table (stamped onto the parcel feature by enrichOverlays via
  // formatChanges(row)). Only emit when there's actually a change to
  // report; null/empty parcels skip the line entirely.
  if (p._changesText) {
    lines.push(`<strong style="color:#1a3a4a">Changes</strong> ${escapeHtml(p._changesText)}`);
  }
  // Per-parcel assessment block — surfaces the latest-year Land /
  // Buildings / Total / Class so the user can sanity-check whether
  // each comp (or the subject) is actually vacant land vs partially
  // improved. Only shown when the parcel has an assessment record
  // attached (_asmtTotal set). Class line is suppressed when empty
  // so urban parcels missing the dominant-class field don't carry
  // a `Class: ` line with nothing after it.
  if (p._asmtTotal != null && Number(p._asmtTotal) > 0) {
    const land = Number(p._asmtLand);
    const bldg = Number(p._asmtBuildings);
    const tot  = Number(p._asmtTotal);
    const pct  = Number(p._asmtPctBldg);
    const yr   = Number(p._asmtYear);
    const moneyOrDash = (n) => Number.isFinite(n) && n > 0 ? '$' + Math.round(n).toLocaleString('en-US') : '$0';
    const yrLabel = Number.isFinite(yr) ? ` (${yr})` : '';
    lines.push(`<strong>Assessment${yrLabel}</strong>`);
    const pctLabel = Number.isFinite(pct) ? ` · ${(pct * 100).toFixed(1)}% bldg` : '';
    lines.push(`Land ${escapeHtml(moneyOrDash(land))} &nbsp;·&nbsp; Bldg ${escapeHtml(moneyOrDash(bldg))} &nbsp;·&nbsp; Total ${escapeHtml(moneyOrDash(tot))}${escapeHtml(pctLabel)}`);
    if (p._asmtClass) {
      const statusLabel = p._asmtStatus ? ` · ${p._asmtStatus}` : '';
      lines.push(`<em>${escapeHtml(p._asmtClass)}${escapeHtml(statusLabel)}</em>`);
    }
  }
  // Bottom-anchored sale rate breakdown. Appears whenever a sale
  // price is present (single-parcel and multi-parcel sales alike) —
  // the lot count in parentheses behind Price/Lot makes single-vs-
  // multi-parcel sales visually distinguishable. Price/SF and
  // Price/Acre suppress to em-dash when group acres are incomplete
  // (one or more sibling parcels missing _acres) so a misleading
  // partial-acreage rate doesn't slip through.
  if (p._salePrice && Number.isFinite(groupSize) && groupSize > 0) {
    const ppsf = Number(p._saleGroupPpsf);
    const ppa  = Number(p._saleGroupPpa);
    const ppl  = Number(p._saleGroupPpl);
    const ppsfFmt = (Number.isFinite(ppsf) && ppsf > 0)
      ? '$' + ppsf.toFixed(2)
      : (p._saleGroupAcresIncomplete ? '—' : null);
    const ppaFmt  = (Number.isFinite(ppa) && ppa > 0)
      ? '$' + Math.round(ppa).toLocaleString('en-US')
      : (p._saleGroupAcresIncomplete ? '—' : null);
    const pplFmt  = (Number.isFinite(ppl) && ppl > 0)
      ? '$' + Math.round(ppl).toLocaleString('en-US')
      : null;
    // The land the price bought, stated before the rates derived from it.
    // On a multi-parcel sale this is NOT the Land Size shown above — that is
    // this parcel alone — and Price/Acre divides by this one, so leaving it
    // out meant the popup asserted a rate whose denominator appeared nowhere.
    // Labelled "Total land" rather than "Acres" so the two can't be confused,
    // and suppressed to an em-dash on an incomplete group for the same reason
    // the rates are: a partial total reads as a whole one.
    // formatLandSize already returns null for a non-positive total.
    const gAcresFmt = p._saleGroupAcresIncomplete
      ? '—'
      : formatLandSize(p._saleGroupTotalAcres);
    if (gAcresFmt && groupSize > 1) {
      lines.push(`<strong>Total land (${escapeHtml(groupSize)} parcels)</strong> ${gAcresFmt}`);
    }
    if (ppsfFmt) lines.push(`<strong>Price/SF</strong> ${escapeHtml(ppsfFmt)}`);
    if (ppaFmt)  lines.push(`<strong>Price/Acre</strong> ${escapeHtml(ppaFmt)}`);
    if (pplFmt)  lines.push(`<strong>Price/Lot</strong> ${escapeHtml(pplFmt)} (${escapeHtml(groupSize)})`);
  }
  // (Assessment Report + GPS Coordinates links now live inline in
  // the `lines` array above — the Roll # is hyperlinked to the
  // assessment report, and the GPS Coordinates link sits under the
  // Zoning/DU summary. No bottom actions row needed.)

  // Soil composition — top-3 soils by area overlap, stamped by
  // main.js's stampSoilCompositionOnParcels after the Soil Survey
  // overlay loads. Only renders when the parcel actually intersects
  // soil-survey polygons (rural/agricultural areas); urban parcels
  // outside the soil-survey extent get null and the section is hidden.
  //
  // Layout: when composition is present, render the popup as TWO
  // COLUMNS — parcel identity/sale/assessment in the left column,
  // soil composition in the right. Actions row spans both at the
  // bottom. When composition is absent, fall back to the legacy
  // single-column layout to keep the popup narrow.
  // Soil composition is gated on the Map-layers "Agricultural" group
  // being expanded; MASC and Land cover are not.
  //
  // The split is by how much the section costs to read past, not by
  // whether it is farmland data. Soil composition is a multi-row table
  // of soil associations and CLI classes — the section that actually
  // made the popup unwieldy on a rural-residential run. MASC is a single
  // rating chip and Land cover is a short breakdown whose bush/wetland
  // split is genuinely useful on a residential parcel, so both earn
  // their place whether or not the panel is open. Land cover also gates
  // itself on LAND_COVER_MIN_ACRES.
  //
  // The gate covers the sticky click popup as well as hover, since
  // "don't show it while collapsed" isn't much of a rule if a click
  // brings it straight back. The consequence is that expanding the
  // group won't refresh a popup already on screen — re-click the parcel.
  const soilTable = overlayGroupExpanded('agricultural')
    ? soilSurveyParcelHtml(p._soilComposition)
    : null;
  const landCoverTable = landCoverParcelHtml(p);
  const mascBox = mascRatingParcelHtml(p);

  // Right column stacks Land cover (farmland parcels over the threshold),
  // then the MASC rating, then Soil composition (when the Soil Survey
  // overlay is loaded) — coarsest to finest. ANY one section alone triggers
  // the 2-column layout; with none, fall back to the narrow single-column
  // popup.
  const rightSections = [];
  if (landCoverTable) rightSections.push(`<strong>Land cover</strong>${landCoverTable}`);
  if (mascBox)        rightSections.push(`<strong>MASC rating</strong>${mascBox}`);
  if (soilTable)      rightSections.push(`<strong>Soil composition</strong>${soilTable}`);

  if (rightSections.length) {
    return `<div class="parcel-popup parcel-popup-2col">
  <div class="parcel-popup-cols">
    <div class="parcel-popup-main">${lines.join('<br>')}</div>
    <div class="parcel-popup-soil">${rightSections.join('<br>')}</div>
  </div>
</div>`;
  }
  return `<div class="parcel-popup">${lines.join('<br>')}</div>`;
}

/** Shared 'Land Size' formatter for both popup builders. Returns
 *  '12.34 ac · 537,402 sf' style or null when the input isn't a
 *  finite positive acres value. */
function formatLandSize(rawAcres) {
  const ac = Number(rawAcres);
  if (!Number.isFinite(ac) || ac <= 0) return null;
  const sf = Math.round(ac * 43560).toLocaleString('en-US');
  const acFmt = ac < 0.1 ? ac.toFixed(3)
              : ac < 10  ? ac.toFixed(2)
              : ac < 1000 ? ac.toFixed(1)
              : Math.round(ac).toLocaleString('en-US');
  return `${acFmt} ac · ${sf} sf`;
}

function zoningHtml(p) {
  const lines = [];
  if (p.ZONE)          lines.push(`<strong>${escapeHtml(p.ZONE)}</strong>`);
  if (p.ZONE_NAME && p.ZONE_NAME !== p.ZONE) lines.push(escapeHtml(p.ZONE_NAME));
  if (p.ZONE_CATEGORY) lines.push(`<em>${escapeHtml(p.ZONE_CATEGORY)}</em>`);
  if (p.ZBL)           lines.push(`By-law ${escapeHtml(p.ZBL)}`);
  return lines.join('<br>');
}

function devPlanHtml(p) {
  const lines = [];
  if (p.DES_NAME)     lines.push(`<strong>${escapeHtml(p.DES_NAME)}</strong>`);
  if (p.DES_CATEGORY) lines.push(`<em>${escapeHtml(p.DES_CATEGORY)}</em>`);
  if (p.DP_BYLAW)     lines.push(`By-law ${escapeHtml(p.DP_BYLAW)}`);
  if (p.PLANNINGDISTRICT) lines.push(escapeHtml(p.PLANNINGDISTRICT));
  return lines.join('<br>');
}

function contamHtml(p) {
  const lines = [];
  if (p.NAME)     lines.push(`<strong>${escapeHtml(p.NAME)}</strong>`);
  const where = [p.ADDRESS, p.MUNI].filter(Boolean).join(', ');
  if (where)      lines.push(escapeHtml(where));
  if (p.CSGROUP) {
    const colour = p.CSGROUP === 'Designated Contaminated Site' ? '#c0392b'
                 : p.CSGROUP === 'Designated Impacted Site'     ? '#e67e22'
                 : '#7f8c8d';
    lines.push(`<em style="color:${colour}">${escapeHtml(p.CSGROUP)}</em>`);
  }
  const safeLink = safeExternalUrl(p.LINK);
  if (safeLink) {
    lines.push(`<a href="${escapeHtml(safeLink)}" target="_blank" rel="noreferrer">Registry page →</a>`);
  }
  return `<div style="max-width:260px;line-height:1.4">${lines.join('<br>')}</div>`;
}

function riskAreaHtml(p) {
  const risk = String(p.Risk_Area ?? '').trim();
  return `<div style="max-width:220px;line-height:1.4"><strong>MASC Risk Area ${escapeHtml(risk || 'N/A')}</strong><br><em>Official Manitoba Maps boundary</em></div>`;
}

// ---- WALLAS water-rights popups ----
// Attribute names come straight off the MapServer; wallas.js has already
// trimmed the fixed-width padding and turned epoch dates into YYYY-MM-DD.

function wallasWrap(lines) {
  return `<div style="max-width:300px;line-height:1.45;font-size:12px">${lines.filter(Boolean).join('<br>')}</div>`;
}

/** Label a WALLAS licence line, falling back when LICENCE_NO is absent
 *  (a handful of licensed rows carry only a FILE_NO). */
function licenceLine(p, label) {
  const id = p.LICENCE_NO || p.FILE_NO;
  return `<strong>${escapeHtml(label)}${id ? ` — ${escapeHtml(id)}` : ''}</strong>`;
}

function tileDrainageHtml(p) {
  const lines = [licenceLine(p, 'Licensed tile drainage')];
  if (p.CLIENT_NAME)        lines.push(escapeHtml(p.CLIENT_NAME));
  if (p.APPLICATION_STATUS) lines.push(`<em>${escapeHtml(p.APPLICATION_STATUS)}</em>`);
  if (p.APPLICATION_DATE)   lines.push(`Applied ${escapeHtml(p.APPLICATION_DATE)}`);
  // The TILE_* detail fields are populated on well under 10% of rows, so
  // every one of these is conditional rather than a dash-filled table.
  const specs = [];
  if (p.TILE_AREA)  specs.push(`${escapeHtml(p.TILE_AREA)} ac`);
  if (p.TILE_DEPTH) specs.push(`${escapeHtml(p.TILE_DEPTH)}″ deep`);
  if (p.TILE_SPACING_OF_LATERAL_PIPE) specs.push(`${escapeHtml(p.TILE_SPACING_OF_LATERAL_PIPE)}′ spacing`);
  if (p.TILE_OUTLET_TYPE) specs.push(`${escapeHtml(p.TILE_OUTLET_TYPE)} outlet`);
  if (specs.length) lines.push(specs.join(' · '));
  if (p.ENGINEERING_CONSULTANT_NAME) lines.push(`Consultant: ${escapeHtml(p.ENGINEERING_CONSULTANT_NAME)}`);
  // LEGACY_LABEL is how the province distinguishes a proposed network
  // from an installed one. Surfaced verbatim — it's the only signal in
  // the layer for that difference, and it's frequently null.
  if (p.LEGACY_LABEL) lines.push(`<em style="color:#64748b">${escapeHtml(p.LEGACY_LABEL)}</em>`);
  return wallasWrap(lines);
}

function tileNetworkHtml(p) {
  return wallasWrap([
    licenceLine(p, 'Tile line'),
    p.CLIENT_NAME ? escapeHtml(p.CLIENT_NAME) : null,
    p.APPLICATION_STATUS ? `<em>${escapeHtml(p.APPLICATION_STATUS)}</em>` : null,
  ]);
}

function tileOutletHtml(p) {
  return wallasWrap([
    licenceLine(p, 'Tile outlet / structure'),
    p.CLIENT_NAME ? escapeHtml(p.CLIENT_NAME) : null,
    p.APPLICATION_STATUS ? `<em>${escapeHtml(p.APPLICATION_STATUS)}</em>` : null,
  ]);
}

function irrigationHtml(p) {
  const kind = p._wallasKind === 'use' ? 'Irrigation — point of use'
    : 'Irrigation — point of diversion';
  const lines = [licenceLine(p, kind)];
  if (p.CLIENT_NAME)        lines.push(escapeHtml(p.CLIENT_NAME));
  if (p.APPLICATION_STATUS) lines.push(`<em>${escapeHtml(p.APPLICATION_STATUS)}</em>`);
  // SUB_PROGRAM is the groundwater-vs-surface split; PROJECT_TYPE is the
  // works (Withdrawal, In Channel Dugout, ...). Both matter for judging
  // how secure the water supply behind an irrigated valuation is.
  const source = [p.SUB_PROGRAM, p.PROJECT_TYPE].filter(Boolean).map(escapeHtml).join(' · ');
  if (source) lines.push(source);
  if (p.WATER_SOURCE_NAME) lines.push(`Source: ${escapeHtml(p.WATER_SOURCE_NAME)}`);
  if (p.ACQUIFER_NAME)     lines.push(`Aquifer: ${escapeHtml(p.ACQUIFER_NAME)}`);
  if (p.FULL_LOCATION)     lines.push(escapeHtml(p.FULL_LOCATION));
  if (p.APPLICATION_DATE)  lines.push(`Applied ${escapeHtml(p.APPLICATION_DATE)}`);
  return wallasWrap(lines);
}

// CLI subclass codes — surface the human-readable limitation so the
// popup explains *why* a parcel is rated lower without having to look
// up the AAFC manual.
const CLI_SUBCLASS_LABELS = {
  C: 'climate',
  T: 'topography',
  W: 'excess water',
  M: 'moisture deficiency',
  F: 'low fertility',
  N: 'salinity',
  I: 'inundation',
  E: 'erosion',
  P: 'stoniness',
  R: 'shallowness over rock',
  D: 'undesirable soil structure',
};

function cliSubclassDescription(rawSubclass) {
  if (!rawSubclass) return '';
  const codes = String(rawSubclass).toUpperCase().replace(/[^A-Z]/g, '').split('');
  const seen = new Set();
  const labels = [];
  for (const c of codes) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (CLI_SUBCLASS_LABELS[c]) labels.push(CLI_SUBCLASS_LABELS[c]);
  }
  return labels.join(', ');
}

// Capability-class swatches for the CLI popup chip. Keyed on the FIRST
// character of AGCAP_CLS (so "1"-"7", "O" for organic, "$" for the
// urban/water specials). Mirrors the fill-paint match expression on
// the cli-agr-fill layer so the chip in the popup matches what the
// user sees on the map. White text on the visually-dark swatches
// (1, 6, 7, O) for legibility.
const CLI_CLASS_COLORS = {
  '1': '#1a6b26', '2': '#4fab57', '3': '#a6e29f',
  '4': '#f2d640', '5': '#f4a040', '6': '#a8754f',
  '7': '#9c27b0', 'O': '#5e3b1a', '$': '#cfd6dd',
};
const CLI_WHITE_TEXT_CLASSES = new Set(['1', '6', '7', 'O']);

function cliHtml(p) {
  // Walk SOIL_{1,2,3} slots from Manitoba's Soil_Survey_MB schema. Each
  // slot carries an AGCAP_CLS (clean class digit) + AGRI_CAP (class +
  // subclass) + EXTENT percent + dominant soil name/code. Skip empty
  // slots so a single-soil polygon shows one row, a mixed-association
  // polygon shows two or three.
  const slots = ['1', '2', '3'];
  const rows = [];
  for (const slot of slots) {
    const agcapCls = String(p[`AGCAP_CLS${slot}`] || '').trim();
    if (!agcapCls) continue;
    const agriCap  = String(p[`AGRI_CAP${slot}`]  || '').trim();   // e.g. "2W"
    const ext      = p[`EXTENT${slot}`];
    const soilName = p[`SOILNAME${slot}`];
    const soilCode = p[`SOIL_CODE${slot}`];
    // AGRI_CAP already concatenates class + subclass letter(s). If
    // it's missing fall back to the bare class.
    const chipLabel = agriCap || agcapCls;
    const firstChar = agcapCls[0];
    const color = CLI_CLASS_COLORS[firstChar] || '#cccccc';
    const textColor = CLI_WHITE_TEXT_CLASSES.has(firstChar) ? '#fff' : '#1a1a1a';
    const chip = `<span style="display:inline-block;min-width:1.6em;padding:1px 6px;border-radius:4px;background:${color};color:${textColor};font-weight:600;text-align:center">${escapeHtml(chipLabel)}</span>`;
    // The subclass letters live in agriCap AFTER the class digit/letter,
    // e.g. "2W" → subclass "W". Slice it off so cliSubclassDescription
    // can translate it into the friendly limitation phrase.
    const subRaw = agriCap.replace(/^[1-7O$][A-Z0-9$]*?(?=[A-Z]*$)/, '').replace(/^[1-7O$]/, '');
    const subDesc = cliSubclassDescription(subRaw);
    const pctTxt = (ext != null && String(ext).trim() !== '') ? `<strong>${escapeHtml(ext)}%</strong>` : '';
    const desc   = subDesc ? `<em style="color:#555">${escapeHtml(subDesc)}</em>` : '';
    const soilLine = soilName
      ? `<div style="color:#777;font-size:11px">${escapeHtml(soilName)}${soilCode ? ` (${escapeHtml(soilCode)})` : ''}</div>`
      : '';
    rows.push(`<tr>
      <td style="padding:2px 6px 2px 0;vertical-align:top">${chip}</td>
      <td style="padding:2px 6px;vertical-align:top">${pctTxt}</td>
      <td style="padding:2px 0;vertical-align:top">${desc}${soilLine}</td>
    </tr>`);
  }

  if (rows.length === 0) {
    return `<div style="max-width:260px;line-height:1.4"><strong>CLI Soil Capability</strong><br><em>No capability data on this polygon.</em></div>`;
  }

  return `
    <div style="max-width:320px;line-height:1.4">
      <strong>CLI Soil Capability for Agriculture</strong>
      <table style="margin-top:6px;font-size:12px;border-collapse:collapse">${rows.join('')}</table>
      <div style="margin-top:6px;color:#666;font-size:11px">
        Class 1 = prime · 7 = no agricultural capability · O = organic · $ = urban/water
      </div>
    </div>
  `;
}

/**
 * Render a soil row for a popup table. Soil identity is shown as a
 * coloured swatch (matching the polygon's map fill, when present) +
 * the soil name + code. Capability rating is rendered as a coloured
 * chip ("2W", "3MT", "O5", "$ZZ") to the right of the name — the
 * user specifically asked for the capability colour-chip back when
 * we collapsed the polygon-click popup into the parcel popup, since
 * the chip is the fastest way to scan capability at a glance.
 */
function soilSurveyPopupRow({ paintColor, name, code, agriCap, agcapCls, ext, surfaceTexture, mapUnit, descriptors }) {
  const swatch = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${paintColor || '#bfbfbf'};border:1px solid rgba(0,0,0,0.2);margin-right:6px;vertical-align:middle"></span>`;
  const nameLine = code
    ? `<strong>${escapeHtml(name)}</strong> <span style="color:#888">(${escapeHtml(code)})</span>`
    : `<strong>${escapeHtml(name)}</strong>`;
  // Capability chip. Background colour is keyed on the FIRST character
  // of AGCAP_CLS (mirrors the cli-agr-fill paint expression). agriCap
  // carries the class + subclass letter (e.g. "2W"); if it's missing
  // fall back to the bare class so the chip still has something to show.
  const firstChar = agcapCls?.[0] || agriCap?.[0] || '?';
  const chipLabel = agriCap || agcapCls || '';
  const chip = chipLabel
    ? (() => {
        const bg = CLI_CLASS_COLORS[firstChar] || '#bfbfbf';
        const fg = CLI_WHITE_TEXT_CLASSES.has(firstChar) ? '#fff' : '#1a1a1a';
        return `<span style="display:inline-block;min-width:1.6em;padding:1px 6px;border-radius:4px;background:${bg};color:${fg};font-weight:600;text-align:center;font-size:11px;margin-left:6px;vertical-align:middle">${escapeHtml(chipLabel)}</span>`;
      })()
    : '';
  const texLine = surfaceTexture && String(surfaceTexture).trim()
    ? `<div style="color:#777;font-size:11px">Surface: ${escapeHtml(surfaceTexture)}</div>` : '';
  const muText = formatMapUnits(mapUnit);
  const muLine = muText
    ? `<div style="color:#777;font-size:11px">Map unit: ${escapeHtml(muText)}</div>` : '';
  // Per-slot land-feature descriptors (slope, stoniness, salinity,
  // erosion, drainage, surface modifier, management considerations,
  // irrigation rating, potato suitability). Each is its own short
  // line under the surface-texture / map-unit lines, so the popup
  // stays scannable even when all nine descriptors are populated.
  const descriptorLines = descriptors ? soilDescriptorLines(descriptors) : [];
  const descLines = descriptorLines.length
    ? `<div style="color:#777;font-size:11px;margin-top:2px">${descriptorLines.map(escapeHtml).join('<br>')}</div>`
    : '';
  const extText = formatSoilExtent(ext);
  const extCell = extText
    ? `<td style="padding:2px 6px;vertical-align:top;text-align:right;white-space:nowrap"><strong>${escapeHtml(extText)}</strong></td>`
    : '<td></td>';
  return `<tr>
    <td style="padding:4px 6px 4px 0;vertical-align:top">${swatch}${nameLine}${chip}${texLine}${muLine}${descLines}</td>
    ${extCell}
  </tr>`;
}

function soilSurveyHtml(p) {
  // Walk the three soil slots. SOIL_1 is the dominant soil and is
  // almost always populated; SOIL_2 / SOIL_3 may be blank on small
  // homogeneous polygons. Skip blank slots so single-soil polygons
  // render a one-row table.
  //
  // Only the dominant soil gets the polygon's `_paintColor` swatch
  // (that's what's actually on the map). Soils 2 / 3 are subordinate
  // composition; they get a neutral swatch to keep the row shape
  // consistent without implying they drive the map colour.
  const slots = ['1', '2', '3'];
  const rows = [];
  for (const slot of slots) {
    const name = p[`SOILNAME${slot}`];
    if (name == null || String(name).trim() === '') continue;
    rows.push(soilSurveyPopupRow({
      paintColor:     slot === '1' ? p._paintColor : null,
      name,
      code:           p[`SOIL_CODE${slot}`],
      agriCap:        p[`AGRI_CAP${slot}`],
      agcapCls:       p[`AGCAP_CLS${slot}`],
      ext:            p[`EXTENT${slot}`],
      surfaceTexture: p[`SURFTEXT${slot}`],
      descriptors:    descriptorsFromPolygonSlot(p, slot),
    }));
  }

  const mapUnit = p.MAPUNITNOM ? `<div style="margin-top:6px"><strong>Map unit</strong>: <code>${escapeHtml(p.MAPUNITNOM)}</code></div>` : '';
  // The Shapefile-origin schema truncates REPORT_NAME to REPORT_NAM —
  // see SOIL_SURVEY_OUTFIELDS in arcgis.js.
  const reportBits = [];
  if (p.REPORT_NAM) reportBits.push(escapeHtml(p.REPORT_NAM));
  if (p.SCALE) reportBits.push(escapeHtml(p.SCALE));
  const versionDate = formatSoilSurveyDate(p.DATE);
  if (versionDate) reportBits.push(`Version ${escapeHtml(versionDate)}`);
  const report = reportBits.length
    ? `<div style="margin-top:6px;color:#666;font-size:11px">${reportBits.join(' · ')}</div>`
    : '';

  if (rows.length === 0) {
    return `<div style="max-width:280px;line-height:1.4"><strong>Manitoba Soil Survey</strong><br><em>No soil data on this polygon.</em>${mapUnit}${report}</div>`;
  }

  return `
    <div style="max-width:340px;line-height:1.4">
      <strong>Manitoba Soil Survey</strong>
      <table style="margin-top:4px;font-size:12px;border-collapse:collapse;width:100%">${rows.join('')}</table>
      ${mapUnit}
      ${report}
    </div>
  `;
}

/**
 * Build the soil-composition rows for a parcel popup. Reads the
 * `_soilComposition` array stamped by main.js after the per-parcel
 * soil-survey join lands. Each row carries the SAME shape as the
 * polygon-click popup (soil name + code, capability text, surface
 * texture, map unit) plus the parcel-percent overlap. Returns null
 * when the parcel hasn't been joined.
 */
export function soilSurveyParcelHtml(composition) {
  const rows = readSoilComposition(composition);
  if (!rows.length) return null;
  // Render every row stampSoilCompositionOnParcels left for us — the
  // stamp already caps at maxRows: 3 + an "Other" rollup, so no
  // further slicing here. (Earlier this function .slice(0,2)'d on top
  // of the stamp cap, hiding the third soil even after we bumped the
  // stamp limit to 3 — the user spotted that.)
  // Land-feature descriptor sub-blocks (slope, stones, salinity,
  // erosion, drainage, surface mod, mgmt, irrigation, potato) are
  // multi-line and visually heavy. Cap them to the TOP-2 soils by
  // parcel share so the popup stays compact — the user's feedback
  // was that with 3 soils + 9 descriptors each, the popup got too
  // tall and the descriptor lines wrapped across two rows. Soils
  // ranked 3rd or lower still render their name, capability chip,
  // surface texture, map unit, and area / percentage — just without
  // the descriptor wall. (The full picture is in the CSV export
  // for users who need every descriptor on every soil.)
  const DETAIL_LIMIT = 2;
  const html = rows.map((c, i) => {
    // Swatch colour mirrors the map polygon's paint:
    //   - identity ("Soil Type") mode: applyIdentityPalette stamps
    //     `_paintColor` on each soil polygon, the rollup propagates
    //     it onto this row's `paintColor`, so the swatch matches the
    //     muni-specific top-20 legend.
    //   - capability ("Soil Productivity") mode: no `_paintColor` is
    //     stamped (the map uses a static `match` expression on
    //     AGCAP_CLS1); fall through to cliCapabilitySwatchColor so
    //     the swatch picks up the capability-class colour instead of
    //     bleeding the generic fallback grey.
    const swatchColor = c.paintColor || cliCapabilitySwatchColor(c.agcapCls);
    const swatch = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${escapeHtml(swatchColor)};border:1px solid rgba(0,0,0,0.2);margin-right:6px;vertical-align:middle"></span>`;
    const name = c.soilName || 'Mapped soil';
    const nameLine = c.soilCode
      ? `${swatch}<strong>${escapeHtml(name)}</strong> <span style="color:#888">(${escapeHtml(c.soilCode)})</span>`
      : `${swatch}<strong>${escapeHtml(name)}</strong>`;
    // Capability chip — coloured by the first character of AGCAP_CLS
    // (same paint as the CLI overlay's fill, so "2W" reads green,
    // "3W" reads light green, etc.). Inline with the soil name so
    // the row scans capability + identity at a glance.
    const firstChar = c.agcapCls?.[0] || c.agriCap?.[0] || '?';
    const chipLabel = c.agriCap || c.agcapCls || '';
    const chip = chipLabel
      ? (() => {
          const bg = CLI_CLASS_COLORS[firstChar] || '#bfbfbf';
          const fg = CLI_WHITE_TEXT_CLASSES.has(firstChar) ? '#fff' : '#1a1a1a';
          return `<span style="display:inline-block;min-width:1.6em;padding:1px 6px;border-radius:4px;background:${bg};color:${fg};font-weight:600;text-align:center;font-size:11px;margin-left:6px;vertical-align:middle">${escapeHtml(chipLabel)}</span>`;
        })()
      : '';
    const textureLine = c.surfaceText
      ? `<div style="color:#666;font-size:11px">Surface: ${escapeHtml(c.surfaceText)}</div>`
      : '';
    const unitText = formatMapUnits(c.mapUnits || c.mapUnit);
    const unitLine = unitText
      ? `<div style="color:#777;font-size:11px">Map unit: ${escapeHtml(unitText)}</div>`
      : '';
    // Per-soil land-feature descriptors only for the top-2 soils. The
    // values were attributed to this composition row by
    // soilSurveyComponentsFromMatches from whichever polygon contributed
    // the largest share of this soil to the parcel.
    const descBlock = (i < DETAIL_LIMIT)
      ? (() => {
          const descriptorLines = soilDescriptorLines(c);
          if (!descriptorLines.length) return '';
          return `<div style="color:#777;font-size:11px;margin-top:2px">${descriptorLines.map(escapeHtml).join('<br>')}</div>`;
        })()
      : '';
    const areaText = Number.isFinite(c.areaAcres)
      ? formatSoilAcres(c.areaAcres)
      : null;
    const pctText = Number.isFinite(c.parcelPct)
      ? formatSoilExtent(c.parcelPct)
      : '';
    const areaLine = [areaText, pctText ? `${pctText} of parcel` : ''].filter(Boolean).join(' · ');
    return `<tr>
      <td style="padding:4px 8px 4px 0;vertical-align:top">${nameLine}${chip}${textureLine}${unitLine}${descBlock}</td>
      <td style="padding:4px 0;vertical-align:top;text-align:right;white-space:nowrap"><strong>${escapeHtml(areaLine)}</strong></td>
    </tr>`;
  }).join('');
  return `<table style="margin-top:4px;font-size:12px;border-collapse:collapse;width:100%">${html}</table>`;
}

/**
 * Land-cover breakdown box for the parcel popup. Renders the farmland
 * buckets (Cultivated / Pasture-Grass / Bush-Treed / Wetland-Water /
 * Other) stamped onto the parcel as `_landCover` by main.js, each with
 * a colour swatch, its share of the parcel, and the implied acreage
 * (parcel acres × share, so the numbers reconcile with the Land Size
 * line above). Returns null when the parcel is ≤ LAND_COVER_MIN_ACRES
 * or carries no land-cover data — matching the build's acreage gate.
 */
export function landCoverParcelHtml(p) {
  if (!(Number(p?._acres) > LAND_COVER_MIN_ACRES)) return null;
  const rows = landCoverBreakdown(readLandCover(p?._landCover));
  if (!rows) return null;
  const acres = Number(p._acres);
  const html = rows.map((b) => {
    const swatch = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${escapeHtml(b.color)};border:1px solid rgba(0,0,0,0.2);margin-right:6px;vertical-align:middle"></span>`;
    const pctLabel = b.pct < 0.005 ? '<1%' : `${Math.round(b.pct * 100)}%`;
    const acLabel = Number.isFinite(acres)
      ? `${(acres * b.pct).toLocaleString('en-US', { maximumFractionDigits: 1 })} ac · `
      : '';
    return `<tr>
      <td style="padding:3px 8px 3px 0;vertical-align:top">${swatch}${escapeHtml(b.label)}</td>
      <td style="padding:3px 0;vertical-align:top;text-align:right;white-space:nowrap"><strong>${escapeHtml(acLabel + pctLabel)}</strong></td>
    </tr>`;
  }).join('');
  return `<table style="margin-top:4px;font-size:12px;border-collapse:collapse;width:100%">${html}</table>`;
}

/**
 * MASC soil-rating box for the parcel popup — the dominant crop-insurance
 * rating for this parcel, the quarter section it was read from, and the
 * MASC risk area. All three are stamped onto the parcel during search
 * enrichment (see main.js's parcel-MASC pass), so this is display only.
 *
 * The source quarter is worth showing rather than just the letter: a parcel
 * can span more than one rated quarter, and `_soilRating` is the dominant
 * one by area overlap — being able to see WHICH quarter produced it is the
 * difference between a number you can cite and a number you have to go
 * check. A parcel carrying more than one official rating renders the full
 * label ("C/F") with the chip coloured by the conservative code.
 *
 * Returns null when the parcel has no rating — urban parcels, and munis
 * with no MASC shard, simply don't get the section.
 */
export function mascRatingParcelHtml(p) {
  const rating = p?._soilRating;
  if (!rating) return null;
  const code = p?._soilRatingCode || mascDisplayRating({ ratings: rating });
  const chipTitle = String(rating).includes('/')
    ? ` title="Multiple MASC ratings: ${escapeHtml(rating)}"`
    : '';
  const chip = `<span${chipTitle} style="display:inline-block;min-width:1.6em;padding:1px 6px;`
    + `border-radius:4px;font-weight:600;text-align:center;`
    + `background:${escapeHtml(masccolor(code))};color:${escapeHtml(mascTextColor(code))};`
    + `border:1px solid rgba(0,0,0,0.2)">${escapeHtml(rating)}</span>`;

  const lines = [];
  const source = p._soilQuarter
    ? ` <span style="color:#555">from ${escapeHtml(p._soilQuarter)}</span>`
    : '';
  lines.push(`${chip}${source}`);
  const risk = p._soilRiskArea;
  if (risk != null && String(risk).trim() !== '') {
    lines.push(`<span style="color:#555">Risk Area ${escapeHtml(risk)}</span>`);
  }
  return `<div style="margin-top:4px;font-size:12px;line-height:1.7">${lines.join('<br>')}</div>`;
}

/**
 * One-line top-2 land-cover summary for the muni-fabric (Roll Layer) popup
 * — the two largest buckets with their share (e.g. "Cultivated 61% ·
 * Wetland 16%"), each with its colour swatch. Null when the parcel is
 * ≤ LAND_COVER_MIN_ACRES or carries no land-cover data (same gate as
 * landCoverParcelHtml). The full breakdown lives on the search-result
 * popup; this is the concise inline version for the fabric popup.
 */
export function landCoverTopTwoLine(p) {
  if (!(Number(p?._acres) > LAND_COVER_MIN_ACRES)) return null;
  const rows = landCoverBreakdown(readLandCover(p?._landCover));
  if (!rows) return null;
  const parts = rows.slice(0, 2).map((b) => {
    const swatch = `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${escapeHtml(b.color)};border:1px solid rgba(0,0,0,0.2);margin-right:4px;vertical-align:middle"></span>`;
    const pctLabel = b.pct < 0.005 ? '<1%' : `${Math.round(b.pct * 100)}%`;
    return `${swatch}${escapeHtml(b.label)} ${pctLabel}`;
  });
  return `<strong>Land cover</strong> ${parts.join(' &middot; ')}`;
}

function readSoilComposition(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Coerce a parcel's `_landCover` stamp to an object. MapLibre serializes
 * nested-object feature properties to JSON strings when read from rendered
 * features (the popup path), so the stamp can arrive either as the original
 * object or as a JSON string — same dual shape readSoilComposition handles
 * for `_soilComposition`. Returns null when there's no usable object.
 */
function readLandCover(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function formatSoilExtent(value) {
  if (value == null || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value}%`;
  const decimals = n > 0 && n < 10 ? 1 : 0;
  return `${n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}%`;
}

function formatMapUnits(value) {
  const units = Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);
  if (!units.length) return '';
  const shown = units.slice(0, 3);
  const suffix = units.length > 3 ? ` +${units.length - 3} more` : '';
  return `${shown.join(', ')}${suffix}`;
}

function formatSoilAcres(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 0.1) return `${n.toFixed(3)} ac`;
  if (n < 10) return `${n.toFixed(2)} ac`;
  if (n < 1000) return `${n.toFixed(1)} ac`;
  return `${Math.round(n).toLocaleString('en-US')} ac`;
}

function formatSoilSurveyDate(value) {
  if (value == null || value === '') return '';
  const n = Number(value);
  const d = Number.isFinite(n) ? new Date(n) : new Date(value);
  if (!Number.isFinite(d.valueOf())) return '';
  return d.toISOString().slice(0, 10);
}

function trafficHtml(p) {
  const lines = [];
  if (p.StationNum != null) lines.push(`<strong>Station #${escapeHtml(p.StationNum)}</strong>`);
  const hwy = [p.HighwayNum, p.HighwayAlt].filter(Boolean).join(' / ');
  if (hwy)               lines.push(`Hwy ${escapeHtml(hwy)}`);
  if (p.LocationDe)      lines.push(escapeHtml(p.LocationDe));
  if (p.FlowDirect)      lines.push(`<em>Flow: ${escapeHtml(p.FlowDirect)}</em>`);
  if (p.StationTyp)      lines.push(`<em>Type: ${escapeHtml(p.StationTyp)}</em>`);
  // _aadt is stamped onto the station feature by main.js once the Traffic
  // Flow layer has been loaded and indexed; if it's missing, the user
  // hasn't toggled Show Traffic Flow yet, so prompt them.
  if (p._aadt != null) {
    lines.push(`<strong>AADT (2019)</strong> ${Number(p._aadt).toLocaleString('en-US')}`);
  } else {
    lines.push(`<em style="color:#666">Toggle <strong>Show Flow</strong> for AADT</em>`);
  }
  lines.push(`<a href="https://www.gov.mb.ca/mti/traffic/counts.html" target="_blank" rel="noreferrer">MHTIS web app →</a>`);
  return `<div style="max-width:280px;line-height:1.4">${lines.join('<br>')}</div>`;
}

function trafficFlowHtml(p) {
  const lines = [];
  const road = p.ROAD_IDENT || (p.ROAD_NO != null ? `Hwy ${p.ROAD_NO}` : null);
  if (road) lines.push(`<strong>${escapeHtml(road)}</strong>`);
  const aadt = currentAadt(p);
  if (aadt != null) {
    lines.push(`<strong>AADT</strong> ${aadt.toLocaleString('en-US')}`);
  }
  if (p.DateOfEsti != null) lines.push(`Estimate year: ${escapeHtml(p.DateOfEsti)}`);
  if (p.FlowDirect) lines.push(`Flow: ${escapeHtml(p.FlowDirect)}`);
  if (p.START_KM != null && p.END_KM != null) {
    lines.push(`km ${Number(p.START_KM).toFixed(1)} → ${Number(p.END_KM).toFixed(1)}`);
  }
  if (p.StationNum != null) lines.push(`<em>Source station #${escapeHtml(p.StationNum)}</em>`);
  return `<div style="max-width:260px;line-height:1.4">${lines.join('<br>')}</div>`;
}

function mbHighwayHtml(p) {
  const typeNames = {
    '-PTH': 'Provincial Trunk Highway',
    '-PR': 'Provincial Road',
    '-ACCESS': 'Access Road',
    '-WR': 'Winter Road',
    '-SVCRD': 'Service Road',
    '-RAMP': 'Ramp',
    '-LOOP': 'Loop',
    '-RTCO': 'Route Connector',
  };
  const type = typeNames[p.RteType] || 'Manitoba Road';
  const number = String(p.CommonRoadName_004 ?? '').trim();
  const commonName = String(p.CommonRoadName_003 ?? '').trim();
  const title = number ? `${type} ${number}` : (commonName || type);
  const lines = [`<strong>${escapeHtml(title)}</strong>`];
  if (commonName && commonName !== title) lines.push(escapeHtml(commonName));
  lines.push('<em>Government of Manitoba road network, current to 2023</em>');
  return `<div style="max-width:280px;line-height:1.4">${lines.join('<br>')}</div>`;
}

/** Read whichever overlay polygons sit under a screen point, restricted
 *  to layers that are currently visible. Used by the parcel/muni-parcels
 *  hover/click popups so they can show zoning, dev-plan, and soil info
 *  on the parcel under the cursor. Returns the first hit's properties for
 *  each layer, or null if the layer is hidden / nothing's there. */
function readOverlaysAt(map, point) {
  const out = { zoning: null, devplan: null, cli: null, cliMode: null };
  if (map.getLayer('zoning-fill') &&
      map.getLayoutProperty('zoning-fill', 'visibility') === 'visible') {
    const hit = map.queryRenderedFeatures(point, { layers: ['zoning-fill'] })[0];
    if (hit) out.zoning = hit.properties;
  }
  if (map.getLayer('devplan-fill') &&
      map.getLayoutProperty('devplan-fill', 'visibility') === 'visible') {
    const hit = map.queryRenderedFeatures(point, { layers: ['devplan-fill'] })[0];
    if (hit) out.devplan = hit.properties;
  }
  // CLI overlay sits behind parcel polygons, so its capability/soil-name
  // info should follow the cursor into the parcel popup whenever the
  // user has the layer on. currentCliPaintMode tells the popup builder
  // whether the active mode wants the capability code ("2W") or the
  // soil-association name ("Red River").
  if (map.getLayer('cli-agr-fill') &&
      map.getLayoutProperty('cli-agr-fill', 'visibility') === 'visible') {
    const hit = map.queryRenderedFeatures(point, { layers: ['cli-agr-fill'] })[0];
    if (hit) {
      out.cli = hit.properties;
      out.cliMode = currentCliPaintMode;
    }
  }
  return out;
}

// Capability-mode swatch palette — mirrors main.js's CLI_CAPABILITY_FILL_COLOR
// match expression so the popup line under "Total Value" carries the same
// colour the user sees on the map polygon. Keyed on the first char of
// AGCAP_CLS1 (1-7 for capability classes; O for organic; $ for urban /
// water). Any unmatched first char falls through to the same grey the
// map uses for unclassified polygons.
const CLI_CAPABILITY_SWATCH_BY_CLASS = {
  '1': '#1a6b26',
  '2': '#4fab57',
  '3': '#a6e29f',
  '4': '#f2d640',
  '5': '#f4a040',
  '6': '#a8754f',
  '7': '#9c27b0',
  'O': '#5e3b1a',
  '$': '#cfd6dd',
};
function cliCapabilitySwatchColor(agcapCls1) {
  if (!agcapCls1) return '#cccccc';
  const first = String(agcapCls1).slice(0, 1);
  return CLI_CAPABILITY_SWATCH_BY_CLASS[first] || '#cccccc';
}

/**
 * Code → label tables for the per-soil-component Manitoba Soil Survey
 * descriptors fetched via CLI_AGR_CAP_OUTFIELDS. Codes are pulled
 * directly from the Soil_Survey_MB layer's coded-value domains so the
 * labels stay authoritative. Special "$XX" codes (Modified land,
 * Unclassified, Urban, Water, Marsh, Eroded slope complex) appear in
 * several domains and are kept in each so unusual polygons read
 * sensibly instead of falling to the raw code.
 *
 * Each domain has a small `decode${X}(code)` companion that returns
 * the label or the raw code when unmapped, so renderers can stay
 * one-liners.
 */
const SOIL_TOPO_LABELS = {
  x: '0 – 0.5% (level to nearly level)',
  b: '>0.5 – 2% (nearly level)',
  c: '>2 – 5% (very gently rolling)',
  d: '>5 – 9% (gently sloping)',
  e: '>9 – 15% (moderately sloping)',
  f: '>15 – 30% (strongly sloping)',
  g: '>30 – 45% (very strongly sloping)',
  h: '>45 – 70% (extremely sloping)',
  i: '>70 – 100% (steeply sloping)',
  j: '>100% (very steep)',
  $ML: 'Modified land',
  $UL: 'Unclassified land',
  $UR: 'Urban land',
  $ZZ: 'Water',
  $MH: 'Marsh complex',
};
const SOIL_STONE_LABELS = {
  x: 'Non-stony (<0.01%)',
  1: 'Slightly stony (0.01% – <0.1%)',
  2: 'Moderately stony (0.1 – <3%)',
  3: 'Very stony (3 – <15%)',
  4: 'Exceedingly stony (15 – 50%)',
  5: 'Excessively stony (>50%)',
  ORG: 'Organic soil',
  $ER: 'Eroded slope complex',
  $ML: 'Modified land',
  $UL: 'Unclassified land',
  $UR: 'Urban land',
  $ZZ: 'Water',
};
const SOIL_SALINITY_LABELS = {
  x: 'Non-saline (0 – 4 mS/cm)',
  s: 'Weakly saline (>4 – 8 mS/cm)',
  t: 'Moderately saline (>8 – 16 mS/cm)',
  u: 'Strongly saline (>16 mS/cm)',
  ORG: 'Organic soil',
  $ML: 'Modified land',
  $UL: 'Unclassified land',
  $UR: 'Urban land',
  $ZZ: 'Water',
};
const SOIL_EROSION_LABELS = {
  x: 'Non-eroded or minimal',
  1: 'Slightly eroded',
  2: 'Moderately eroded',
  3: 'Severely eroded',
  o: 'Overwash / overblown',
  ORG: 'Organic soil',
  $ML: 'Modified land',
  $UL: 'Unclassified land',
  $UR: 'Urban land',
  $ZZ: 'Water',
};
const SOIL_DRAINAGE_LABELS = {
  R: 'Rapid',
  W: 'Well',
  I: 'Imperfect',
  P: 'Poor',
  VP: 'Very poor',
  $ML: 'Modified land',
  $UL: 'Unclassified land',
  $UR: 'Urban land',
  $ZZ: 'Water',
};
const SOIL_SURFTEXTM_LABELS = {
  GR: 'Gravelly',
  MU: 'Mucky',
  VR: 'Very gravelly',
  WY: 'Woody',
};
const SOIL_MANCON_LABELS = {
  'No Constraints': 'No constraints',
  C:    'Coarse texture',
  'C T':'Coarse texture + topography',
  CW:   'Coarse texture + wetness',
  CWT:  'Coarse texture, wetness + topography',
  F:    'Fine texture',
  'F T':'Fine texture + topography',
  FW:   'Fine texture + wetness',
  FWT:  'Fine texture, wetness + topography',
  T:    'Topography (slopes >5%)',
  W:    'Wetness (poor / very-poor drainage)',
  WT:   'Wetness + topography',
  B:    'Bedrock',
  TB:   'Topography + bedrock',
  'W B':'Wetness + bedrock',
  'Eroded slopes': 'Eroded slopes',
  Marsh:        'Marsh',
  Organic:      'Organic',
  Rock:         'Rock',
  Unclassified: 'Unclassified',
  Water:        'Water',
};
const SOIL_SPUD_LABELS = {
  1: 'Class 1 (most suitable for potatoes)',
  2: 'Class 2 (potato suitability)',
  3: 'Class 3 (potato suitability)',
  4: 'Class 4 (potato suitability)',
  5: 'Class 5 (least suitable for potatoes)',
  $ML: 'Modified land',
  $UL: 'Unclassified land',
  $UR: 'Urban land',
  $ZZ: 'Water',
};

function lookupSoilLabel(table, code) {
  if (code == null) return null;
  const raw = String(code).trim();
  if (!raw) return null;
  return table[raw] ?? table[raw.toLowerCase()] ?? table[raw.toUpperCase()] ?? raw;
}

// Dispatcher keyed on composition-row field name so CSV / table helpers
// in main.js can decode a descriptor code without importing every domain
// table individually. Returns an empty string for missing or unmappable
// codes (so CSV cells stay blank instead of carrying raw "x" / "$ML"
// strings). GEN_RATIN codes are already human-readable so the dispatcher
// passes them through.
const SOIL_DESCRIPTOR_DOMAINS = {
  topo:      SOIL_TOPO_LABELS,
  stone:     SOIL_STONE_LABELS,
  salinity:  SOIL_SALINITY_LABELS,
  erosion:   SOIL_EROSION_LABELS,
  drainage:  SOIL_DRAINAGE_LABELS,
  surftextm: SOIL_SURFTEXTM_LABELS,
  mancon:    SOIL_MANCON_LABELS,
  spudRtng:  SOIL_SPUD_LABELS,
};
export function decodeSoilDescriptor(domain, code) {
  if (code == null || code === '') return '';
  if (domain === 'genRatin') {
    // Pass-through with cleanup of "$XX" specials.
    const specials = { ORG: 'Organic', $ML: 'Modified land', $UL: 'Unclassified land', $UR: 'Urban land', $ZZ: 'Water' };
    return specials[String(code).trim()] ?? String(code).trim();
  }
  const table = SOIL_DESCRIPTOR_DOMAINS[domain];
  if (!table) return String(code);
  return lookupSoilLabel(table, code) ?? '';
}

/**
 * Build the per-slot "Land features" descriptor lines from either a
 * polygon-properties object (slot suffix supplied) or a composition
 * row (per-slot codes already pulled). Returns an array of "Label:
 * value" strings, skipping any descriptor whose code is missing. The
 * caller decides how to join (middle-dot for hover; <br> for the rich
 * popup row).
 *
 *   forPolygonSlot(p, '1') → reads p.TOPO1, p.STONE1, …
 *   forCompositionRow(row)  → reads row.topo, row.stone, … (the
 *                             largest-contributor descriptors that
 *                             soilSurveyComponentsFromMatches stamps)
 */
function soilDescriptorLines({ topo, stone, salinity, erosion, drainage, surftextm, mancon, genRatin, spudRtng }) {
  const lines = [];
  const push = (label, code, table) => {
    const value = lookupSoilLabel(table, code);
    if (value) lines.push(`${label}: ${value}`);
  };
  push('Slope',       topo,      SOIL_TOPO_LABELS);
  push('Stones',      stone,     SOIL_STONE_LABELS);
  push('Salinity',    salinity,  SOIL_SALINITY_LABELS);
  push('Erosion',     erosion,   SOIL_EROSION_LABELS);
  push('Drainage',    drainage,  SOIL_DRAINAGE_LABELS);
  push('Surface mod', surftextm, SOIL_SURFTEXTM_LABELS);
  push('Mgmt',        mancon,    SOIL_MANCON_LABELS);
  // GEN_RATIN codes are already human readable (Excellent / Good / …)
  // — pass through unless the polygon carries a "$XX" special.
  if (genRatin) {
    const value = lookupSoilLabel({ ORG: 'Organic', $ML: 'Modified land', $UL: 'Unclassified land', $UR: 'Urban land', $ZZ: 'Water' }, genRatin) ?? genRatin;
    lines.push(`Irrigation: ${value}`);
  }
  push('Potato',      spudRtng,  SOIL_SPUD_LABELS);
  return lines;
}

function descriptorsFromPolygonSlot(p, slot) {
  return {
    topo:      p?.[`TOPO${slot}`],
    stone:     p?.[`STONE${slot}`],
    salinity:  p?.[`SALINITY${slot}`],
    erosion:   p?.[`EROSION${slot}`],
    drainage:  p?.[`DRAINAGE${slot}`],
    surftextm: p?.[`SURFTEXTM${slot}`],
    mancon:    p?.[`MANCON${slot}`],
    genRatin:  p?.[`GEN_RATIN${slot}`],
    spudRtng:  p?.[`SPUD_RTNG${slot}`],
  };
}

/**
 * Single-line CLI overlay info for muniParcelHtml — shows either the
 * capability code or the soil-association name from the polygon under
 * the cursor, depending on which mode the user has the CLI overlay in.
 * Returns null when the CLI overlay is off or there's no polygon under
 * the cursor.
 *
 *   capability mode → "<strong>CLI</strong> 2W"            (AGRI_CAP1)
 *   identity mode   → "<strong>Soil Type</strong> Red River" (SOILNAME1)
 *
 * Includes the SAME paint-colour swatch the map polygon uses, so the
 * popup line visually ties back to the legend. In capability mode the
 * swatch is derived from AGCAP_CLS1's first character (the same key
 * the map's `match` expression uses); in identity mode it reads the
 * per-feature `_paintColor` that applyIdentityPalette stamps on every
 * polygon.
 */
function cliOverlayLine(cliProps, cliMode) {
  if (!cliProps || !cliMode) return null;
  if (cliMode === 'capability') {
    const cap = cliProps.AGRI_CAP1 || cliProps.AGCAP_CLS1;
    if (!cap) return null;
    const swatchColor = cliCapabilitySwatchColor(cliProps.AGCAP_CLS1);
    const swatch = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${escapeHtml(swatchColor)};border:1px solid rgba(0,0,0,0.2);margin-right:6px;vertical-align:middle"></span>`;
    return `${swatch}<strong>CLI</strong> ${escapeHtml(cap)}`;
  }
  if (cliMode === 'identity') {
    const name = cliProps.SOILNAME1 || cliProps.SOIL_CODE1;
    if (!name) return null;
    const swatchColor = cliProps._paintColor || '#bfbfbf';
    const swatch = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${escapeHtml(swatchColor)};border:1px solid rgba(0,0,0,0.2);margin-right:6px;vertical-align:middle"></span>`;
    const code = cliProps.SOIL_CODE1;
    const codePart = code && code !== name
      ? ` <span style="color:#777">(${escapeHtml(code)})</span>`
      : '';
    return `${swatch}<strong>Soil Type</strong> ${escapeHtml(name)}${codePart}`;
  }
  return null;
}

function soilSurveyHoverHtml(p) {
  if (!p) return null;
  const rows = [];
  for (const slot of ['1', '2', '3']) {
    const name = p[`SOILNAME${slot}`];
    if (name == null || String(name).trim() === '') continue;
    const code = p[`SOIL_CODE${slot}`];
    const ext = formatSoilExtent(p[`EXTENT${slot}`]);
    const soil = code
      ? `${escapeHtml(name)} <span style="color:#777">(${escapeHtml(code)})</span>`
      : escapeHtml(name);
    const head = `${soil}${ext ? ` <strong>${escapeHtml(ext)}</strong>` : ''}`;
    // Compact one-line "Land features" beneath each soil — joined with
    // middle-dots and clamped to a shorter font so the hover stays
    // scannable when all nine descriptors are populated.
    const descriptors = soilDescriptorLines(descriptorsFromPolygonSlot(p, slot));
    const descSuffix = descriptors.length
      ? `<div style="color:#666;font-size:11px;margin:1px 0 4px 0">${escapeHtml(descriptors.join(' · '))}</div>`
      : '';
    rows.push(`<div style="margin-top:4px">${head}${descSuffix}</div>`);
  }
  if (!rows.length) return null;
  // Swatch colour falls back through the same paths cliOverlayLine uses:
  //   identity mode stamps `_paintColor` on every feature, so we read it.
  //   capability mode never stamps anything — derive from AGCAP_CLS1's
  //   first char so the swatch matches the map's `match` paint expression
  //   instead of bleeding the generic fallback grey when CLI is in
  //   "Soil Productivity" mode.
  const swatchColor = p._paintColor || cliCapabilitySwatchColor(p.AGCAP_CLS1);
  const swatch = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${escapeHtml(swatchColor)};border:1px solid rgba(0,0,0,0.2);margin-right:6px;vertical-align:middle"></span>`;
  const detail = [];
  if (p.MAPUNITNOM) detail.push(`Map unit ${escapeHtml(p.MAPUNITNOM)}`);
  const cap = p.AGRI_CAP1 || p.AGCAP_CLS1;
  if (cap) detail.push(`Capability ${escapeHtml(cap)}`);
  if (p.SURFTEXT1) detail.push(`Surface ${escapeHtml(p.SURFTEXT1)}`);
  const detailLine = detail.length
    ? `<div style="color:#666;font-size:11px;margin-top:2px">${detail.join(' &middot; ')}</div>`
    : '';
  // Each row already wraps in its own block (with a per-slot land-features
  // sub-line); join with empty string so they stack vertically instead of
  // running together on one line.
  return `<strong>Soil under cursor</strong> ${swatch}${rows.join('')}${detailLine}`;
}

/**
 * Build the popup body for a muni-parcels feature. Hover variant shows
 * just the lightweight info; click variant adds an assessment-report
 * link if Asmt_Rpt_Url is present. When the zoning or dev-plan overlay
 * is currently active, the matching info from those layers is appended
 * — same behaviour as the search-result hover, but for arbitrary muni
 * parcels.
 */
function muniParcelHtml(p, { withReportLink = false, overlay = null } = {}) {
  const lines = [];
  if (p.Roll_No_Txt) {
    // Roll # is hyperlinked to the Manitoba Assessment Online report
    // (same treatment as parcelHtml on search-result parcels) — the
    // natural single-click destination for "open the assessment
    // report". Falls back to plain text when no report URL is
    // present on the feature.
    const display = escapeHtml(rollDisplayFor(p));
    const safeReport = safeExternalUrl(p.Asmt_Rpt_Url);
    const rollLine = safeReport
      ? `<a href="${escapeHtml(safeReport)}" target="_blank" rel="noreferrer" title="Open Manitoba Assessment report">${display}</a>`
      : display;
    lines.push(`<strong>Roll #</strong> ${rollLine}`);
  }
  if (p.Property_Address) lines.push(escapeHtml(p.Property_Address));
  if (p.Muni_Name_With_Typ) lines.push(`<em>${escapeHtml(p.Muni_Name_With_Typ)}</em>`);
  // Legal description from the MAO scrape index. Stamped onto every
  // muni-parcels feature by main.js's enrichFcWithLegals() right after
  // the muni-parcels fetch lands, so the popup renders it without any
  // per-popup async lookup. Falls back to the longer legal_detail when
  // the short legal_description is empty.
  const legal = p._legalDescription || p._legalDetail;
  if (legal) lines.push(`<strong>Legal</strong> ${escapeHtml(legal)}`);
  if (p._certificatesOfTitle) {
    lines.push(`<strong>Title</strong> ${escapeHtml(p._certificatesOfTitle)}`);
  }
  if (p.Dwelling_Units != null && p.Dwelling_Units !== '') {
    lines.push(`<strong>DU</strong> ${escapeHtml(p.Dwelling_Units)}`);
  }
  // Top-2 land cover (dominant + runner-up, each with its share) right
  // after DU, once the Land Cover overlay has stamped this fabric parcel.
  // The full per-bucket breakdown lives on the search-result popup.
  const lcLine = landCoverTopTwoLine(p);
  if (lcLine) lines.push(lcLine);
  // GPS Coordinates link sits right after DU so it's a single click
  // away on the click popup. Only rendered for the sticky/click
  // variant — the hover popup closes on mouse-out before the user
  // can click, so showing a dead link there would just add noise.
  if (withReportLink) {
    lines.push(`<a href="#" class="parcel-coords-copy" role="button" title="Copy parcel centroid (lat, lng) to clipboard">GPS Coordinates</a>`);
  }
  // Land size — _acres is computed and stamped onto each feature in
  // arcgis.js when the muni-parcels FC is fetched. Show both ac and sf.
  const landSize = formatLandSize(p._acres);
  if (landSize) lines.push(`<strong>Land Size</strong> ${landSize}`);
  const muniRollSize = formatRollSizeField(p.Frontage_or_Area);
  if (muniRollSize) lines.push(`<strong>Roll States</strong> ${escapeHtml(muniRollSize)}`);
  if (p.Total_Value) {
    const cleaned = String(p.Total_Value).replace(/[^0-9.]/g, '');
    const n = Number(cleaned);
    if (Number.isFinite(n) && n > 0) {
      lines.push(`<strong>Total Value</strong> $${Math.round(n).toLocaleString('en-US')}`);
    }
  }
  // CLI overlay info for the polygon under the cursor — capability code
  // when CLI is in "Soil Productivity" mode, soil-association name when
  // it's in "Soil Type" mode. Sits right after Total Value so the user
  // sees the agriculture context inline with the parcel's headline
  // numbers. Skipped when the CLI overlay is off.
  const cliLine = cliOverlayLine(overlay?.cli, overlay?.cliMode);
  if (cliLine) lines.push(cliLine);
  if (overlay?.zoning) {
    const z = overlay.zoning;
    const code = z.ZONE || z.ZONE_NAME;
    const name = z.ZONE_NAME && z.ZONE_NAME !== z.ZONE ? z.ZONE_NAME : null;
    const bits = [];
    if (code) bits.push(`<strong>${escapeHtml(code)}</strong>`);
    if (name) bits.push(escapeHtml(name));
    if (z.ZBL) bits.push(`By-law ${escapeHtml(z.ZBL)}`);
    if (bits.length) lines.push(`<strong style="color:#1a3a4a">Zoning</strong>: ${bits.join(' &middot; ')}`);
  }
  if (overlay?.devplan) {
    const d = overlay.devplan;
    const bits = [];
    if (d.DES_NAME)     bits.push(`<strong>${escapeHtml(d.DES_NAME)}</strong>`);
    if (d.DES_CATEGORY) bits.push(escapeHtml(d.DES_CATEGORY));
    if (d.DP_BYLAW)     bits.push(`By-law ${escapeHtml(d.DP_BYLAW)}`);
    if (bits.length) lines.push(`<strong style="color:#1a3a4a">Dev Plan</strong>: ${bits.join(' &middot; ')}`);
  }
  // (Assessment Report + GPS Coordinates links now live inline in the
  // `lines` array above — the Roll # is hyperlinked to the assessment
  // report, and the GPS Coordinates link sits right after DU. No
  // bottom actions row needed.)
  //
  // Same 2-column treatment parcelHtml uses — soil composition on the
  // right, parcel info on the left. Falls back to single-column when
  // composition isn't loaded for this parcel, and gated on the same
  // Agricultural panel: the same parcel showing soil from the muni-parcels
  // layer but not from a search result would read as a bug.
  const soilTable = overlayGroupExpanded('agricultural')
    ? soilSurveyParcelHtml(p._soilComposition)
    : null;
  if (soilTable) {
    return `<div class="parcel-popup parcel-popup-2col">
  <div class="parcel-popup-cols">
    <div class="parcel-popup-main">${lines.join('<br>')}</div>
    <div class="parcel-popup-soil"><strong>Soil composition</strong>${soilTable}</div>
  </div>
</div>`;
  }
  return `<div class="parcel-popup">${lines.join('<br>')}</div>`;
}

function emptyFc() { return { type: 'FeatureCollection', features: [] }; }

// Zoom applied per click of the fine-zoom + / - buttons. A MapLibre zoom
// level doubles or halves the map scale, so the stock NavigationControl's
// hardcoded ±1 step is a big jump; 0.5 (~41% scale change) gives finer
// framing while still moving meaningfully in a click or two.
const FINE_ZOOM_STEP = 0.5;

/**
 * Zoom + / - buttons with a configurable step, replacing MapLibre's
 * NavigationControl (whose zoom step is fixed at ±1 and not exposed as
 * an option). Reuses the stock control's class names so it inherits the
 * native +/- icon styling and sits identically in the control stack;
 * only the per-click increment differs.
 *
 * Buttons disable at the map's min / max zoom, mirroring NavigationControl,
 * so a click at the limit isn't a silent no-op.
 */
class FineZoomControl {
  constructor({ step = FINE_ZOOM_STEP } = {}) {
    this._step = step;
    this._onZoom = () => this._updateDisabled();
  }

  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

    this._zoomIn = this._button('maplibregl-ctrl-zoom-in', 'Zoom in', () => this._zoomBy(this._step));
    this._zoomOut = this._button('maplibregl-ctrl-zoom-out', 'Zoom out', () => this._zoomBy(-this._step));
    this._container.appendChild(this._zoomIn);
    this._container.appendChild(this._zoomOut);

    map.on('zoom', this._onZoom);
    this._updateDisabled();
    return this._container;
  }

  onRemove() {
    this._map?.off('zoom', this._onZoom);
    this._container?.remove();
    this._map = undefined;
  }

  _button(cls, label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    // Stock control class name (maplibregl-ctrl-zoom-in / -zoom-out) so
    // the glyph and hover styling come from MapLibre's own stylesheet.
    btn.className = cls;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    // The stock control renders its glyph via this inner span's
    // background-image; reusing the class gives us the same + / - icon.
    const icon = document.createElement('span');
    icon.className = 'maplibregl-ctrl-icon';
    icon.setAttribute('aria-hidden', 'true');
    btn.appendChild(icon);
    btn.addEventListener('click', onClick);
    return btn;
  }

  _zoomBy(delta) {
    if (!this._map) return;
    // easeTo clamps to the map's min/max zoom on its own; the short
    // duration keeps the step feeling like a button press, not a fly-to.
    this._map.easeTo({ zoom: this._map.getZoom() + delta, duration: 200 });
  }

  _updateDisabled() {
    if (!this._map) return;
    const z = this._map.getZoom();
    // A tiny epsilon so floating-point drift at the exact limit doesn't
    // leave a button enabled that can't actually move.
    this._zoomIn.disabled = z >= this._map.getMaxZoom() - 1e-6;
    this._zoomOut.disabled = z <= this._map.getMinZoom() + 1e-6;
  }
}

/**
 * Basemap menu ported from the Winnipeg parcel app. The trigger shows the
 * current view; hover, focus, or tap opens all available basemaps. The MLI row
 * appears once VITE_MLI_ORTHO_PMTILES_URL is configured. While MLI is active,
 * the trigger adds the acquisition year at the map centre from the committed
 * MLI coverage polygons.
 */
class BasemapMenuControl {
  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-toggle basemap-menu';
    this._views = [
      { key: 'streets', label: 'Streets' },
      { key: 'satellite', label: 'Satellite' },
      { key: 'wayback', label: 'Historical (Esri Wayback)' },
      ...(MLI_ORTHO_PMTILES_URL
        ? [{ key: 'mli', label: `MLI Aerial ${MLI_ORTHO_YEAR_RANGE}` }]
        : []),
      { key: 'transportation', label: 'NRCan Transportation' },
      { key: 'elevation', label: 'NRCan Elevation' },
    ];
    // Default Wayback release = newest curated MB date. Swapped by the
    // date dropdown built below.
    this._waybackRelease = WAYBACK_VERSIONS[0].release;

    this._btn = document.createElement('button');
    this._btn.type = 'button';
    this._btn.className = 'basemap-menu-trigger';
    this._btn.setAttribute('aria-haspopup', 'true');
    this._btn.setAttribute('aria-expanded', 'false');
    this._labelEl = document.createElement('span');
    this._labelEl.className = 'basemap-menu-label';
    this._btn.appendChild(this._labelEl);
    this._btn.addEventListener('click', (event) => { event.stopPropagation(); this._toggle(); });
    this._container.appendChild(this._btn);

    this._list = document.createElement('div');
    this._list.className = 'basemap-menu-list';
    this._list.setAttribute('role', 'menu');
    for (const view of this._views) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'basemap-menu-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = view.label;
      item.dataset.key = view.key;
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        this._set(view.key);
        this._close();
      });
      this._list.appendChild(item);
    }
    this._container.appendChild(this._list);

    // Wayback date picker — shown only while the Historical (Wayback)
    // basemap is active. A plain dropdown of the curated MB change-dates;
    // picking one swaps the imagery tiles in place.
    this._waybackWrap = document.createElement('div');
    this._waybackWrap.className = 'basemap-wayback';
    this._waybackWrap.hidden = true;
    const wbLabel = document.createElement('span');
    wbLabel.className = 'basemap-wayback-label';
    wbLabel.textContent = 'Imagery date';
    this._waybackSelect = document.createElement('select');
    this._waybackSelect.className = 'basemap-wayback-select';
    this._waybackSelect.setAttribute('aria-label', 'Wayback imagery date');
    for (const v of WAYBACK_VERSIONS) {
      const opt = document.createElement('option');
      opt.value = String(v.release);
      opt.textContent = v.date;
      this._waybackSelect.appendChild(opt);
    }
    this._waybackSelect.value = String(this._waybackRelease);
    this._waybackSelect.addEventListener('click', (event) => event.stopPropagation());
    this._waybackSelect.addEventListener('change', (event) => {
      event.stopPropagation();
      this._waybackRelease = Number(this._waybackSelect.value);
      setWaybackRelease(this._map, this._waybackRelease);
      this._render();
    });
    this._waybackWrap.appendChild(wbLabel);
    this._waybackWrap.appendChild(this._waybackSelect);
    // Lives inside the menu popup (which opens on hover) so it can't be
    // covered by the menu. The active date is always visible on the
    // trigger label; changing it happens here.
    this._list.appendChild(this._waybackWrap);

    this._container.addEventListener('mouseenter', () => this._open());
    this._container.addEventListener('mouseleave', () => this._scheduleClose());
    this._container.addEventListener('focusout', (event) => {
      if (!this._container.contains(event.relatedTarget)) this._close();
    });
    this._container.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { this._close(); this._btn.focus(); }
    });
    this._onDocClick = (event) => { if (!this._container.contains(event.target)) this._close(); };
    document.addEventListener('click', this._onDocClick);

    this._yearFeatures = [];
    fetch('/mli-imagery-years.geojson')
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { this._yearFeatures = data?.features || []; this._render(); })
      .catch(() => {});
    this._onMoveEnd = () => this._render();
    map.on('moveend', this._onMoveEnd);
    this._render();
    return this._container;
  }
  _open() { clearTimeout(this._closeTimer); this._container.classList.add('open'); this._btn.setAttribute('aria-expanded', 'true'); }
  _close() { clearTimeout(this._closeTimer); this._container.classList.remove('open'); this._btn.setAttribute('aria-expanded', 'false'); }
  _scheduleClose() { clearTimeout(this._closeTimer); this._closeTimer = setTimeout(() => this._close(), 140); }
  _toggle() { this._container.classList.contains('open') ? this._close() : this._open(); }
  _currentKey() {
    const m = this._map;
    if (m.getLayer('wayback-imagery') && m.getLayoutProperty('wayback-imagery', 'visibility') === 'visible') return 'wayback';
    if (m.getLayer('ortho-mb') && m.getLayoutProperty('ortho-mb', 'visibility') === 'visible') return 'mli';
    if (m.getLayer('nrcan-transportation-geometry') && m.getLayoutProperty('nrcan-transportation-geometry', 'visibility') === 'visible') return 'transportation';
    if (m.getLayer('nrcan-elevation') && m.getLayoutProperty('nrcan-elevation', 'visibility') === 'visible') return 'elevation';
    if (m.getLayer('esri-imagery') && m.getLayoutProperty('esri-imagery', 'visibility') === 'visible') return 'satellite';
    return 'streets';
  }
  _set(state) {
    const m = this._map;
    // Wayback and the elevation/MLI aerials all want Esri's place-name +
    // road overlays on top; only Streets (Voyager carries its own) and
    // the NRCan Transportation map opt out.
    const esriLabels = state !== 'streets' && state !== 'transportation';
    m.setLayoutProperty('carto-voyager', 'visibility', state === 'streets' ? 'visible' : 'none');
    m.setLayoutProperty('esri-imagery', 'visibility', (state === 'satellite' || state === 'mli') ? 'visible' : 'none');
    m.setLayoutProperty('wayback-imagery', 'visibility', state === 'wayback' ? 'visible' : 'none');
    m.setLayoutProperty('nrcan-transportation-geometry', 'visibility', state === 'transportation' ? 'visible' : 'none');
    m.setLayoutProperty('nrcan-transportation-labels', 'visibility', state === 'transportation' ? 'visible' : 'none');
    m.setLayoutProperty('nrcan-elevation', 'visibility', state === 'elevation' ? 'visible' : 'none');
    m.setLayoutProperty('esri-transportation', 'visibility', esriLabels ? 'visible' : 'none');
    m.setLayoutProperty('esri-reference', 'visibility', esriLabels ? 'visible' : 'none');
    if (m.getLayer('ortho-mb')) m.setLayoutProperty('ortho-mb', 'visibility', state === 'mli' ? 'visible' : 'none');
    // Apply the selected Wayback release when entering that mode so the
    // tiles match the dropdown (the source defaults to the newest date).
    if (state === 'wayback') setWaybackRelease(m, this._waybackRelease);
    this._render();
  }
  _yearAtCenter() {
    if (!this._yearFeatures.length) return null;
    const center = this._map.getCenter();
    const point = { type: 'Point', coordinates: [center.lng, center.lat] };
    const feature = this._yearFeatures.find((candidate) => booleanPointInPolygon(point, candidate));
    return feature?.properties?.year || null;
  }
  _waybackDate() {
    const v = WAYBACK_VERSIONS.find((x) => x.release === this._waybackRelease);
    return v ? v.date : '';
  }
  _render() {
    if (!this._map || !this._labelEl) return;
    const key = this._currentKey();
    const view = this._views.find((candidate) => candidate.key === key) || this._views[0];
    const localYear = key === 'mli' ? this._yearAtCenter() : null;
    let label = localYear ? `MLI Aerial - ${localYear}` : view.label;
    if (key === 'wayback') label = `Wayback ${this._waybackDate()}`;
    this._labelEl.textContent = label;
    this._btn.classList.toggle('active', key !== 'streets');
    this._btn.title = localYear
      ? `Basemap: MLI Aerial. Imagery at map centre was acquired in ${localYear}.`
      : key === 'wayback'
        ? `Basemap: Esri Wayback historical imagery (${this._waybackDate()}).`
        : `Basemap: ${view.label}`;
    this._btn.setAttribute('aria-label', `${this._btn.title} Open to choose another basemap.`);
    // Reveal the Wayback date picker only while that basemap is active.
    if (this._waybackWrap) this._waybackWrap.hidden = key !== 'wayback';
    for (const item of this._list.querySelectorAll('.basemap-menu-item')) {
      const active = item.dataset.key === key;
      item.classList.toggle('active', active);
      item.setAttribute('aria-current', active ? 'true' : 'false');
    }
  }
  onRemove() {
    clearTimeout(this._closeTimer);
    if (this._onDocClick) document.removeEventListener('click', this._onDocClick);
    if (this._onMoveEnd) this._map?.off('moveend', this._onMoveEnd);
    this._container.parentNode?.removeChild(this._container);
    this._map = null;
  }
}

/**
 * Distance / area measurement control. Sits in the top-right gutter and
 * opens a small panel with two mode buttons and a live readout. Drawing
 * itself is delegated to mapbox-gl-draw (compatible with MapLibre after
 * the class-name patch at the top of this file); we just listen for its
 * events and recompute length (@turf/length) or area (@turf/area).
 *
 * UX:
 *   - Click "Measure" → panel opens.
 *   - Click "Distance" → cursor becomes crosshair, each map click adds a
 *     vertex, double-click finishes the line.
 *   - Click "Area" → same flow but draws a closed polygon.
 *   - Switching modes or clicking "Clear" wipes the current shape.
 *   - Hover tooltips stand down for as long as the panel is open (see
 *     isMeasuring) — they otherwise track the cursor straight over the
 *     point being clicked, and their pointer cursor fights the crosshair.
 *   - Closing the panel deletes the in-progress shape and returns the map
 *     to its normal click handlers.
 *
 * Readout shows both metric and imperial: m / km / ft / mi for distance,
 * m² / hectares / acres for area.
 */
class MeasureControl {
  constructor(draw) {
    this._draw = draw;
    this._mode = null;
  }
  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group measure-control';

    this._btn = document.createElement('button');
    this._btn.type = 'button';
    this._btn.title = 'Measure distance or area';
    this._btn.setAttribute('aria-label', 'Measure distance or area');
    this._btn.textContent = 'Measure';
    this._btn.addEventListener('click', () => this._togglePanel());
    this._container.appendChild(this._btn);

    this._panel = document.createElement('div');
    this._panel.className = 'measure-panel';
    this._panel.style.display = 'none';
    this._panel.innerHTML = `
      <div class="measure-modes">
        <button type="button" data-mode="distance">Distance</button>
        <button type="button" data-mode="area">Area</button>
      </div>
      <div class="measure-readout" aria-live="polite">Pick a mode to start.</div>
      <div class="measure-actions">
        <button type="button" class="measure-clear">Clear</button>
        <button type="button" class="measure-done">Done</button>
      </div>
    `;
    this._container.appendChild(this._panel);

    this._panel.querySelectorAll('.measure-modes button').forEach((btn) => {
      btn.addEventListener('click', () => this._setMode(btn.dataset.mode));
    });
    this._panel.querySelector('.measure-clear').addEventListener('click', () => {
      // Re-running _setMode with the same mode is the cleanest reset:
      // it deletes everything, re-enters the draw mode, and refreshes
      // the readout instructions. Without the changeMode call, the
      // user would still be in simple_select after the previous
      // measurement finished and clicking the map wouldn't do anything.
      if (this._mode) {
        this._setMode(this._mode);
      } else {
        this._draw.deleteAll();
        this._setReadout('Pick a mode to start.');
      }
    });
    this._panel.querySelector('.measure-done').addEventListener('click', () => this._close());

    const onChange = () => this._update();
    map.on('draw.create', onChange);
    map.on('draw.update', onChange);
    map.on('draw.render', onChange);
    map.on('draw.delete', onChange);

    return this._container;
  }
  _togglePanel() {
    const open = this._panel.style.display === 'none';
    if (open) {
      this._panel.style.display = 'block';
      this._btn.classList.add('active');
      // While the measurement panel is open the bottom-right map
      // legends (Zoning, MASC, CLI, Soil Survey, AADT) would visually
      // collide with the Distance/Area readout that drops down from
      // the Measure button. Adding `body.measuring` lets a CSS rule
      // hide every `.map-legend` until the user closes the panel.
      //
      // The same class is the signal the hover tooltips read through
      // isMeasuring() to suppress themselves — keep the two `classList`
      // calls here and in _close() paired, or the tooltips stay off.
      document.body.classList.add('measuring');
    } else {
      this._close();
    }
  }
  _close() {
    this._draw.deleteAll();
    try { this._draw.changeMode('simple_select'); } catch { /* mode may already be simple_select */ }
    this._panel.style.display = 'none';
    this._btn.classList.remove('active');
    document.body.classList.remove('measuring');
    this._setMode(null, { skipModeChange: true });
    this._setReadout('Pick a mode to start.');
  }
  _setMode(mode, { skipModeChange = false } = {}) {
    this._mode = mode;
    this._panel.querySelectorAll('.measure-modes button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    if (skipModeChange) return;
    this._draw.deleteAll();
    if (mode === 'distance') {
      this._draw.changeMode('draw_line_string');
      this._setReadout('Click to add points. Double-click to finish.');
    } else if (mode === 'area') {
      this._draw.changeMode('draw_polygon');
      this._setReadout('Click to add points. Double-click to close polygon.');
    }
  }
  _setReadout(html) {
    this._panel.querySelector('.measure-readout').innerHTML = html;
  }
  _update() {
    if (!this._mode) return;
    const data = this._draw.getAll();
    const f = data.features[0];
    if (!f) return;
    const g = f.geometry;
    if (this._mode === 'distance' && (g.type === 'LineString' || g.type === 'MultiLineString')) {
      // Need at least 2 coordinates for a meaningful length.
      const coords = g.type === 'LineString' ? g.coordinates : (g.coordinates[0] || []);
      if (!coords || coords.length < 2) return;
      const km = turfLength(f, { units: 'kilometers' });
      const m  = km * 1000;
      const mi = km / 1.609344;
      const ft = m * 3.28084;
      this._setReadout(
        `<strong>Distance</strong><br>` +
        `${fmtNum(m, m < 10 ? 2 : 1)} m &nbsp;(${fmtNum(km, 3)} km)<br>` +
        `${fmtNum(ft, 0)} ft &nbsp;(${fmtNum(mi, 3)} mi)`
      );
    } else if (this._mode === 'area' && (g.type === 'Polygon' || g.type === 'MultiPolygon')) {
      // Polygon ring needs ≥3 vertices (4 with closure) to have non-zero area.
      const ring = g.type === 'Polygon' ? g.coordinates[0] : (g.coordinates[0]?.[0] || []);
      if (!ring || ring.length < 4) return;
      const sqm   = turfArea(f);
      const ha    = sqm / 10000;
      const acres = sqm / 4046.8564224;
      this._setReadout(
        `<strong>Area</strong><br>` +
        `${fmtNum(sqm, 0)} m² &nbsp;(${fmtNum(ha, 4)} ha)<br>` +
        `${fmtNum(acres, 3)} acres`
      );
    }
  }
  onRemove() {
    this._container.parentNode?.removeChild(this._container);
    this._map = null;
  }
}

function fmtNum(n, decimals) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}


/** Read the sale-group sibling OBJECTID array off a parcel feature's
 *  properties. queryRenderedFeatures returns properties as a plain
 *  object with non-primitive values JSON-stringified, so an array
 *  written by main.js arrives as a string here and needs parsing. */
function readSaleGroupOids(props) {
  return readJsonArrayProp(props?._saleGroupRollIds);
}

/** Read the displayable roll-number array off a parcel feature's
 *  properties. Same encoding caveat as readSaleGroupOids — properties
 *  ferried through the geojson tile pipeline get JSON-stringified. */
function readSaleGroupRolls(props) {
  return readJsonArrayProp(props?._saleGroupRolls);
}

function readJsonArrayProp(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  return null;
}

/** Display form of a parcel feature's roll number. Prefers the
 *  _rollDisplay stamp set by arcgis.js (already strips a trailing
 *  .000); falls back to a runtime strip when the stamp isn't there
 *  (search-result features that weren't routed through the muni-
 *  parcels enrichment). Mirrors the displayRoll() helper in main.js. */
function rollDisplayFor(p) {
  if (p?._rollDisplay) return p._rollDisplay;
  const r = p?.Roll_No_Txt;
  if (typeof r !== 'string') return '';
  return r.endsWith('.000') ? r.slice(0, -4) : r;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Route planner: setters + click-to-pick start helper -------

/**
 * Stamp the start-point marker (single green dot + "Start" label).
 * Pass null to clear.
 */
export function setRouteStart(map, lngLat) {
  const src = map.getSource('route-start');
  if (!src) return;
  if (!lngLat || !Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) {
    src.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  src.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { kind: 'start' },
      geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] },
    }],
  });
}

/**
 * Stamp the ordered route stops + the driving polyline.
 *
 * @param {Array<{lng:number, lat:number, label?:string}>} stops — in
 *   visit order, EXCLUDING the start (the start is rendered by
 *   setRouteStart). Each gets a numbered pin (rank = i+1).
 * @param {{type:'LineString', coordinates:[lng,lat][]}|null} geometry
 *   The driving polyline. Pass null to clear the line without
 *   clearing the stops.
 */
export function setRouteData(map, stops, geometry) {
  const stopsSrc = map.getSource('route-stops');
  const lineSrc  = map.getSource('route-line');
  if (stopsSrc) {
    const features = (stops || []).map((p, i) => ({
      type: 'Feature',
      properties: { rank: i + 1, label: p.label || String(i + 1) },
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    }));
    stopsSrc.setData({ type: 'FeatureCollection', features });
  }
  if (lineSrc) {
    if (geometry?.coordinates?.length > 1) {
      lineSrc.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry }],
      });
    } else {
      lineSrc.setData({ type: 'FeatureCollection', features: [] });
    }
  }
}

/** Hide the route + stops + start without clearing the data. */
export function setRouteVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of [
    'route-start-pt', 'route-start-label',
    'route-line-stroke',
    'route-stop-pt', 'route-stop-rank',
  ]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

// Internal state for the start-pick mode. The handler is one-shot —
// the next click resolves the promise and the picker auto-disables.
const _startPickState = new WeakMap();

/**
 * Enter start-picker mode: the next click on the map captures its
 * lng/lat as the route start, then resolves. The map cursor turns
 * to a crosshair while in the mode, and a Esc keypress cancels.
 *
 * @returns {Promise<{lng:number, lat:number}|null>} the picked point,
 *   or null if cancelled.
 */
export function pickStartFromMap(map) {
  // If a previous picker is still pending, cancel it first so the
  // promises don't pile up.
  const prior = _startPickState.get(map);
  if (prior?.cancel) prior.cancel();

  return new Promise((resolve) => {
    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = 'crosshair';

    const onClick = (e) => {
      cleanup();
      resolve({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
      }
    };
    const cleanup = () => {
      canvas.style.cursor = prevCursor;
      map.off('click', onClick);
      window.removeEventListener('keydown', onKey);
      _startPickState.delete(map);
    };

    _startPickState.set(map, { cancel: () => { cleanup(); resolve(null); } });
    map.on('click', onClick);
    window.addEventListener('keydown', onKey);
  });
}
