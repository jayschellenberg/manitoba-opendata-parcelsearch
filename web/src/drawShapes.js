/*
 * Area-selection drawing — the map-facing half of the shape filter
 * (pure predicates: lib/shapeFilter.js). Hand-rolled on plain map
 * events rather than mapbox-gl-draw because the measurement tool owns
 * the page's MapboxDraw instance (its modes, styles and deleteAll
 * lifecycle); sharing it would couple two unrelated features.
 *
 * Three tools, Matrix-MLS conventions, one shared state machine:
 *   Radius    — click the centre, move, click again to set the radius.
 *   Rectangle — click one corner, move, click the opposite corner.
 *   Polygon   — click vertices; double-click or click the first
 *               vertex again to close; needs 3+.
 * Esc cancels an in-progress shape and disarms the tool. A committed
 * shape starts as INCLUDE (green); clicking it toggles to EXCLUDE
 * (red) and back. The eraser clears every shape.
 *
 * The control is sales-mode only via CSS (body.sales-mode gate in
 * style.css) — the filter it drives lives in the sales-CSV predicate
 * chain, so outside sales mode the buttons would do nothing.
 */

import {
  circleRing,
  rectRing,
  shapesToFc,
} from './lib/shapeFilter.js';
import { haversineKm } from './lib/routeSolver.js';

let shapes = [];
let nextId = 1;
let mapRef = null;
let armed = null;      // 'circle' | 'rectangle' | 'polygon' | null
let pending = null;    // in-progress tool state (see each handler)
let controlRef = null; // the toolbar, for button active-state sync
const changeCbs = new Set();

/** Current committed shapes — read by the sales filter predicate. */
export function getShapes() {
  return shapes;
}

/** True while a draw tool is armed. Map hover/click handlers stand
 *  down off this, same contract as isMeasuring(). */
export function isShapeDrawing() {
  return armed != null;
}

/** Register for shape-set changes (commit, mode toggle, clear). */
export function onShapesChanged(cb) {
  changeCbs.add(cb);
}

function emit() {
  for (const cb of changeCbs) {
    try { cb(shapes); } catch (err) { console.warn('shape change listener failed', err); }
  }
}

export function clearShapes() {
  if (shapes.length === 0 && !pending) return;
  shapes = [];
  cancelPending();
  render();
  emit();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

/**
 * Sources + layers for committed shapes and the in-progress preview.
 * Called from map.js's style-load block AFTER every other overlay so
 * the shapes draw on top of parcels (they are a filter the user just
 * drew — they must never hide under a fill).
 */
export function addShapeLayers(map) {
  map.addSource('shape-filter', { type: 'geojson', data: EMPTY_FC });
  map.addSource('shape-preview', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({
    id: 'shape-filter-fill',
    type: 'fill',
    source: 'shape-filter',
    paint: {
      'fill-color': [
        'match', ['get', 'mode'],
        'exclude', '#c62828',
        '#2e7d32',
      ],
      'fill-opacity': 0.12,
    },
  });
  map.addLayer({
    id: 'shape-filter-line',
    type: 'line',
    source: 'shape-filter',
    paint: {
      'line-color': [
        'match', ['get', 'mode'],
        'exclude', '#c62828',
        '#2e7d32',
      ],
      'line-width': 2,
    },
  });
  // Mode badge at each shape's label point so include/exclude is
  // legible without memorising the colours.
  map.addLayer({
    id: 'shape-filter-label',
    type: 'symbol',
    source: 'shape-filter',
    layout: {
      'text-field': [
        'match', ['get', 'mode'],
        'exclude', 'Exclude',
        'Include',
      ],
      'text-font': ['Open Sans Semibold'],
      'text-size': 12,
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': [
        'match', ['get', 'mode'],
        'exclude', '#8b1c1c',
        '#1d5a22',
      ],
      'text-halo-color': '#fff',
      'text-halo-width': 1.5,
    },
  });
  map.addLayer({
    id: 'shape-preview-line',
    type: 'line',
    source: 'shape-preview',
    paint: {
      'line-color': '#ff4d00',
      'line-width': 2,
      'line-dasharray': [3, 2],
    },
  });
}

function render() {
  const src = mapRef?.getSource('shape-filter');
  if (src) src.setData(shapesToFc(shapes));
}

function renderPreview(ring) {
  const src = mapRef?.getSource('shape-preview');
  if (!src) return;
  src.setData(ring && ring.length >= 2
    ? {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: ring },
        }],
      }
    : EMPTY_FC);
}

// ---------------------------------------------------------------------------
// Click routing for committed shapes
// ---------------------------------------------------------------------------

/**
 * Called by map.js's parcel click handler BEFORE opening a popup.
 * Returns true when the click belongs to this feature: either a tool
 * is armed (every click is placing geometry) or a committed shape sits
 * under the cursor, in which case its include/exclude mode flips.
 */
