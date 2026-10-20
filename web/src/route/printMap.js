/*
 * Print map for the Route Optimizer sheet.
 *
 * Renders the site's own basemap (lib/basemapStyle.js) in an off-screen
 * MapLibre map sized to the printable area of a US Letter page, fits the
 * view to the STOPS (fractional zoom, so the outermost stops sit just inside
 * the edge), then draws the route line and numbered markers on a 2D canvas
 * on top. Portrait or landscape is picked per route, whichever gives the
 * bigger map. Port of printsheet.py's render_map from the local app.
 */

import maplibregl from 'maplibre-gl';
import { streetsStyle } from '../lib/basemapStyle.js';
import { spreadMarkers } from './markerSpread.js';

export const PAGE = { margin: 0.4, header: 0.45, slack: 0.15 }; // inches
const CSS_PX_PER_IN = 96;
const RATIO = 2;          // device pixels per CSS pixel (about 190 dpi on paper)
const R = 12;             // marker radius, CSS px
const EDGE = R + 5;       // gap kept between the outermost marker and the edge
const COLORS = { start: '#16a34a', end: '#dc2626', stop: '#1e3a8a' };

/** Map area for a Letter page, in inches. */
export function mapSizeIn(orientation) {
  const pw = orientation === 'portrait' ? 8.5 : 11;
  const ph = orientation === 'portrait' ? 11 : 8.5;
  return {
    w: pw - 2 * PAGE.margin,
    h: ph - 2 * PAGE.margin - PAGE.header - PAGE.slack,
  };
}

function mercator(lat, lon) {
  const c = maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat });
  return [c.x, c.y];
}

/** 'portrait' or 'landscape', whichever lets the stops be drawn larger. */
export function pickOrientation(points) {
  const xy = points.map(([lat, lon]) => mercator(lat, lon));
  const bw = Math.max(...xy.map((p) => p[0])) - Math.min(...xy.map((p) => p[0]));
  const bh = Math.max(...xy.map((p) => p[1])) - Math.min(...xy.map((p) => p[1]));
  const scale = (o) => {
    const { w, h } = mapSizeIn(o);
    const W = w * CSS_PX_PER_IN - 2 * EDGE;
    const H = h * CSS_PX_PER_IN - 2 * EDGE;
    return Math.min(bw > 0 ? W / bw : Infinity, bh > 0 ? H / bh : Infinity);
  };
  return scale('landscape') >= scale('portrait') ? 'landscape' : 'portrait';
}

function waitIdle(map, ms = 20000) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms); // draw whatever loaded rather than hang
    map.once('idle', () => { clearTimeout(t); resolve(); });
  });
}

/**
 * @param {{line: number[][], markers: {lat:number, lon:number, text:string, kind:'start'|'stop'|'end'}[]}} args
 * @returns {Promise<{dataUrl: string, orientation: string, widthIn: number, heightIn: number}>}
 */
export async function renderPrintMap({ line, markers }) {
  const pts = markers.map((m) => [m.lat, m.lon]);
  const orientation = pickOrientation(pts.length > 1 ? pts : pts.concat(line));
  const { w, h } = mapSizeIn(orientation);
  const W = Math.round(w * CSS_PX_PER_IN);
  const H = Math.round(h * CSS_PX_PER_IN);

  const box = document.createElement('div');
  box.style.cssText = `position:fixed;left:-30000px;top:0;width:${W}px;height:${H}px;`;
  document.body.appendChild(box);
  const lats = pts.map((p) => p[0]);
  const lons = pts.map((p) => p[1]);
  const map = new maplibregl.Map({
    container: box,
    style: streetsStyle(),
    preserveDrawingBuffer: true,
    interactive: false,
    attributionControl: false,
    pixelRatio: RATIO,
    fadeDuration: 0,
    bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    fitBoundsOptions: { padding: EDGE, maxZoom: 17 },
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the map took too long to load')), 30000);
      map.once('load', () => { clearTimeout(t); resolve(); });
      map.once('error', (e) => { if (!map.loaded()) { clearTimeout(t); reject(e.error || e); } });
    });
    await waitIdle(map);

    const canvas = document.createElement('canvas');
    canvas.width = W * RATIO;
    canvas.height = H * RATIO;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(map.getCanvas(), 0, 0, canvas.width, canvas.height);
    ctx.scale(RATIO, RATIO);
    // mute the basemap slightly so the route stands out on paper
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(0, 0, W, H);

    const project = ([lat, lon]) => {
      const p = map.project([lon, lat]);
      return [p.x, p.y];
    };
    if (line.length > 1) {
      ctx.beginPath();
      line.map(project).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = 'rgba(37,99,235,0.8)';
      ctx.lineWidth = 3.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    const trueXY = pts.map(project);
    const shown = spreadMarkers(trueXY, W, H, R);
    ctx.strokeStyle = '#333';
    ctx.fillStyle = '#333';
    ctx.lineWidth = 1.2;
    trueXY.forEach(([tx, ty], i) => {
      const [mx, my] = shown[i];
      if (tx === mx && ty === my) return;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(mx, my); ctx.stroke();
      ctx.beginPath(); ctx.arc(tx, ty, 2, 0, Math.PI * 2); ctx.fill();
    });
    // reverse so stop 1 ends up on top of later stops
    for (let i = markers.length - 1; i >= 0; i--) {
      const m = markers[i];
      const [x, y] = shown[i];
      ctx.beginPath();
      ctx.arc(x, y, R, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[m.kind];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${m.text.length < 3 ? 11 : 9}px Arial, Helvetica, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.text, x, y + 0.5);
    }
    ctx.font = '8px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(W - 168, H - 12, 168, 12);
    ctx.fillStyle = '#444';
    ctx.fillText('© OpenStreetMap contributors · Protomaps', W - 4, H - 2);
    return { dataUrl: canvas.toDataURL('image/png'), orientation, widthIn: w, heightIn: h };
  } finally {
    map.remove();
    box.remove();
  }
}
