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

// Manitoba's centroid sits roughly here. Initial zoom shows ~the populated
// southern half of the province.
const MB_CENTER = [-97.6, 51.0];
const MB_ZOOM = 5;

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
  });
  // Expose for runtime debugging in any environment.
  window._map = map;

  map.on('error', (e) => console.error('[map error]', e?.error?.message || e, e));
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new BasemapToggleControl(), 'top-right');

  const ready = new Promise((resolve) => {
    map.on('load', () => {
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

      // Zoning overlay (above dev-plan, below parcels).
      map.addSource('zoning', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'zoning-fill',
        type: 'fill',
        source: 'zoning',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': ['match', ['get', 'ZONE_CATEGORY'], ...ZONING_PALETTE, '#cccccc'],
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
          'text-size': 11,
          'text-allow-overlap': false,
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

      // Muni-wide parcel fabric — every Roll_Entry parcel in the selected
      // municipality, rendered in muted grey under the search-result
      // parcels. Toggleable; off by default since fetching can take a few
      // seconds for big RMs. Lets the user see the surrounding parcel
      // pattern without filtering every search to that level of detail.
      map.addSource('muni-parcels', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'muni-parcels-fill',
        type: 'fill',
        source: 'muni-parcels',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#9aa0b0', 'fill-opacity': 0.10 },
      });
      map.addLayer({
        id: 'muni-parcels-line',
        type: 'line',
        source: 'muni-parcels',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#5a6273', 'line-width': 0.6, 'line-opacity': 0.55 },
      });

      // Parcel highlight — primary layer, always on. Red fill so it pops
      // against any pale-coloured zoning/dev-plan overlay underneath.
      map.addSource('parcels', { type: 'geojson', data: emptyFc() });
      map.addLayer({
        id: 'parcel-fill',
        type: 'fill',
        source: 'parcels',
        paint: { 'fill-color': '#b22222', 'fill-opacity': 0.32 },
      });
      map.addLayer({
        id: 'parcel-line',
        type: 'line',
        source: 'parcels',
        paint: { 'line-color': '#690000', 'line-width': 2.5 },
      });

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
        muniHoverPopup
          .setLngLat(e.lngLat)
          .setHTML(muniParcelHtml(p))
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
        muniClickPopup
          .setLngLat(e.lngLat)
          .setHTML(muniParcelHtml(p, { withReportLink: true }))
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
  for (const id of ['devplan-fill', 'devplan-line']) {
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

export function setMuniParcelsData(map, fc) {
  const src = map.getSource('muni-parcels');
  if (src) src.setData(fc);
}
export function setMuniParcelsVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['muni-parcels-fill', 'muni-parcels-line']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

// ---------- popup builders ----------

function parcelHtml(p) {
  const lines = [];
  if (p.Roll_No_Txt)        lines.push(`<strong>Roll #</strong> ${escapeHtml(p.Roll_No_Txt)}`);
  if (p.Property_Address)   lines.push(escapeHtml(p.Property_Address));
  if (p.Muni_Name_With_Typ) lines.push(`<em>${escapeHtml(p.Muni_Name_With_Typ)}</em>`);
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
  if (p.LINK) {
    lines.push(`<a href="${escapeHtml(p.LINK)}" target="_blank" rel="noreferrer">Registry page →</a>`);
  }
  return `<div style="max-width:260px;line-height:1.4">${lines.join('<br>')}</div>`;
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

/**
 * Build the popup body for a muni-parcels feature. Hover variant shows
 * just the lightweight info; click variant adds an assessment-report
 * link if Asmt_Rpt_Url is present.
 */
function muniParcelHtml(p, { withReportLink = false } = {}) {
  const lines = [];
  if (p.Roll_No_Txt)      lines.push(`<strong>Roll #</strong> ${escapeHtml(p.Roll_No_Txt)}`);
  if (p.Property_Address) lines.push(escapeHtml(p.Property_Address));
  if (p.Muni_Name_With_Typ) lines.push(`<em>${escapeHtml(p.Muni_Name_With_Typ)}</em>`);
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
  if (withReportLink && p.Asmt_Rpt_Url) {
    lines.push(`<a href="${escapeHtml(p.Asmt_Rpt_Url)}" target="_blank" rel="noreferrer">Assessment report →</a>`);
  }
  return `<div style="max-width:260px;line-height:1.4">${lines.join('<br>')}</div>`;
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