export function shapeClickHandled(map, point) {
  if (armed) return true;
  if (!map.getLayer('shape-filter-fill')) return false;
  const feats = map.queryRenderedFeatures(point, { layers: ['shape-filter-fill'] });
  if (feats.length === 0) return false;
  const id = feats[0].properties?.id;
  const s = shapes.find((x) => x.id === id);
  if (!s) return false;
  s.mode = s.mode === 'include' ? 'exclude' : 'include';
  render();
  emit();
  return true;
}

// ---------------------------------------------------------------------------
// Draw state machine
// ---------------------------------------------------------------------------

function setArmed(tool) {
  cancelPending();
  armed = armed === tool ? null : tool;
  document.body.classList.toggle('shape-drawing', armed != null);
  if (mapRef) {
    mapRef.getCanvas().style.cursor = armed ? 'crosshair' : '';
    // Double-click closes a polygon; without this it also zooms.
    if (armed === 'polygon') mapRef.doubleClickZoom.disable();
    else mapRef.doubleClickZoom.enable();
  }
  controlRef?.syncActive();
}

function cancelPending() {
  pending = null;
  renderPreview(null);
}

function commit(shape) {
  shapes.push({ id: nextId++, mode: 'include', ...shape });
  cancelPending();
  setArmed(null);
  render();
  emit();
}

function onMapClick(e) {
  if (!armed) return;
  const pt = { lng: e.lngLat.lng, lat: e.lngLat.lat };
  if (armed === 'circle') {
    if (!pending) {
      pending = { center: pt };
    } else {
      const radiusKm = haversineKm(pending.center, pt);
      if (radiusKm > 0) commit({ kind: 'circle', center: pending.center, radiusKm });
    }
  } else if (armed === 'rectangle') {
    if (!pending) {
      pending = { corner: pt };
    } else if (pt.lng !== pending.corner.lng || pt.lat !== pending.corner.lat) {
      commit({ kind: 'rectangle', ring: rectRing(pending.corner, pt) });
    }
  } else if (armed === 'polygon') {
    if (!pending) pending = { verts: [] };
    // Clicking the first vertex again closes the ring (12 px snap).
    if (pending.verts.length >= 3) {
      const firstPx = mapRef.project([pending.verts[0][0], pending.verts[0][1]]);
      const dx = firstPx.x - e.point.x;
      const dy = firstPx.y - e.point.y;
      if ((dx * dx + dy * dy) <= 144) {
        commit({ kind: 'polygon', ring: [...pending.verts] });
        return;
      }
    }
    pending.verts.push([pt.lng, pt.lat]);
  }
}

function onMapDblClick(e) {
  if (armed !== 'polygon' || !pending) return;
  e.preventDefault();
  // The dblclick was preceded by two click events that each pushed the
  // same end vertex — drop the duplicate before closing.
  const verts = pending.verts.slice(0, -1);
  if (verts.length >= 3) commit({ kind: 'polygon', ring: verts });
  else cancelPending();
}

function onMapMove(e) {
  if (!armed || !pending) return;
  const pt = { lng: e.lngLat.lng, lat: e.lngLat.lat };
  if (armed === 'circle' && pending.center) {
    renderPreview(circleRing(pending.center, Math.max(haversineKm(pending.center, pt), 0.005)));
  } else if (armed === 'rectangle' && pending.corner) {
    renderPreview(rectRing(pending.corner, pt));
  } else if (armed === 'polygon' && pending.verts.length > 0) {
    renderPreview([...pending.verts, [pt.lng, pt.lat]]);
  }
}

function onKeyDown(e) {
  if (e.key === 'Escape' && armed) setArmed(null);
}

// ---------------------------------------------------------------------------
// Toolbar control
// ---------------------------------------------------------------------------

const TOOLS = [
  { tool: 'circle',    label: '◯', title: 'Draw radius — click the centre, then click again to set the radius' },
  { tool: 'rectangle', label: '▭', title: 'Draw rectangle — click one corner, then the opposite corner' },
  { tool: 'polygon',   label: '⬠', title: 'Draw polygon — click vertices; double-click or click the first vertex to close' },
];

class ShapeDrawControl {
  onAdd(map) {
    mapRef = map;
    controlRef = this;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group shape-draw-control';
    this._btns = new Map();
    for (const { tool, label, title } of TOOLS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = `${title}. Click a finished shape to flip Include/Exclude; Esc cancels.`;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', () => setArmed(tool));
      this._container.appendChild(b);
      this._btns.set(tool, b);
    }
    const erase = document.createElement('button');
    erase.type = 'button';
    erase.textContent = '⌫';
    erase.title = 'Clear all drawn shapes';
    erase.setAttribute('aria-label', 'Clear all drawn shapes');
    erase.addEventListener('click', () => clearShapes());
    this._container.appendChild(erase);

    map.on('click', onMapClick);
    map.on('dblclick', onMapDblClick);
    map.on('mousemove', onMapMove);
    document.addEventListener('keydown', onKeyDown);
    return this._container;
  }
  onRemove() {
    document.removeEventListener('keydown', onKeyDown);
    this._container.remove();
  }
  syncActive() {
    for (const [tool, b] of this._btns) {
      b.classList.toggle('active', armed === tool);
    }
  }
}

export function createShapeDrawControl() {
  return new ShapeDrawControl();
}
