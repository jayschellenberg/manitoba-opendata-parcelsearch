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
import { R_STYLE } from '../lib/chartRender.js';
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
  const note = document.createElement('p');
  note.className = 'chart-note';
  figure.appendChild(note);

  const map = new maplibregl.Map({
    container: box,
    style: streetsStyle(),
    center: [-97.14, 49.9],
    zoom: 7,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  let pending = null;   // data that arrived before the style finished loading
  let lastFitKey = null;
  // Our own flag, not map.isStyleLoaded(): that reads false for a moment
  // whenever tiles are still streaming in, which would park fresh data in
  // `pending` with nothing left to flush it.
  let ready = false;

  map.on('load', () => {
    ready = true;
    map.addSource('rings', { type: 'geojson', data: EMPTY });
    map.addSource('sales', { type: 'geojson', data: EMPTY });
    map.addSource('subject', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'rings-line', type: 'line', source: 'rings',
      paint: { 'line-color': R_STYLE.subject, 'line-width': 1.25, 'line-dasharray': [3, 3], 'line-opacity': 0.7 },
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
        type: 'Feature', properties: { km },
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
      map.fitBounds(b, { padding: 40, maxZoom: 13, duration: 0 });
    }
  }

  return {
    figure,
    setHeader(title, subtitle) { h.textContent = title; sub.textContent = subtitle || ''; },
    setNote(text) { note.textContent = text || ''; },
    setLegend(items) {
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
    setData(data) {
      if (ready) apply(data);
      else pending = data;
    },
    resize() { map.resize(); },
  };
}
