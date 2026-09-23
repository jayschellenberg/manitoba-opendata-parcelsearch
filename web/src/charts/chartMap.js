/*
 * The Sales Charts map (the land template's CMS maps): one MapLibre map of
 * the charted sales, coloured by whichever measure the page picks, with the
 * subject and distance rings around it.
 *
 * ONE map for the page's lifetime. The charts grid is rebuilt on every
 * message from the main window, several times a second while filters move;
 * re-creating a WebGL map on each would flash and leak contexts. The page
 * keeps the figure this returns and re-appends it; setData() swaps the
 * GeoJSON underneath.
 *
 * Point colours arrive precomputed in each feature's `color` property, so
 * this module knows nothing about prices or zoning — the page decides.
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol as PMTilesProtocol } from 'pmtiles';
import { streetsStyle } from '../lib/basemapStyle.js';
import { R_STYLE, exportChartPng } from '../lib/chartRender.js';
import { circleRing } from '../lib/salesMapColors.js';

let protocolAdded = false;

const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * Build the map card. `onPick(saleId)` fires on a click on a sale;
 * `popupRows(saleId)` returns [[label, value], …] for its popup.
 * Returns {figure, setData(fc, {subject, rings, fitKey}), setLegend(items, title), resize()}.
 */
export function createSalesMap({ onPick, popupRows }) {
  if (!protocolAdded) {
    maplibregl.addProtocol('pmtiles', new PMTilesProtocol().tile);
    protocolAdded = true;
  }

  const figure = document.createElement('figure');
  figure.className = 'chart-card map-card';
  const cap = document.createElement('figcaption');
  const h = document.createElement('h3');
  const sub = document.createElement('p');
  sub.className = 'chart-sub';
  cap.append(h, sub);
  figure.appendChild(cap);
  const box = document.createElement('div');
  box.className = 'sales-map';
  figure.appendChild(box);
  const legendEl = document.createElement('ul');
  legendEl.className = 'chart-legend';
  figure.appendChild(legendEl);
  let munisOn = true;
  let legendItems = [];
  // PNG, top-right like every chart card. The filename comes from the page
  // (its pngName rule), set through setPngName.
  let pngFile = 'sales-map';
  const pngBtn = document.createElement('button');
  pngBtn.type = 'button';
  pngBtn.className = 'chart-png-btn';
  pngBtn.textContent = 'PNG';
  pngBtn.title = 'Download this map as a PNG image (6.5 x 3.5 in)';
  figure.appendChild(pngBtn);
  const note = document.createElement('p');
  note.className = 'chart-note';
  figure.appendChild(note);

  const map = new maplibregl.Map({
    container: box,
    style: streetsStyle(),
    // Keeps the last frame readable, so the PNG export can copy the canvas
    // without waiting for (or racing) the next render.
    preserveDrawingBuffer: true,
    center: [-97.14, 49.9],
    zoom: 7,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  // Municipal boundaries, fetched on the page and handed over as data, as
  // lib/muniLayer.js does for the main map: a URL given to a geojson source
  // is fetched from MapLibre's worker, where a page-relative path does not
  // resolve against the page. Started now so it overlaps the style load.
  const munisFc = fetch(new URL('mb-municipalities.geojson', window.location.href))
    .then((r) => (r.ok ? r.json() : null))
    .catch((err) => { console.warn('Municipal boundaries failed to load', err); return null; });

  function applyMunis() {
    if (!ready) return;
    for (const id of ['munis-line', 'munis-label']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', munisOn ? 'visible' : 'none');
    }
  }

  let pending = null;   // data that arrived before the style finished loading
  let lastFitKey = null;
  // Our own flag, not map.isStyleLoaded(): that reads false for a moment
  // whenever tiles are still streaming in, which would park fresh data in
  // `pending` with nothing left to flush it.
  let ready = false;

  map.on('load', () => {
    ready = true;
    // Municipal boundaries (Jason, 2026-09-23), the same file the main map's
    // muni layer and click-to-pick use. Under the sales, over the basemap.
    map.addSource('munis', { type: 'geojson', data: EMPTY });
    munisFc.then((fc) => { if (fc) map.getSource('munis')?.setData(fc); });
    map.addLayer({
      id: 'munis-line', type: 'line', source: 'munis',
      paint: { 'line-color': '#5b5b5b', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 12, 1.8], 'line-opacity': 0.8 },
    });
    map.addLayer({
      id: 'munis-label', type: 'symbol', source: 'munis', minzoom: 8,
      layout: {
        'text-field': ['get', 'MUNI_LIST_NAME_WITH_TYPE'],
        // The one stack the glyph server serves (see fontStacks.test.js).
        'text-font': ['Open Sans Semibold'],
        'text-size': 12,
      },
      paint: { 'text-color': '#3a3a3a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    });
    applyMunis();
    map.addSource('rings', { type: 'geojson', data: EMPTY });
    map.addSource('sales', { type: 'geojson', data: EMPTY });
    map.addSource('subject', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'rings-line', type: 'line', source: 'rings',
      paint: { 'line-color': R_STYLE.subject, 'line-width': 1.5, 'line-dasharray': [3, 3], 'line-opacity': 0.8 },
    });
    // The ring's distance, written along it — an unlabelled circle was the
    // confusing part.
    map.addLayer({
      id: 'rings-label', type: 'symbol', source: 'rings',
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 300,
        'text-field': ['get', 'label'],
        // The one stack the glyph server serves (see fontStacks.test.js).
        'text-font': ['Open Sans Semibold'],
        'text-size': 12,
      },
      paint: { 'text-color': R_STYLE.subject, 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    });
    // Excluded sales under the rest, pale, as on the charts.
    map.addLayer({
      id: 'sales-circles', type: 'circle', source: 'sales',
      layout: { 'circle-sort-key': ['case', ['get', 'excluded'], 0, 1] },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 4, 12, 7],
        'circle-color': ['coalesce', ['get', 'color'], R_STYLE.pointFill],
        'circle-opacity': ['case', ['get', 'excluded'], R_STYLE.excludedOpacity, 0.85],
        'circle-stroke-color': ['case', ['get', 'excluded'], R_STYLE.excludedStroke, '#404040'],
        'circle-stroke-width': 0.75,
      },
    });
    map.addLayer({
      id: 'subject-dot', type: 'circle', source: 'subject',
      paint: {
        'circle-radius': 8, 'circle-color': R_STYLE.subject,
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5,
      },
    });
    map.on('mouseenter', 'sales-circles', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'sales-circles', () => { map.getCanvas().style.cursor = ''; });
    map.on('click', 'sales-circles', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const id = f.properties.saleId;
      const rows = popupRows(id);
      const wrap = document.createElement('div');
      wrap.className = 'map-popup';
      for (const [label, value] of rows) {
        const r = document.createElement('div');
        r.className = 'chart-tip-row';
        const v = document.createElement('strong');
        v.textContent = value;
        const l = document.createElement('span');
        l.textContent = label;
        r.append(v, l);
        wrap.appendChild(r);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'map-popup-btn';
      btn.textContent = f.properties.excluded ? 'Include this sale' : 'Exclude this sale';
      const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
        .setLngLat(f.geometry.coordinates)
        .setDOMContent(wrap)
        .addTo(map);
      btn.addEventListener('click', () => { popup.remove(); onPick(id); });
      wrap.appendChild(btn);
    });
    if (pending) { apply(pending); pending = null; }
  });

  function apply({ fc, subject, rings, fitKey }) {
    map.getSource('sales').setData(fc);
    map.getSource('subject').setData(subject ? {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [subject.lng, subject.lat] } }],
    } : EMPTY);
    map.getSource('rings').setData(subject && rings?.length ? {
      type: 'FeatureCollection',
      features: rings.map((km) => ({
        type: 'Feature', properties: { km, label: `${km} km` },
        geometry: { type: 'LineString', coordinates: circleRing(subject, km) },
      })),
    } : EMPTY);
    // Refit only when the SET of sales changed, not on every recolour or
    // republish — a map that jumps back while you are panning is unusable.
    if (fitKey !== lastFitKey && fc.features.length) {
      lastFitKey = fitKey;
      const b = new maplibregl.LngLatBounds();
      for (const f of fc.features) b.extend(f.geometry.coordinates);
      if (subject) b.extend([subject.lng, subject.lat]);
      // The whole distance-filter ring in view, not cut off at the edges.
      if (subject) for (const km of rings || []) for (const c of circleRing(subject, km, 16)) b.extend(c);
      map.fitBounds(b, { padding: 40, maxZoom: 13, duration: 0 });
    }
  }

  const api = {
    figure,
    setPngName(name) { pngFile = name; },
    setHeader(title, subtitle) { h.textContent = title; sub.textContent = subtitle || ''; },
    setNote(text) { note.textContent = text || ''; },
    setLegend(items) {
      legendItems = (items || []).map((it) => ({ label: it.label, color: it.color, dot: 'swatch' }));
      legendEl.textContent = '';
      for (const item of items || []) {
        const li = document.createElement('li');
        const sw = document.createElement('span');
        sw.className = 'chart-key chart-key-dot chart-key-dot-swatch';
        sw.style.background = item.color;
        sw.style.borderColor = '#404040';
        const label = document.createElement('span');
        label.textContent = item.label;
        li.append(sw, label);
        legendEl.appendChild(li);
      }
    },
    /** Show or hide the municipal boundaries. */
    setMunisVisible(on) { munisOn = !!on; applyMunis(); },
    /** Download the map as the template-sized PNG (6.5 x 3.5 in), with the
     *  card's title, criteria line, legend and note around it. */
    exportPng(filename) {
      return exportChartPng({
        raster: map.getCanvas(),
        title: h.textContent,
        subtitle: sub.textContent,
        legend: legendItems.length > 1 ? legendItems : null,
        note: note.textContent,
        filename,
      });
    },
    setData(data) {
      if (ready) apply(data);
      else pending = data;
    },
    resize() { map.resize(); },
    /** The MapLibre map, for linkMaps. */
    map,
  };
  pngBtn.addEventListener('click', () => {
    api.exportPng(pngFile).catch((err) => {
      console.warn('Map PNG export failed', err);
      pngBtn.textContent = 'Failed';
      setTimeout(() => { pngBtn.textContent = 'PNG'; }, 2000);
    });
  });
  return api;
}

/**
 * Keep two sales maps on the same view: pan or zoom either and the other
 * follows, so a spot on one reads straight across to the other. The lock
 * stops the follower's own move event echoing back.
 */
export function linkMaps(a, b) {
  let lock = false;
  const follow = (from, to) => from.map.on('move', () => {
    if (lock) return;
    lock = true;
    to.map.jumpTo({
      center: from.map.getCenter(), zoom: from.map.getZoom(),
      bearing: from.map.getBearing(), pitch: from.map.getPitch(),
    });
    lock = false;
  });
  follow(a, b);
  follow(b, a);
}
