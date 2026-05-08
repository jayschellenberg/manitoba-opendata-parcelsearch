// MapLibre GL JS map setup with a free CartoDB Positron basemap.
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

// Initial view focuses on populated south-central Manitoba — from the
// US border up to ~Grahamdale and from RM of Pipestone east to the
// Ontario line. The vast majority of parcels and appraisal work
// happens in this band; the user can scroll/zoom out to reach the
// northern LGDs when needed.
const MB_CENTER = [-98.0, 50.3];
const MB_ZOOM = 7;

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
    'carto-positron': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
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
  },
  layers: [
    { id: 'carto-positron', type: 'raster', source: 'carto-positron', minzoom: 0, maxzoom: 20 },
    {
      id: 'esri-imagery',
      type: 'raster',
      source: 'esri-imagery',
      minzoom: 0,
      maxzoom: 20,
      layout: { visibility: 'none' },
    },
  ],
};

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
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new BasemapToggleControl(), 'top-right');
  // Temporary diagnostic — shows the live zoom level so we can tune
  // zoom-dependent paint expressions (label sizes, minzoom thresholds,
  // etc). Remove this addControl call when no longer needed.
  map.addControl(new ZoomLevelControl(), 'top-left');

  const ready = new Promise((resolve) => {
    map.on('load', () => {
      // Municipal boundaries — a stable reference layer that's on by
      // default. Drawn first so every other overlay (zoning, dev-plan,
      // muni parcels, search results) renders above. Light grey fill
      // with subtle dark-grey outline; readable on both Streets and
      // Satellite without competing with the data layers.
      map.addSource('muni-boundaries', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'muni-boundaries-line',
        type: 'line',
        source: 'muni-boundaries',
        paint: {
          'line-color': '#555',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            5, 0.5,
            10, 1.0,
            14, 1.4,
          ],
          'line-opacity': 0.55,
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
          'circle-radius': 6,
          'circle-color': [
            'match', ['get', 'CSGROUP'],
            'Designated Contaminated Site', '#c0392b',
            'Designated Impacted Site',     '#e67e22',
            '#7f8c8d', // Not Designated / unknown
          ],
          'circle-stroke-width': 1,
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
          'line-color': [
            'step', ['coalesce', ['to-number', ['get', 'AADT']], 0],
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
          'text-field': ['to-string', ['get', 'AADT']],
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
          'circle-radius': 5,
          'circle-color': '#1a3a4a',
          'circle-stroke-width': 1.5,
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
            'A', '#fff8c8',
            'B', '#f2d640',
            'C', '#847b14',
            'D', '#a6e29f',
            'E', '#4fab57',
            'F', '#1a6b26',
            'G', '#f4c2d1',
            'H', '#e6228b',
            'I', '#dc0000',
            'J', '#9c27b0',
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
            'A', '#fff8c8',
            'B', '#f2d640',
            'C', '#847b14',
            'D', '#a6e29f',
            'E', '#4fab57',
            'F', '#1a6b26',
            'G', '#f4c2d1',
            'H', '#e6228b',
            'I', '#dc0000',
            'J', '#9c27b0',
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
        minzoom: 13,
        layout: {
          visibility: 'none',
          'text-field': ['get', 'rating'],
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
      map.addSource('masc-risk-areas', { type: 'geojson', data: emptyFc() });
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
      // Canada Land Inventory — Soil Capability for Agriculture.
      // Federal AAFC dataset rated 1 (best) to 7 (worst). Painted by
      // CLASS_A (the dominant class for the polygon). Subclass codes
      // (W=excess water, T=topography, F=low fertility, etc.) come
      // along on the feature for popup/tooltip use. Hidden until the
      // user toggles it on with a muni selected.
      map.addSource('cli-agr', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'cli-agr-fill',
        type: 'fill',
        source: 'cli-agr',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': [
            'match', ['get', 'CLASS_A'],
            '1', '#1a6b26',  // dark green   — prime
            '2', '#4fab57',  // medium green — minor limitations
            '3', '#a6e29f',  // light green  — moderate
            '4', '#f2d640',  // yellow       — severe / marginal
            '5', '#f4a040',  // orange       — perennial only
            '6', '#a8754f',  // brown        — native pasture only
            '7', '#9c27b0',  // purple       — no agricultural capability
            '#cccccc',       // unrated / urban / water
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
          // Dominant class with subclass appended when the polygon
          // carries one (e.g. "3W", "5T"). Helps appraisers read
          // the map without clicking each polygon.
          'text-field': [
            'concat',
            ['coalesce', ['get', 'CLASS_A'], ''],
            ['coalesce', ['get', 'SUBCLAS_A1'], ''],
          ],
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

      // Section-township grid — line layer derived from the
      // MB_LegalDesc point centroids by aggregating quarters into
      // section bounding boxes (see masc.js sectionLinesFromRows).
      // Lines only; the grid sits visually above zoning/dev-plan
      // overlays but below the muni-parcels and search-result layers.
      map.addSource('survey-grid', { type: 'geojson', data: emptyFc() });
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
      // River lots: solid teal line. Slightly heavier than the section
      // grid so the lot pattern reads at a glance against the basemap.
      map.addLayer({
        id: 'survey-grid-riverlot',
        type: 'line',
        source: 'survey-grid',
        filter: ['==', ['get', 'kind'], 'riverlot'],
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#0f766e',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            8,  0.5,
            12, 1.1,
            16, 1.7,
          ],
          'line-opacity': 0.85,
        },
      });
      map.addLayer({
        id: 'survey-grid-label',
        type: 'symbol',
        source: 'survey-grid',
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
        paint: { 'fill-color': '#cfeefb', 'fill-opacity': 0.15 },
      });
      map.addLayer({
        id: 'muni-parcels-line',
        type: 'line',
        source: 'muni-parcels',
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#1d4ed8',
          'line-width': 0.9,
          // Toned down from 0.9 so the muni-wide parcel fabric reads
          // as supporting context without competing with overlays
          // (zoning, MASC, CLI) painted on top.
          'line-opacity': 0.7,
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
        source: 'muni-parcels',
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

      // Parcel highlight — primary layer, always on. Red fill so it pops
      // against any pale-coloured zoning/dev-plan overlay underneath.
      // Fill opacity is intentionally light (0.18) so the basemap and
      // any underlying overlay (zoning category, muni parcel fabric)
      // remain readable beneath the highlight; the line stroke does the
      // heavy lifting for parcel boundary visibility.
      map.addSource('parcels', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'parcel-fill',
        type: 'fill',
        source: 'parcels',
        paint: { 'fill-color': '#b22222', 'fill-opacity': 0.15 },
      });
      map.addLayer({
        id: 'parcel-line',
        type: 'line',
        source: 'parcels',
        paint: { 'line-color': '#690000', 'line-width': 2.5 },
      });
      // MASC label overlay is intentionally above the parcel/roll-fabric
      // layers so the rating letter stays visible when the user turns
      // MASC on after a parcel search.
      map.addLayer({
        id: 'masc-label',
        type: 'symbol',
        source: 'masc',
        minzoom: 13,
        layout: {
          visibility: 'none',
          'text-field': ['coalesce', ['get', 'rating'], ''],
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
      if (map.getLayer('survey-grid-label'))   map.moveLayer('survey-grid-label');
      if (map.getLayer('muni-parcels-label'))  map.moveLayer('muni-parcels-label');

      // Hover popup — works on every layer that's currently visible. Text
      // composed from whichever layer was hit (parcels take priority).
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      map.on('mousemove', (e) => {
        if (!map.isStyleLoaded()) return;
        const visibleLayers = ['parcel-fill'];
        if (map.getLayoutProperty('zoning-fill', 'visibility') === 'visible') visibleLayers.push('zoning-fill');
        if (map.getLayoutProperty('devplan-fill', 'visibility') === 'visible') visibleLayers.push('devplan-fill');
        const hits = map.queryRenderedFeatures(e.point, { layers: visibleLayers });
        if (!hits.length) {
          popup.remove();
          map.getCanvas().style.cursor = '';
          return;
        }
        map.getCanvas().style.cursor = 'pointer';
        // Parcel info, then a separator line per overlay hit (deduped by layer).
        const blocks = [];
        const parcel = hits.find((h) => h.layer.id === 'parcel-fill');
        if (parcel) blocks.push(`<div><strong style="color:#690000">Parcel</strong><br>${parcelHtml(parcel.properties)}</div>`);
        const zone = hits.find((h) => h.layer.id === 'zoning-fill');
        if (zone) blocks.push(`<div><strong style="color:#1a2a4a">Zoning</strong><br>${zoningHtml(zone.properties)}</div>`);
        const dev = hits.find((h) => h.layer.id === 'devplan-fill');
        if (dev) blocks.push(`<div><strong style="color:#1a2a4a">Dev Plan</strong><br>${devPlanHtml(dev.properties)}</div>`);
        popup
          .setLngLat(e.lngLat)
          .setHTML(blocks.join('<hr style="margin:6px 0;border:none;border-top:1px solid #ddd">'))
          .addTo(map);
      });
      map.on('mouseout', () => { popup.remove(); map.getCanvas().style.cursor = ''; });

      // Click on a parcel → scroll the table to its row.
      if (onFeatureClick) {
        map.on('click', 'parcel-fill', (e) => {
          const key = e.features?.[0]?.properties?._rowKey;
          if (key != null) onFeatureClick(key);
        });
      }

      // Muni-parcels hover popup. The muni-parcels source carries a richer
      // property set than the parcel hover (Roll #, Address, DU, area,
      // value), so a quick mouseover surfaces enough info to triage which
      // parcel the user is looking at. Reuses the same combined-popup
      // instance to avoid stacking a second popup over the search-result
      // hover. Only attaches when the muni-parcels layer is visible — when
      // search-result parcels also sit at the cursor those win (queried
      // first in the layer list).
      const muniHoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
      });
      map.on('mousemove', 'muni-parcels-fill', (e) => {
        if (map.getLayoutProperty('muni-parcels-fill', 'visibility') !== 'visible') return;
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
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'muni-parcels-fill', () => {
        muniHoverPopup.remove();
        map.getCanvas().style.cursor = '';
      });

      // Click on a muni-parcel polygon → sticky popup (so the user can
      // copy the roll number, click the assessment-report link, etc).
      // Same content as the hover popup but with a close button.
      const muniClickPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'muni-parcels-fill', (e) => {
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
          map.getCanvas().style.cursor = 'pointer';
        }
      });
      map.on('mouseleave', 'contam-circle', () => { map.getCanvas().style.cursor = ''; });

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
          map.getCanvas().style.cursor = 'pointer';
        }
      });
      map.on('mouseleave', 'masc-risk-area-fill', () => { map.getCanvas().style.cursor = ''; });

      // Click a CLI polygon → popup listing every class slot the
      // polygon carries (A through F) with class number, percentage,
      // and subclass codes. Most polygons have a single dominant
      // class but transition zones can carry mixed ratings like
      // "60% 3W, 40% 4T" — the popup makes that visible without
      // having to dig through the raw FeatureServer attributes.
      const cliPopup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px' });
      map.on('click', 'cli-agr-fill', (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        cliPopup.setLngLat(e.lngLat).setHTML(cliHtml(p)).addTo(map);
      });
      map.on('mouseenter', 'cli-agr-fill', () => {
        if (map.getLayoutProperty('cli-agr-fill', 'visibility') === 'visible') {
          map.getCanvas().style.cursor = 'pointer';
        }
      });
      map.on('mouseleave', 'cli-agr-fill', () => { map.getCanvas().style.cursor = ''; });

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
          map.getCanvas().style.cursor = 'pointer';
        }
      });
      map.on('mouseleave', 'traffic-circle', () => { map.getCanvas().style.cursor = ''; });

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
          map.getCanvas().style.cursor = 'pointer';
        }
      });
      map.on('mouseleave', 'traffic-flow-line', () => { map.getCanvas().style.cursor = ''; });

      resolve();
    });
  });

  return { map, ready };
}

