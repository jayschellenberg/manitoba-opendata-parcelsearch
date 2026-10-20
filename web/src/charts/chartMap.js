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
import { R_STYLE, exportChartPng, renderChartPng } from '../lib/chartRender.js';
import { PARCEL_TILES_URL } from '../lib/parcelTilesUrl.js';
import { circleRing } from '../lib/salesMapColors.js';
import { solveCompLabels, nearestOnBox, pinBox, PIN_HEAD_UP } from '../lib/compLabelLayout.js';

let protocolAdded = false;

/** Device pixels per CSS pixel the pin is drawn at, so it stays crisp in the 1950px PNG. */
const PIN_RATIO = 3;

/**
 * A Google-Maps-style teardrop pin, 26 x 38 CSS px with its tip at the
 * bottom centre: `fill` with a darker `stroke` outline and a `dot` in the
 * middle. Drawn on a canvas and handed to MapLibre as pixels, which needs no
 * image fetch (the CSP allows none) and no sprite. The subject is red with a
 * dark dot; a comparable (the comp map, 2026-10-20) takes its property
 * type's colour with a white dot, so the two never read alike.
 */
function pinImage(fill = '#EA4335', stroke = '#A52714', dot = '#7B1A0E') {
  const W = 26;
  const H = 38;
  const c = document.createElement('canvas');
  c.width = W * PIN_RATIO;
  c.height = H * PIN_RATIO;
  const ctx = c.getContext('2d');
  ctx.scale(PIN_RATIO, PIN_RATIO);
  // A 24 x 36 teardrop, inset 1px for the outline.
  ctx.translate(1, 1);
  const body = new Path2D('M12 0C5.37 0 0 5.37 0 12c0 8.4 10.2 21.3 11.1 22.6a1.1 1.1 0 0 0 1.8 0C13.8 33.3 24 20.4 24 12 24 5.37 18.63 0 12 0z');
  ctx.fillStyle = fill;
  ctx.fill(body);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = stroke;
  ctx.stroke(body);
  ctx.beginPath();
  ctx.arc(12, 12, 4.6, 0, Math.PI * 2);
  ctx.fillStyle = dot;
  ctx.fill();
  return ctx.getImageData(0, 0, c.width, c.height);
}
const subjectPinImage = () => pinImage();

/** `#rrggbb` darkened by `f` (0..1), for a pin's outline. */
function darken(hex, f = 0.35) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return '#333333';
  const ch = (v) => Math.round(v * (1 - f)).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

/** Callout text: bold, the R charts' Arial. */
const CALLOUT_FONT_PX = 12;
const CALLOUT_LINE_PX = 15;
const CALLOUT_PAD_X = 5;
const CALLOUT_PAD_Y = 3;

/**
 * A comp's callout (the comp map, 2026-10-20): its lines of text in a
 * white box outlined in the pin's colour. An image rather than a MapLibre
 * text label so its size is known exactly — lib/compLabelLayout.js needs
 * every box's width to keep them apart — and, like the pin, it is part of
 * the WebGL canvas and so prints in the PNG and the work file.
 * Returns {data, w, h} with w, h in CSS px.
 */
function calloutImage(lines, color) {
  const font = `bold ${CALLOUT_FONT_PX}px Arial, Helvetica, sans-serif`;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const textW = Math.max(...lines.map((l) => probe.measureText(l).width));
  const w = Math.ceil(textW + CALLOUT_PAD_X * 2);
  const h = Math.ceil(lines.length * CALLOUT_LINE_PX + CALLOUT_PAD_Y * 2);
  const c = document.createElement('canvas');
  c.width = w * PIN_RATIO;
  c.height = h * PIN_RATIO;
  const ctx = c.getContext('2d');
  ctx.scale(PIN_RATIO, PIN_RATIO);
  ctx.beginPath();
  ctx.roundRect(0.75, 0.75, w - 1.5, h - 1.5, 3);
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.font = font;
  ctx.fillStyle = '#1a1a1a';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, CALLOUT_PAD_X, CALLOUT_PAD_Y + CALLOUT_LINE_PX * (i + 0.5)));
  return { data: ctx.getImageData(0, 0, c.width, c.height), w, h };
}

