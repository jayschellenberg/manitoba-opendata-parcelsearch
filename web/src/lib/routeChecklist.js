/*
 * Printable route checklist: a full-page map, then one checklist page per
 * 25 stops (checkbox, #, address, notes, blank Time column for the photo
 * time). Pure logic — main.js supplies the Mapbox Static Images URL
 * builder and opens the returned HTML in its own tab for printing.
 *
 * The map is a plain Static Images basemap at a computed centre and
 * FRACTIONAL zoom, so the outermost stops sit just inside the printable
 * area whatever the route's shape; portrait or landscape is whichever
 * gives the bigger scale. Markers and the route line are drawn as an SVG
 * overlay in the same Web-Mercator pixel space, which keeps the Static
 * URL short (no polyline / pin overlays, no 99-pin label cap) and lets
 * stacked stops fan out instead of hiding each other.
 *
 * Modelled on the local route-optimizer's printsheet.py.
 */

// US Letter, inches.
const PAGE = { w: 8.5, h: 11 };
export const MARGIN_IN = 0.35;
const HEADER_IN = 0.45;     // title line above the map
const SLACK_IN = 0.15;      // browsers round sizes; without slack the map spills to page 2
export const ROWS_PER_PAGE = 25;

// Mapbox Static Images caps each side at 1280 px (before @2x).
const STATIC_MAX_PX = 1280;
// Mapbox GL tiles are 512 px: the world is 512·2^z px wide at zoom z.
const WORLD_PX = 512;
const MAX_ZOOM = 17;        // single-stop / tiny routes: street level, not rooftop
export const MARKER_R = 12; // marker radius in 1x map px (~0.09 in printed)
const EDGE = MARKER_R + 5;  // gap kept between the outermost marker and the image edge

/** Map-image box for each orientation: inches on paper and 1x pixels. */
export function mapBoxes() {
  const out = {};
  for (const orientation of ['portrait', 'landscape']) {
    const pw = orientation === 'portrait' ? PAGE.w : PAGE.h;
    const ph = orientation === 'portrait' ? PAGE.h : PAGE.w;
    const wIn = pw - 2 * MARGIN_IN;
    const hIn = ph - 2 * MARGIN_IN - HEADER_IN - SLACK_IN;
    const pxPerIn = STATIC_MAX_PX / Math.max(wIn, hIn);
    out[orientation] = {
      wIn, hIn, pxPerIn,
      width: Math.round(wIn * pxPerIn),
      height: Math.round(hIn * pxPerIn),
    };
  }
  return out;
}

/** Web-Mercator position in [0,1]² (x east, y south). */
export function mercator(lng, lat) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI),
  };
}

function inverseMercator(x, y) {
  const lng = x * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return { lng, lat };
}

/**
 * Choose orientation, centre and fractional zoom so every point fits
 * inside the image with EDGE px to spare.
 *
 * @param {Array<{lng:number,lat:number}>} points - the markers (start + stops).
 * @returns {{ orientation: 'portrait'|'landscape', width: number, height: number,
 *   center: {lng:number,lat:number}, zoom: number,
 *   project: (lng:number, lat:number) => {x:number, y:number} }}
 */
export function planMapView(points) {
  const world = points.map((p) => mercator(p.lng, p.lat));
  const xs = world.map((p) => p.x);
  const ys = world.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const bw = maxX - minX;
  const bh = maxY - minY;
  const maxScale = WORLD_PX * 2 ** MAX_ZOOM;

  const boxes = mapBoxes();
  const fit = (box) => Math.min(
    bw > 0 ? (box.width - 2 * EDGE) / bw : Infinity,
    bh > 0 ? (box.height - 2 * EDGE) / bh : Infinity,
    maxScale,
  );
  // Compare on paper (px per world unit ÷ px per inch), since the two
  // orientations have slightly different pixel densities.
  const orientation = fit(boxes.portrait) / boxes.portrait.pxPerIn >=
                      fit(boxes.landscape) / boxes.landscape.pxPerIn
    ? 'portrait' : 'landscape';
  const box = boxes[orientation];
  // Static Images takes zoom to 2 decimals; round DOWN so the fit holds.
  const zoom = Math.floor(Math.log2(fit(box) / WORLD_PX) * 100) / 100;
  const scale = WORLD_PX * 2 ** zoom;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const project = (lng, lat) => {
    const m = mercator(lng, lat);
    return { x: (m.x - cx) * scale + box.width / 2, y: (m.y - cy) * scale + box.height / 2 };
  };
  return {
    orientation,
    width: box.width,
    height: box.height,
    center: inverseMercator(cx, cy),
    zoom,
    project,
  };
}

/**
 * Fan out markers that would overlap, keeping each fanned group inside
 * the W×H frame. Port of printsheet.py's _spread.
 * @param {Array<{x:number,y:number}>} xy
 * @returns {Array<{x:number,y:number}>}
 */