/**
 * Push the parcel results onto the map and fit to them. Empty FC resets
 * the viewport to the province-wide default so the user sees something
 * familiar after Clear.
 */
export function showResults(map, parcelFc) {
  const src = map.getSource('parcels');
  if (src) src.setData(parcelFc);
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

export function setSurveyGridData(map, fc) {
  const src = map.getSource('survey-grid');
  if (src) src.setData(fc);
}
export function setSurveyGridVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['survey-grid-line', 'survey-grid-riverlot', 'survey-grid-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

export function setMuniBoundariesData(map, fc) {
  const src = map.getSource('muni-boundaries');
  if (src) src.setData(fc);
}

export function setMuniParcelsData(map, fc) {
  const src = map.getSource('muni-parcels');
  if (src) src.setData(fc);
}
export function setMuniParcelsVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['muni-parcels-fill', 'muni-parcels-line', 'muni-parcels-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

// ---------- popup builders ----------

function parcelHtml(p) {
  const lines = [];
  if (p.Roll_No_Txt)        lines.push(`<strong>Roll #</strong> ${escapeHtml(rollDisplayFor(p))}`);
  if (p.Property_Address)   lines.push(escapeHtml(p.Property_Address));
  if (p.Muni_Name_With_Typ) lines.push(`<em>${escapeHtml(p.Muni_Name_With_Typ)}</em>`);
  // Sale Date / Sale Price / Primary Property — populated only when
  // this parcel was surfaced via a sales-CSV upload
  // (handleSalesUpload in main.js stamps these onto each matched
  // feature). Sale info reads first because it's the appraisal-
  // relevant payload of the upload.
  if (p._saleDate || p._salePrice) {
    const bits = [];
    if (p._saleDate)  bits.push(`<strong>Sold</strong> ${escapeHtml(p._saleDate)}`);
    if (p._salePrice) bits.push(`<strong>Price</strong> ${escapeHtml(p._salePrice)}`);
    lines.push(bits.join(' &middot; '));
  }
  if (p._primaryProperty) {
    lines.push(`<strong>Primary Property</strong> ${escapeHtml(p._primaryProperty)}`);
  }
  if (p._legalDescription)  lines.push(`<strong>Legal</strong> ${escapeHtml(p._legalDescription)}`);
  if (p._certificatesOfTitle) lines.push(`<strong>Title</strong> ${escapeHtml(p._certificatesOfTitle)}`);
  // Inline summary line: zoning code + DU. Zoning is stamped onto the
  // parcel feature by main.js after the top-2 area-weighted join lands.
  const summary = [];
  if (p._zoneCode)            summary.push(`<strong>Zoning</strong> ${escapeHtml(p._zoneCode)}`);
  if (p.Dwelling_Units != null) summary.push(`<strong>DU</strong> ${escapeHtml(p.Dwelling_Units)}`);
  if (summary.length)         lines.push(summary.join(' &nbsp;·&nbsp; '));
  return lines.join('<br>');
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

const CLI_CLASS_COLORS = {
  '1': '#1a6b26', '2': '#4fab57', '3': '#a6e29f',
  '4': '#f2d640', '5': '#f4a040', '6': '#a8754f',
  '7': '#9c27b0',
};

function cliHtml(p) {
  // Walk every class slot (A → F) the AAFC schema can carry. Skip
  // empty slots so a single-dominant-class polygon shows one row,
  // a transition-zone polygon shows two or more.
  const slots = ['A', 'B', 'C', 'D', 'E', 'F'];
  const rows = [];
  for (const slot of slots) {
    const cls = p[`CLASS_${slot}`];
    if (cls == null || String(cls).trim() === '') continue;
    const pct  = p[`PERCENT_${slot}`];
    const sub1 = p[`SUBCLAS_${slot}1`];
    const sub2 = p[`SUBCLAS_${slot}2`];
    const subRaw = [sub1, sub2].filter(Boolean).join('');
    const subDesc = cliSubclassDescription(subRaw);
    const color = CLI_CLASS_COLORS[String(cls).trim()] || '#cccccc';
    const textColor = ['1', '6', '7'].includes(String(cls).trim()) ? '#fff' : '#1a1a1a';
    const chip = `<span style="display:inline-block;min-width:1.6em;padding:1px 6px;border-radius:4px;background:${color};color:${textColor};font-weight:600;text-align:center">${escapeHtml(cls)}${escapeHtml(subRaw)}</span>`;
    const pctTxt = (pct != null && String(pct).trim() !== '') ? `<strong>${escapeHtml(pct)}%</strong>` : '';
    const desc   = subDesc ? `<em style="color:#555">${escapeHtml(subDesc)}</em>` : '';
    rows.push(`<tr><td style="padding:2px 6px 2px 0">${chip}</td><td style="padding:2px 6px">${pctTxt}</td><td style="padding:2px 0">${desc}</td></tr>`);
  }

  if (rows.length === 0) {
    return `<div style="max-width:240px;line-height:1.4"><strong>CLI Soil Capability</strong><br><em>No class data on this polygon.</em></div>`;
  }

  return `
    <div style="max-width:300px;line-height:1.4">
      <strong>CLI Soil Capability for Agriculture</strong>
      <table style="margin-top:6px;font-size:12px;border-collapse:collapse">${rows.join('')}</table>
      <div style="margin-top:6px;color:#666;font-size:11px">
        Class 1 = prime · 7 = no agricultural capability
      </div>
    </div>
  `;
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
  if (p.AADT != null) {
    lines.push(`<strong>AADT</strong> ${Number(p.AADT).toLocaleString('en-US')}`);
  }
  if (p.DateOfEsti != null) lines.push(`Estimate year: ${escapeHtml(p.DateOfEsti)}`);
  if (p.FlowDirect) lines.push(`Flow: ${escapeHtml(p.FlowDirect)}`);
  if (p.START_KM != null && p.END_KM != null) {
    lines.push(`km ${Number(p.START_KM).toFixed(1)} → ${Number(p.END_KM).toFixed(1)}`);
  }
  if (p.StationNum != null) lines.push(`<em>Source station #${escapeHtml(p.StationNum)}</em>`);
  return `<div style="max-width:260px;line-height:1.4">${lines.join('<br>')}</div>`;
}

/** Read whichever overlay polygons sit under a screen point, restricted
 *  to layers that are currently visible. Used by the muni-parcels hover/
 *  click popups so they can show zoning + dev-plan info on parcels that
 *  aren't the search result. Returns the first hit's properties for each
 *  layer, or null if the layer is hidden / nothing's there. */
function readOverlaysAt(map, point) {
  const out = { zoning: null, devplan: null };
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
  return out;
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
  if (p.Roll_No_Txt)      lines.push(`<strong>Roll #</strong> ${escapeHtml(rollDisplayFor(p))}`);
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
  // Land size — _acres is computed and stamped onto each feature in
  // arcgis.js when the muni-parcels FC is fetched. Show both ac and sf.
  const ac = Number(p._acres);
  if (Number.isFinite(ac) && ac > 0) {
    const sf = Math.round(ac * 43560).toLocaleString('en-US');
    const acFmt = ac < 0.1 ? ac.toFixed(3)
                : ac < 10  ? ac.toFixed(2)
                : ac < 1000 ? ac.toFixed(1)
                : Math.round(ac).toLocaleString('en-US');
    lines.push(`<strong>Land Size</strong> ${acFmt} ac · ${sf} sf`);
  }
  if (p.Total_Value) {
    const cleaned = String(p.Total_Value).replace(/[^0-9.]/g, '');
    const n = Number(cleaned);
    if (Number.isFinite(n) && n > 0) {
      lines.push(`<strong>Total Value</strong> $${Math.round(n).toLocaleString('en-US')}`);
    }
  }
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
  if (withReportLink) {
    const safeReport = safeExternalUrl(p.Asmt_Rpt_Url);
    if (safeReport) {
      lines.push(`<a href="${escapeHtml(safeReport)}" target="_blank" rel="noreferrer">Assessment report →</a>`);
    }
  }
  return `<div style="max-width:300px;line-height:1.4">${lines.join('<br>')}</div>`;
}

function emptyFc() { return { type: 'FeatureCollection', features: [] }; }

/**
 * Custom MapLibre control: a single button that flips the basemap between
 * CARTO Positron (streets) and Esri World Imagery (satellite). Sits in the
 * top-right gutter, just under the zoom buttons. Stateless — reads the
 * current visibility off the layers each click so we don't have to track
 * a separate flag.
 */
class BasemapToggleControl {
  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-toggle';
    this._btn = document.createElement('button');
    this._btn.type = 'button';
    this._btn.title = 'Toggle satellite basemap';
    this._btn.setAttribute('aria-label', 'Toggle satellite basemap');
    this._btn.textContent = 'Satellite';
    this._btn.addEventListener('click', () => this._toggle());
    this._container.appendChild(this._btn);
    return this._container;
  }
  _toggle() {
    const map = this._map;
    const imageryVisible = map.getLayoutProperty('esri-imagery', 'visibility') === 'visible';
    const next = !imageryVisible;
    map.setLayoutProperty('esri-imagery',  'visibility', next ? 'visible' : 'none');
    map.setLayoutProperty('carto-positron','visibility', next ? 'none' : 'visible');
    this._btn.textContent = next ? 'Streets' : 'Satellite';
    this._btn.classList.toggle('active', next);
  }
  onRemove() {
    this._container.parentNode?.removeChild(this._container);
    this._map = null;
  }
}

/**
 * Temporary diagnostic control that shows the current zoom level in
 * the top-left corner. Used while we're tuning zoom-dependent paint
 * expressions (per-parcel-area label scaling, minzoom thresholds,
 * etc). Updates on every move event; styled inline so we don't need
 * to add a CSS rule for a control that's expected to come out again.
 */
class ZoomLevelControl {
  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group zoom-level';
    this._container.style.padding = '4px 8px';
    this._container.style.fontSize = '12px';
    this._container.style.fontFamily = 'system-ui, sans-serif';
    this._container.style.background = 'rgba(255, 255, 255, 0.92)';
    this._container.style.color = '#1a3a4a';
    this._container.style.fontWeight = '600';
    this._container.style.minWidth = '64px';
    this._container.style.textAlign = 'center';
    this._update = () => {
      const z = this._map.getZoom();
      this._container.textContent = `Zoom ${z.toFixed(2)}`;
    };
    this._update();
    this._map.on('move', this._update);
    return this._container;
  }
  onRemove() {
    if (this._map) this._map.off('move', this._update);
    this._container.parentNode?.removeChild(this._container);
    this._map = null;
  }
}

/** Allow only http/https URLs into anchor hrefs that come from external
 *  data (contaminated-sites CSV, ROLL_ENTRY's Asmt_Rpt_Url, etc.). */
function safeExternalUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw), window.location.origin);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch { /* not parseable */ }
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
    .replace(/"/g, '&quot;');
}