const EMPTY = { type: 'FeatureCollection', features: [] };
/**
 * The zoom the sale outlines start at. 10, not the tiles' own 8 (Jason,
 * 2026-10-07): tippecanoe thins the densest zoom 8–9 tiles to fit its size
 * cap — the 2026-10-04 build kept 29–72% of the parcels in the Winnipeg-area
 * tiles — so a spread set of comps framed at 8–9 drew outlines for some sales
 * and not others. From 10 every parcel is in its tile.
 */
export const OUTLINE_MINZOOM = 10;
/** Where a comp label may sit round its dot, in the order tried: above first. */
export const LABEL_ANCHORS = ['bottom', 'top', 'left', 'right', 'bottom-left', 'bottom-right', 'top-left', 'top-right'];
/** A filter that matches no parcel: the outline layers' state with no sales. */
const OUTLINE_NONE = ['==', ['get', 'Roll_No_Txt'], '\u0000'];
/** A tile parcel's key, as the sale records spell it: "MUNI (TYPE)|roll". */
const PARCEL_KEY = ['concat', ['get', 'Muni_Name_With_Typ'], '|', ['get', 'Roll_No_Txt']];

/**
 * Build the map card. `onPick(saleId)` fires on a click on a sale;
 * `popupRows(saleId)` returns [[label, value], …] for its popup, and
 * `popupActions(saleId)` [{text, run}] — extra buttons under the Exclude one
 * (the comp-tag toggles, charts Phase 2).
 * `pins` (the comp map, 2026-10-20): each sale is a teardrop pin in its
 * feature's `color`, and a sale with a `callout` (lines joined by "\n") gets
 * that text in a box beside its pin, or out in clear space with a leader line
 * when pins crowd together (lib/compLabelLayout.js). The subject gets a
 * "Subject Property" callout the same way.
 * Returns {figure, setData(fc, {subject, rings, fitKey}), setLegend(items, title), resize()}.
 */