export function spreadMarkers(xy, W, H, r = MARKER_R) {
  const out = xy.map((p) => ({ ...p }));
  const used = new Array(xy.length).fill(false);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  for (let i = 0; i < xy.length; i++) {
    if (used[i]) continue;
    const group = [];
    for (let j = i; j < xy.length; j++) {
      if (!used[j] && dist(xy[i], xy[j]) < 2 * r - 2) group.push(j);
    }
    group.forEach((j) => { used[j] = true; });
    if (group.length < 2) continue;
    const cx = group.reduce((a, j) => a + xy[j].x, 0) / group.length;
    const cy = group.reduce((a, j) => a + xy[j].y, 0) / group.length;
    const ring = (r * 1.15) / Math.sin(Math.PI / group.length);
    const fan = group.map((_, k) => {
      const a = -Math.PI / 2 + (2 * Math.PI * k) / group.length;
      return { x: cx + ring * Math.cos(a), y: cy + ring * Math.sin(a) };
    });
    const lo = r + 3;
    const fx = fan.map((p) => p.x);
    const fy = fan.map((p) => p.y);
    const dx = Math.max(lo - Math.min(...fx), 0) - Math.max(Math.max(...fx) - (W - lo), 0);
    const dy = Math.max(lo - Math.min(...fy), 0) - Math.max(Math.max(...fy) - (H - lo), 0);
    group.forEach((j, k) => { out[j] = { x: fan[k].x + dx, y: fan[k].y + dy }; });
  }
  return out;
}

/** Split rows into pages of at most `size`. */
export function chunkRows(rows, size = ROWS_PER_PAGE) {
  const pages = [];
  for (let i = 0; i < rows.length; i += size) pages.push(rows.slice(i, i + size));
  return pages.length ? pages : [[]];
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const MARKER_COLORS = { start: '#16a34a', stop: '#1e3a8a' };

/** SVG overlay: route line, leader lines for fanned markers, numbered circles. */
function overlaySvg(view, markers, line) {
  const { width: W, height: H, project } = view;
  const parts = [];
  if (line && line.length > 1) {
    // Drop vertices closer than half a pixel — a full-overview Directions
    // geometry has thousands, the print doesn't need them.
    const pts = [];
    let last = null;
    for (const [lng, lat] of line) {
      const p = project(lng, lat);
      if (last && Math.abs(p.x - last.x) < 0.5 && Math.abs(p.y - last.y) < 0.5) continue;
      pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
      last = p;
    }
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#2563eb" stroke-opacity="0.75" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  const trueXy = markers.map((m) => project(m.lng, m.lat));
  const shown = spreadMarkers(trueXy, W, H);
  trueXy.forEach((t, i) => {
    const s = shown[i];
    if (Math.abs(t.x - s.x) > 0.01 || Math.abs(t.y - s.y) > 0.01) {
      parts.push(`<line x1="${t.x.toFixed(1)}" y1="${t.y.toFixed(1)}" x2="${s.x.toFixed(1)}" y2="${s.y.toFixed(1)}" stroke="#282828" stroke-width="1.5"/>`);
      parts.push(`<circle cx="${t.x.toFixed(1)}" cy="${t.y.toFixed(1)}" r="2.5" fill="#282828"/>`);
    }
  });
  // Reverse so stop 1 lands on top of later stops.
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];
    const s = shown[i];
    const fs = m.text.length < 3 ? 12 : 9.5;
    parts.push(`<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${MARKER_R}" fill="${MARKER_COLORS[m.kind] || MARKER_COLORS.stop}" stroke="#fff" stroke-width="2.5"/>`);
    parts.push(`<text x="${s.x.toFixed(1)}" y="${s.y.toFixed(1)}" dy="0.36em" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${fs}" fill="#fff">${esc(m.text)}</text>`);
  }
  return `<svg class="overlay" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

function sheetCss() {
  const m = MARGIN_IN;
  return `
@page { size: letter portrait; margin: ${m}in; }
@page land { size: letter landscape; margin: ${m}in; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font: 10pt/1.3 Arial, Helvetica, sans-serif; color: #111; background: #e5e7eb; }
.sheet { background: #fff; margin: 16px auto; padding: ${m}in; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
.sheet.portrait { width: 8.5in; }
.sheet.landscape { width: 11in; }
.mappage.landscape { page: land; }
.sheet + .sheet { break-before: page; }
.head { height: ${HEADER_IN}in; display: flex; justify-content: space-between; align-items: baseline; gap: 12px; overflow: hidden; }
.head h1 { font-size: 14pt; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; outline: none; }
.head h1[contenteditable]:hover, .head h1[contenteditable]:focus { background: #fef9c3; }
.head .sum { font-size: 9pt; color: #444; white-space: nowrap; }
.mapwrap { position: relative; line-height: 0; border: 1px solid #94a3b8; }
.mapwrap img { display: block; width: 100%; height: 100%; filter: saturate(0.6); }
.mapwrap .overlay { position: absolute; inset: 0; width: 100%; height: 100%; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th { text-align: left; font-size: 8.5pt; color: #555; border-bottom: 2px solid #111; padding: 2px 5px; height: 0.26in; }
td { border-bottom: 1px solid #bbb; padding: 2px 5px; vertical-align: middle; height: 0.34in; }
tr { break-inside: avoid; }
.c-box { width: 0.32in; } .c-num { width: 0.4in; } .c-addr { width: 2.9in; } .c-time { width: 0.95in; }
.box { width: 14px; height: 14px; border: 2px solid #111; border-radius: 2px; display: block; }
.num { font-weight: 700; white-space: nowrap; font-size: 10.5pt; }
.clip { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.addr .clip { font-weight: 600; font-size: 9.5pt; line-height: 1.12; }
.notes .clip { color: #333; font-size: 8.5pt; line-height: 1.12; }
td.time { border-left: 1px solid #ddd; }
tr.start td { background: #f0fdf4; }
.foot { font-size: 8.5pt; color: #444; margin-top: 5px; }
.bar { text-align: center; margin: 12px; font: 10pt Arial, sans-serif; color: #444; }
.bar button { font: 600 12pt Arial, sans-serif; padding: 8px 22px; cursor: pointer; margin-right: 10px; }
@media print {
  body { background: none; }
  .sheet { margin: 0; padding: 0; box-shadow: none; width: auto; }
  .bar { display: none; }
}`;
}

/**
 * Build the standalone print document.
 *
 * @param {Object} o
 * @param {string} o.title
 * @param {string} o.summary            - "26 stops · 212 km · 3 h 05 min · one-way"
 * @param {ReturnType<planMapView>} o.view
 * @param {string} o.mapImageUrl        - Static Images URL for view (or '' for none)
 * @param {Array<{lng:number,lat:number,text:string,kind:'start'|'stop'}>} o.markers
 * @param {Array<[number,number]>} [o.line] - route geometry [lng,lat][]
 * @param {Array<{num:string, address:string, notes:string, approx?:boolean, start?:boolean}>} o.rows
 * @returns {string} full HTML document
 */
export function buildChecklistHtml({ title, summary, view, mapImageUrl, markers, line, rows }) {
  const pages = chunkRows(rows.filter((r) => !r.start));
  const startRow = rows.find((r) => r.start);
  const body = [];
  body.push('<div class="bar"><button id="print-btn" type="button">Print</button>Click the title to edit it before printing.</div>');

  // Map page. The wrapper's aspect ratio is fixed to the image's so the
  // overlay lines up even before the image has loaded.
  body.push(`<div class="sheet mappage ${view.orientation}">`);
  body.push(`<div class="head"><h1 class="title" contenteditable="true" spellcheck="false">${esc(title)}</h1><div class="sum">${esc(summary)}</div></div>`);
  body.push(`<div class="mapwrap" style="aspect-ratio: ${view.width} / ${view.height}">`);
  if (mapImageUrl) body.push(`<img src="${esc(mapImageUrl)}" alt="Route map" width="${view.width}" height="${view.height}">`);
  body.push(overlaySvg(view, markers, line));
  body.push('</div></div>');

  const total = rows.filter((r) => !r.start).length;
  pages.forEach((pageRows, p) => {
    const first = p * ROWS_PER_PAGE + 1;
    const last = first + pageRows.length - 1;
    const range = total ? `stops ${first}–${last} of ${total}` : 'no stops';
    body.push('<div class="sheet portrait checkpage">');
    body.push(`<div class="head"><h1 class="title">${esc(title)}</h1><div class="sum">${esc(range)}${pages.length > 1 ? ` · page ${p + 1} of ${pages.length}` : ''}</div></div>`);
    body.push('<table><colgroup><col class="c-box"><col class="c-num"><col class="c-addr"><col><col class="c-time"></colgroup>');
    body.push('<thead><tr><th></th><th>#</th><th>Address</th><th>Notes</th><th>Time</th></tr></thead><tbody>');
    const list = p === 0 && startRow ? [startRow, ...pageRows] : pageRows;
    for (const r of list) {
      body.push(
        `<tr${r.start ? ' class="start"' : ''}><td><span class="box"></span></td><td class="num">${esc(r.num)}</td>` +
        `<td class="addr"><div class="clip">${esc(r.address)}${r.approx ? ' *' : ''}</div></td>` +
        `<td class="notes"><div class="clip">${esc(r.notes)}</div></td><td class="time"></td></tr>`,
      );
    }
    body.push('</tbody></table>');
    if (p === pages.length - 1 && rows.some((r) => r.approx)) {
      body.push('<div class="foot">* Approximate location: not on the parcel map yet, pinned near where it should be.</div>');
    }
    body.push('</div>');
  });

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<style>${sheetCss()}</style></head><body>${body.join('')}</body></html>`;
}