export function createSalesMap({ onPick, popupRows, popupActions = () => [], pins = false }) {
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
  // Bounds still waiting to be fitted: a map filled while its tab is hidden
  // (or its figure detached) has a 0 x 0 box, and fitting into that zooms
  // out to the world. The fit runs on the first resize with a real size.
  let pendingFit = null;
  const hasSize = () => box.clientWidth > 0 && box.clientHeight > 0;
  // Padding scales with the map: a fixed 40px left a half-width map
  // (~130px tall on a laptop) only ~50px for the sales.
  const fitNow = (b) => {
    const p = Math.round(Math.max(8, Math.min(40, box.clientHeight * 0.1, box.clientWidth * 0.1)));
    map.fitBounds(b, {
      // A pin stands 38 px above its point, so pin mode keeps that much more
      // room at the top, and a little at the sides for the callouts.
      padding: pins ? { top: p + 40, bottom: p + 6, left: p + 24, right: p + 24 } : p,
      maxZoom: 13,
      duration: 0,
    });
  };
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
    // The sales' parcel outlines (2026-10-07), from the site's own parcel
    // tiles filtered to the sales' parcels (municipality + roll, see
    // PARCEL_KEY) and coloured like their dots.
    // From zoom 10 (OUTLINE_MINZOOM); further out the dots carry the map alone.
    // Under the rings, dots and pin, which stay the click targets.
    map.addSource('parcel-tiles', { type: 'vector', url: `pmtiles://${PARCEL_TILES_URL}` });
    map.addLayer({
      id: 'sale-outline-fill', type: 'fill', source: 'parcel-tiles', 'source-layer': 'parcels',
      minzoom: OUTLINE_MINZOOM, filter: OUTLINE_NONE,
      paint: { 'fill-color': R_STYLE.pointFill, 'fill-opacity': 0.22 },
    });
    map.addLayer({
      id: 'sale-outline-line', type: 'line', source: 'parcel-tiles', 'source-layer': 'parcels',
      minzoom: OUTLINE_MINZOOM, filter: OUTLINE_NONE,
      paint: { 'line-color': R_STYLE.pointStroke, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 14, 2.2] },
    });
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
    // Excluded sales under the rest, pale, as on the charts. A `context`
    // sale (the Water tab's dry sales, shown for the market around the water
    // ones) is smaller, grey and faint, and sits under everything.
    const ctx = ['==', ['get', 'context'], true];
    if (pins) {
      // Leaders under the pins, so each line runs out from behind its pin.
      map.addSource('leaders', { type: 'geojson', data: EMPTY });
      map.addSource('callouts', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'leaders-line', type: 'line', source: 'leaders',
        paint: { 'line-color': '#3a3a3a', 'line-width': 1.1 },
      });
      map.addLayer({
        id: 'sales-pins', type: 'symbol', source: 'sales',
        layout: {
          'icon-image': ['get', 'pin'],
          'icon-anchor': 'bottom',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });
    }
    map.addLayer({
      id: 'sales-circles', type: 'circle', source: 'sales',
      layout: { 'circle-sort-key': ['case', ctx, -1, ['get', 'excluded'], 0, 1] },
      // In pin mode the dots are the pins' invisible click and hover
      // targets, lifted onto the pin heads; the pins themselves draw.
      paint: pins ? {
        'circle-radius': 12,
        'circle-opacity': 0,
        'circle-stroke-width': 0,
        'circle-translate': [0, -PIN_HEAD_UP],
      } : {
        // Zoom has to be the outermost expression, so the context size
        // switch sits inside each stop.
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, ['case', ctx, 2.5, 4], 12, ['case', ctx, 4, 7]],
        'circle-color': ['case', ctx, '#9e9e9e', ['coalesce', ['get', 'color'], R_STYLE.pointFill]],
        'circle-opacity': ['case', ctx, 0.35, ['get', 'excluded'], R_STYLE.excludedOpacity, 0.85],
        'circle-stroke-color': ['case', ctx, '#bdbdbd', ['get', 'excluded'], R_STYLE.excludedStroke, '#404040'],
        'circle-stroke-width': ['case', ctx, 0.5, 0.75],
      },
    });
    // A tagged comparable (charts Phase 2): a ring and its number above the
    // dot, in the charts' tag red. On the canvas, so both print.
    const tagged = ['all', ['has', 'label'], ['!=', ['get', 'label'], '']];
    if (!pins) map.addLayer({
      id: 'sales-tag-ring', type: 'circle', source: 'sales', filter: tagged,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 6.5, 12, 9.5],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#B3261E',
        'circle-stroke-width': 2,
      },
    });
    if (!pins) map.addLayer({
      id: 'sales-tag-label', type: 'symbol', source: 'sales', filter: tagged,
      // Labels avoid each other and the subject pin (2026-10-07): each
      // tries above its dot first, then the other sides and corners, and
      // lower comp numbers are placed first (labelRank). They used to be
      // drawn with collisions off, so a comp beside the subject sat under
      // the pin and two near comps printed on top of each other. In the
      // rare crowd where no side fits — far zoomed out — the number waits
      // for a closer zoom; the ring below it (a circle layer) always draws.
      layout: {
        'text-field': ['get', 'label'],
        // The one stack the glyph server serves (see fontStacks.test.js).
        'text-font': ['Open Sans Semibold'],
        'text-size': 13,
        'text-variable-anchor': LABEL_ANCHORS,
        'text-radial-offset': 0.95,
        'text-justify': 'auto',
        'text-padding': 1,
        'symbol-sort-key': ['coalesce', ['get', 'labelRank'], 999],
        'text-allow-overlap': false,
        'text-ignore-placement': false,
      },
      paint: { 'text-color': '#B3261E', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
    });
    // The subject as a map pin (Jason, 2026-10-06), tip on the point. A
    // style icon, not a DOM Marker, so it is part of the WebGL canvas and
    // prints into the PNG and the work file.
    if (!map.hasImage('subject-pin')) map.addImage('subject-pin', subjectPinImage(), { pixelRatio: PIN_RATIO });
    map.addLayer({
      id: 'subject-dot', type: 'symbol', source: 'subject',
      layout: {
        'icon-image': 'subject-pin',
        'icon-anchor': 'bottom',
        // Always drawn, and it CLAIMS its space: the comp labels (placed
        // after it — it is the higher layer) move round it rather than
        // printing over it.
        'icon-allow-overlap': true,
        'icon-ignore-placement': false,
      },
    });
    // The callouts on top of everything: lib/compLabelLayout.js has already
    // kept them off every pin and every other callout, so MapLibre must draw
    // them all where they were put, never drop one.
    if (pins) {
      map.addLayer({
        id: 'callouts', type: 'symbol', source: 'callouts',
        layout: {
          'icon-image': ['get', 'img'],
          'icon-anchor': 'center',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });
      let queued = false;
      map.on('move', () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; layoutCallouts(); });
      });
      map.on('resize', layoutCallouts);
    }
    // Hover readout (Jason, 2026-10-06): the click popup's facts without
    // its button, following the pointer. A DOM popup, so it never reaches
    // the PNG, which copies the WebGL canvas only.
    const hoverTip = new maplibregl.Popup({
      closeButton: false, closeOnClick: false, maxWidth: '280px', offset: 10, className: 'map-hover-tip',
    });
    let hoverId = null;
    const hideTip = () => { hoverTip.remove(); hoverId = null; };
    map.on('mousemove', 'sales-circles', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      map.getCanvas().style.cursor = 'pointer';
      // A click popup open on this sale already says all of it.
      if (clickPopup?.isOpen() && clickId === f.properties.saleId) { hideTip(); return; }
      if (hoverId !== f.properties.saleId) {
        hoverId = f.properties.saleId;
        hoverTip.setDOMContent(popupBody(hoverId, 'Click for details or to exclude'));
      }
      hoverTip.setLngLat(f.geometry.coordinates).addTo(map);
    });
    map.on('mouseleave', 'sales-circles', () => { map.getCanvas().style.cursor = ''; hideTip(); });
    map.on('mouseenter', 'subject-dot', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const body = document.createElement('div');
      body.className = 'map-popup';
      const strong = document.createElement('strong');
      strong.textContent = 'Subject';
      body.appendChild(strong);
      hoverId = '__subject';
      hoverTip.setDOMContent(body).setLngLat(f.geometry.coordinates).addTo(map);
    });
    map.on('mouseleave', 'subject-dot', hideTip);
    let clickPopup = null;
    let clickId = null;
    map.on('click', 'sales-circles', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      hideTip();
      const id = f.properties.saleId;
      const wrap = popupBody(id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'map-popup-btn';
      btn.textContent = f.properties.excluded ? 'Include this sale' : 'Exclude this sale';
      clickPopup?.remove();
      const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
        .setLngLat(f.geometry.coordinates)
        .setDOMContent(wrap)
        .addTo(map);
      clickPopup = popup;
      clickId = id;
      btn.addEventListener('click', () => { popup.remove(); onPick(id); });
      const actions = document.createElement('div');
      actions.className = 'map-popup-actions';
      actions.appendChild(btn);
      for (const a of popupActions(id) || []) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'map-popup-btn map-popup-tag';
        b.textContent = a.text;
        b.addEventListener('click', () => { popup.remove(); a.run(); });
        actions.appendChild(b);
      }
      wrap.appendChild(actions);
    });
    if (pending) { apply(pending); pending = null; }
  });

  /** A sale's facts as label/value rows — the click popup and the hover tip. */
  function popupBody(id, hint = '') {
    const wrap = document.createElement('div');
    wrap.className = 'map-popup';
    for (const [label, value] of popupRows(id)) {
      const r = document.createElement('div');
      r.className = 'chart-tip-row';
      const v = document.createElement('strong');
      v.textContent = value;
      const l = document.createElement('span');
      l.textContent = label;
      r.append(v, l);
      wrap.appendChild(r);
    }
    if (hint) {
      const h = document.createElement('div');
      h.className = 'map-hover-hint';
      h.textContent = hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  /**
   * Point the outline layers at the drawn sales' parcels: a filter on their
   * keys and a match giving each parcel its sale's colour (context sales
   * grey). An empty set filters everything out.
   */
  function applyOutlines(fc) {
    const colorOf = new Map();
    for (const f of fc.features || []) {
      const pr = f.properties || {};
      const color = pr.context ? '#9e9e9e' : (pr.color || R_STYLE.pointFill);
      for (const k of pr.parcelKeys || []) if (!colorOf.has(k)) colorOf.set(k, color);
    }
    if (!colorOf.size) {
      for (const id of ['sale-outline-fill', 'sale-outline-line']) map.setFilter(id, OUTLINE_NONE);
      return;
    }
    const keys = [...colorOf.keys()];
    const filter = ['in', PARCEL_KEY, ['literal', keys]];
    const match = ['match', PARCEL_KEY];
    for (const [k, color] of colorOf) match.push(k, color);
    match.push(R_STYLE.pointFill);
    for (const id of ['sale-outline-fill', 'sale-outline-line']) map.setFilter(id, filter);
    map.setPaintProperty('sale-outline-fill', 'fill-color', match);
    map.setPaintProperty('sale-outline-line', 'line-color', match);
  }

  // Pin mode's callouts: what to label ({key, lng, lat, img, w, h}, in
  // placement order), the pins with no label (obstacles only), the image
  // sizes made so far, and the last solve (so labels hold still on a pan).
  let calloutSpecs = [];
  let unlabelledPins = [];
  const calloutSizes = new Map();
  let calloutPrev = null;

  /** Register the pin and callout images a feature set needs; fill calloutSpecs. */
  function preparePins(fc, subject) {
    calloutSpecs = [];
    unlabelledPins = [];
    const addCallout = (key, lines, color, lng, lat) => {
      const img = `co-${color}-${lines.join('|')}`;
      if (!calloutSizes.has(img)) {
        const { data, w, h } = calloutImage(lines, color);
        if (!map.hasImage(img)) map.addImage(img, data, { pixelRatio: PIN_RATIO });
        calloutSizes.set(img, { w, h });
      }
      calloutSpecs.push({ key, lng, lat, img, ...calloutSizes.get(img) });
    };
    if (subject) addCallout('__subject', ['Subject Property'], '#C5221F', subject.lng, subject.lat);
    const labelled = [];
    for (const f of fc.features || []) {
      const pr = f.properties || {};
      const color = pr.color || R_STYLE.pointFill;
      pr.pin = `pin-${color}`;
      if (!map.hasImage(pr.pin)) map.addImage(pr.pin, pinImage(color, darken(color), '#ffffff'), { pixelRatio: PIN_RATIO });
      const [lng, lat] = f.geometry.coordinates;
      if (pr.callout) labelled.push({ pr, color, lng, lat });
      else unlabelledPins.push([lng, lat]);
    }
    labelled.sort((a, b) => (a.pr.labelRank ?? 999) - (b.pr.labelRank ?? 999));
    for (const l of labelled) addCallout(String(l.pr.saleId), String(l.pr.callout).split('\n'), l.color, l.lng, l.lat);
    calloutPrev = null;
  }

  /** Place the callouts for the current view and redraw them and their leaders. */
  function layoutCallouts() {
    if (!pins || !ready || !map.getSource('callouts')) return;
    if (!hasSize() || !calloutSpecs.length) {
      map.getSource('callouts').setData(EMPTY);
      map.getSource('leaders').setData(EMPTY);
      return;
    }
    const items = calloutSpecs.map((c) => {
      const p = map.project([c.lng, c.lat]);
      return { key: c.key, x: p.x, y: p.y, w: c.w, h: c.h };
    });
    const others = unlabelledPins.map((ll) => { const p = map.project(ll); return pinBox(p.x, p.y); });
    const view = { width: box.clientWidth, height: box.clientHeight };
    // Keep clear of the zoom buttons and the attribution, measured as they
    // stand (the attribution opens wide until the map is first moved): they
    // are not in the PNG, but on screen they would hide a label.
    const at = box.getBoundingClientRect();
    for (const el of box.querySelectorAll('.maplibregl-ctrl')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) others.push({ x0: r.left - at.left - 2, y0: r.top - at.top - 2, x1: r.right - at.left + 2, y1: r.bottom - at.top + 2 });
    }
    const res = solveCompLabels(items, view, calloutPrev, others);
    calloutPrev = res;
    const ll = (x, y) => { const q = map.unproject([x, y]); return [q.lng, q.lat]; };
    const callouts = [];
    const leaders = [];
    items.forEach((it, i) => {
      const r = res.get(it.key);
      const cx = it.x + r.dx;
      const cy = it.y + r.dy;
      callouts.push({ type: 'Feature', properties: { img: calloutSpecs[i].img }, geometry: { type: 'Point', coordinates: ll(cx, cy) } });
      if (r.leader) {
        const b = { x0: cx - it.w / 2, y0: cy - it.h / 2, x1: cx + it.w / 2, y1: cy + it.h / 2 };
        const hy = it.y - PIN_HEAD_UP;
        const [lx, ly] = nearestOnBox(b, it.x, hy);
        leaders.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [ll(it.x, hy), ll(lx, ly)] } });
      }
    });
    map.getSource('callouts').setData({ type: 'FeatureCollection', features: callouts });
    map.getSource('leaders').setData({ type: 'FeatureCollection', features: leaders });
  }

  function apply({ fc, subject, rings, fitKey }) {
    if (pins) preparePins(fc, subject);
    map.getSource('sales').setData(fc);
    applyOutlines(fc);
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
      // Frame the sales the map is about; context dots ride along unframed
      // unless they are all there is.
      const focus = fc.features.filter((f) => !f.properties.context);
      for (const f of focus.length ? focus : fc.features) b.extend(f.geometry.coordinates);
      if (subject) b.extend([subject.lng, subject.lat]);
      // The whole distance-filter ring in view, not cut off at the edges.
      if (subject) for (const km of rings || []) for (const c of circleRing(subject, km, 16)) b.extend(c);
      if (hasSize()) { pendingFit = null; fitNow(b); } else pendingFit = b;
    }
    layoutCallouts();
  }

  const pngSpec = () => ({
    raster: map.getCanvas(),
    title: h.textContent,
    subtitle: sub.textContent,
    legend: legendItems.length > 1 ? legendItems : null,
    note: note.textContent,
  });

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
      return exportChartPng({ ...pngSpec(), filename });
    },
    /** The same image as a Blob, for the work-file zip. */
    pngBlob() { return renderChartPng(pngSpec()); },
    /** The card's title, for the work-file list. */
    title() { return h.textContent; },
    /** The file stem the PNG button would use. */
    pngName() { return pngFile; },
    /**
     * Resolves true once the map has drawn its current data: style and
     * tiles loaded and nothing moving — or false on the timeout. Capped at `timeoutMs` so a slow tile
     * server degrades to whatever is on the canvas rather than a hung
     * export. Only meaningful while the map is in a visible document —
     * a hidden tab never paints (no requestAnimationFrame).
     */
    whenIdle(timeoutMs = 15000) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
        setTimeout(() => finish(false), timeoutMs);
        const check = () => {
          if (ready && !pending && map.loaded() && map.areTilesLoaded() && !map.isMoving()) {
            // One more frame so the last tiles are on the canvas.
            requestAnimationFrame(() => requestAnimationFrame(() => finish(true)));
          } else {
            map.once('idle', check);
          }
        };
        check();
      });
    },
    setData(data) {
      if (ready) apply(data);
      else pending = data;
    },
    resize() {
      map.resize();
      if (pendingFit && hasSize()) { const b = pendingFit; pendingFit = null; fitNow(b); }
      layoutCallouts();
    },
    /** Frame these sales (and the subject) again — the comp map's Fit button. */
    refit() { lastFitKey = null; },
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
