/*
 * Route Optimizer page (route.html).
 *
 * Browser port of the local Streamlit app in D:\Dropbox\ClaudeCode\route-optimizer:
 * paste a list of stops (rows from Excel, typed addresses or lat, lon),
 * geocode them with OpenStreetMap or the user's own Google key, get a
 * driving-time matrix, put the stops in the best order, and show / print
 * the route. Everything runs in the browser except the Google calls, which
 * go through api/route-google.js (Google's web services don't allow CORS).
 *
 * Settings, the Google key ("Remember" ticked) and the draft stop list are
 * kept in localStorage so they survive a reload.
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol as PMTilesProtocol } from 'pmtiles';
import { streetsStyle } from '../lib/basemapStyle.js';
import {
  parseStops, parseTable, csvRows, parseCoords, cleanAddress, streetMismatch, isApproximate, NUMBER_RE,
} from './parse.js';
import { geocode, matrix, routeGeometry, ProviderError } from './providers.js';
import { solve, pathCost, BIG } from './optimize.js';
import { renderPrintMap } from './printMap.js';
import { buildSheet, mapsLinks, fmtDur, routeCsv } from './sheet.js';

const MAX_POINTS = 98; // the OSRM demo server takes up to 100 coordinates per table request
const SETTINGS_KEY = 'routeOptimizer.settings.v1';
const DRAFT_KEY = 'routeOptimizer.draft.v1';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined));
  return e;
};

// ---------------------------------------------------------------- settings

function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: fine */ }
}

const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const setRadio = (name, value) => {
  const r = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (r) r.checked = true;
};

function restoreSettings() {
  const s = loadJson(SETTINGS_KEY);
  if (s.provider) setRadio('provider', s.provider);
  if (s.objective) setRadio('objective', s.objective);
  if (s.finish) setRadio('finish', s.finish);
  if (typeof s.country === 'string') $('country').value = s.country;
  if (typeof s.suffix === 'string') $('suffix').value = s.suffix;
  $('remember-key').checked = s.remember !== false;
  if (s.googleKey) $('google-key').value = s.googleKey;
  const d = loadJson(DRAFT_KEY);
  if (d.stops) $('stops').value = d.stops;
  if (d.start) $('start').value = d.start;
  if (d.end) $('end').value = d.end;
}

function saveSettings() {
  const remember = $('remember-key').checked;
  const key = $('google-key').value.trim();
  saveJson(SETTINGS_KEY, {
    provider: radio('provider'),
    objective: radio('objective'),
    finish: radio('finish'),
    country: $('country').value.trim(),
    suffix: $('suffix').value,
    remember,
    googleKey: remember && key ? key : undefined,
  });
  saveJson(DRAFT_KEY, { stops: $('stops').value, start: $('start').value, end: $('end').value });
}

function syncVisibility() {
  $('key-block').hidden = radio('provider') !== 'google';
  $('end-block').hidden = radio('finish') !== 'fixed';
}

// ---------------------------------------------------------------- status

function status(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}
class UserError extends Error {}
// Yield so the status text paints before the solver blocks the thread. A
// timer, not requestAnimationFrame: rAF never fires in a background tab.
const nextFrame = () => new Promise((r) => setTimeout(r, 30));

// ---------------------------------------------------------------- geocoding

const geoCache = new Map(); // provider|country|query -> result (this page load only)

async function geocodeCached(provider, q, country, key) {
  const k = `${provider}|${country}|${q}`;
  if (!geoCache.has(k)) geoCache.set(k, await geocode(provider, q, { country, key }));
  return geoCache.get(k);
}

/** Fill lat/lon/matched on each point in place; returns the ones not found. */
async function locate(points, provider, country, key, suffix) {
  const failures = [];
  const todo = points.filter((p) => !parseCoords(p.query)).length;
  let done = 0;
  for (const p of points) {
    const xy = parseCoords(p.query);
    if (xy) {
      Object.assign(p, { lat: xy[0], lon: xy[1], matched: '(coordinates given)', quality: 'exact', approx: false });
      continue;
    }
    let q = cleanAddress(p.query);
    if (suffix && !q.toLowerCase().includes(suffix.toLowerCase())) q = `${q}, ${suffix}`;
    done += 1;
    status(`Finding addresses ${done}/${todo}: ${p.query.slice(0, 60)}`);
    let res = await geocodeCached(provider, q, country, key);
    if (!res && NUMBER_RE.test(q)) res = await geocodeCached(provider, q.replace(NUMBER_RE, ''), country, key);
    if (res && streetMismatch(q, res.matched)) {
      p.near = res.matched;
      res = null;
    }
    if (!res) {
      failures.push(p);
    } else {
      Object.assign(p, res, { approx: isApproximate(provider, q, res) });
      if (p.approx) p.quality = 'approximate (street/area only)';
    }
  }
  return failures;
}

// ---------------------------------------------------------------- run

let result = null;

async function readFileStops() {
  const f = $('file').files?.[0];
  if (!f) return [];
  const rows = csvRows(await f.text());
  if (!rows.length) return [];
  return parseTable(rows[0], rows.slice(1));
}

async function optimize() {
  saveSettings();
  const provider = radio('provider');
  const key = $('google-key').value.trim();
  const country = $('country').value.trim().toLowerCase();
  const suffix = $('suffix').value.trim();
  const finish = radio('finish');
  const startQ = $('start').value.trim();
  const endQ = $('end').value.trim();

  let stops;
  try {
    stops = parseStops($('stops').value).concat(await readFileStops());
  } catch (err) {
    throw new UserError(`Couldn't read the stops: ${err.message}`);
  }
  if (!startQ && stops.length < 2) {
    throw new UserError('Enter a start location, or list at least two stops (the first one becomes the start).');
  }
  if (!stops.length) throw new UserError('Add at least one stop.');
  if (finish === 'fixed' && !endQ) throw new UserError('Enter a finish location, or pick another finish option.');
  if (provider === 'google' && !key) throw new UserError('Enter your Google API key in Settings, or switch to OpenStreetMap.');
  if (stops.length + 2 > MAX_POINTS) throw new UserError(`${stops.length} stops is too many; the limit is ${MAX_POINTS - 2}.`);

  const start = startQ ? { label: 'Start', query: startQ, notes: '', role: 'start' } : { ...stops.shift(), role: 'start' };
  let points = [start, ...stops.map((s) => ({ ...s, role: 'stop' }))];
  if (finish === 'fixed') points.push({ label: 'Finish', query: endQ, notes: '', role: 'end' });

  const failures = await locate(points, provider, country, key, suffix);
  const badEnds = failures.filter((p) => p.role !== 'stop');
  if (badEnds.length) {
    throw new UserError(`Couldn't find the ${badEnds.map((p) => `${p.role === 'start' ? 'start' : 'finish'} (${p.query})`).join(' or ')}. Fix the address or use lat, lon.`);
  }
  points = points.filter((p) => !failures.includes(p));
  if (!points.some((p) => p.role === 'stop')) throw new UserError('None of the stops could be found. Check the addresses or use lat, lon.');

  status('Getting driving times…');
  const { durations, distances } = await matrix(provider, points.map((p) => [p.lat, p.lon]), { key });
  const objective = radio('objective');
  const base = objective === 'time' ? durations : distances;
  const C = base.map((row) => row.map((v) => (v === null || v === undefined ? BIG : Number(v))));
  const n = points.length;
  const unreachable = points.filter((_, i) => i > 0 && C[0][i] >= BIG && C[i][0] >= BIG);
  if (unreachable.length) throw new UserError(`No driving route to: ${unreachable.map((p) => p.query).join('; ')}`);

  status('Optimizing stop order…');
  await nextFrame();
  const stopIdx = points.map((p, i) => (p.role === 'stop' ? i : -1)).filter((i) => i >= 0);
  const endIdx = finish === 'round' ? 0 : finish === 'fixed' ? n - 1 : null;
  const order = solve(C, 0, stopIdx, endIdx, { timeLimitMs: 3000 });
  const tail = endIdx === null ? [] : [endIdx];
  const seq = [0, ...order, ...tail];
  const orig = [0, ...stopIdx, ...tail];

  status('Drawing the route…');
  const geometry = await routeGeometry(provider, seq.map((i) => [points[i].lat, points[i].lon]), { key });
  result = {
    points, durations, distances, seq, geometry, provider, finish, objective, skipped: failures,
    origCost: pathCost(orig, C), optCost: pathCost(seq, C),
  };
  status('');
  renderResults();
}

// ---------------------------------------------------------------- results

/** One row per place in driving order, with leg and running totals. */
function routeRows(res) {
  const { points, durations, distances, seq, finish } = res;
  let cumT = 0;
  let cumD = 0;
  return seq.map((i, k) => {
    const p = points[i];
    let legT = 0;
    let legD = 0;
    if (k) {
      legT = durations[seq[k - 1]][i] || 0;
      legD = distances[seq[k - 1]][i] || 0;
    }
    cumT += legT;
    cumD += legD;
    let num;
    if (k === 0) num = 'S';
    else if (k === seq.length - 1 && finish === 'round') num = 'End';
    else if (k === seq.length - 1 && finish === 'fixed') num = 'F';
    else num = String(k);
    return { num, p, legT, legD, cumT, cumD, first: k === 0 };
  });
}

let map = null;
let markers = [];

function ensureMap() {
  if (map) return map;
  maplibregl.addProtocol('pmtiles', new PMTilesProtocol().tile);
  map = new maplibregl.Map({
    container: 'map',
    style: streetsStyle(),
    center: [-97.14, 49.9],
    zoom: 7,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  return map;
}

function drawMap(res, rows) {
  const m = ensureMap();
  const line = res.geometry || res.seq.map((i) => [res.points[i].lat, res.points[i].lon]);
  const fc = { type: 'Feature', geometry: { type: 'LineString', coordinates: line.map(([lat, lon]) => [lon, lat]) } };
  const apply = () => {
    if (m.getSource('route')) m.getSource('route').setData(fc);
    else {
      m.addSource('route', { type: 'geojson', data: fc });
      m.addLayer({ id: 'route-line', type: 'line', source: 'route', paint: { 'line-color': '#2563eb', 'line-width': 5, 'line-opacity': 0.75 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
    }
  };
  if (m.isStyleLoaded()) apply(); else m.once('load', apply);

  markers.forEach((mk) => mk.remove());
  markers = [];
  rows.forEach((r, k) => {
    if (r.num === 'End') return; // round trip: finish sits on the start
    const pin = el('div', { className: 'ro-pin', textContent: r.num, title: `${r.num}: ${r.p.label || r.p.query}` });
    pin.style.background = r.num === 'S' ? '#16a34a' : r.num === 'F' ? '#dc2626' : '#1e3a8a';
    pin.style.zIndex = String(1000 - k);
    markers.push(new maplibregl.Marker({ element: pin }).setLngLat([r.p.lon, r.p.lat]).addTo(m));
  });
  const lats = res.points.map((p) => p.lat);
  const lons = res.points.map((p) => p.lon);
  m.resize();
  m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 40, maxZoom: 16, duration: 0 });
}

function renderResults() {
  const res = result;
  const rows = routeRows(res);
  $('results').hidden = false;

  const alerts = $('alerts');
  alerts.replaceChildren();
  if (res.skipped.length) {
    alerts.append(el('div', { className: 'ro-alert bad' },
      el('strong', { textContent: `${res.skipped.length} stop(s) couldn't be found and are NOT in this route.` }),
      ' Fix the address or use lat, lon, then run again:',
      el('ul', {}, ...res.skipped.map((p) => el('li', {
        textContent: p.query + (p.notes ? ` (${p.notes})` : '')
          + (p.near ? ` — closest match was a different street: ${p.near.slice(0, 60)}` : ''),
      })))));
  }
  const approx = res.points.filter((p) => p.approx);
  if (approx.length) {
    // Collapsed: with OpenStreetMap this can be nearly every stop outside
    // Winnipeg, and the full list would push the map off the screen.
    alerts.append(el('details', { className: 'ro-alert warn' },
      el('summary', {
        textContent: `${approx.length} stop(s) matched only the street or area, not the house number (marked * below). `
          + 'They are routed to a point on that street. Show which',
      }),
      el('ul', {}, ...approx.map((p) => el('li', { textContent: `${p.query} → ${p.matched.slice(0, 70)}` })))));
  }

  const last = rows[rows.length - 1];
  const metric = (label, value) => el('div', { className: 'ro-metric' }, el('span', { textContent: label }), el('strong', { textContent: value }));
  const ms = [
    metric('Stops', String(res.points.filter((p) => p.role === 'stop').length)),
    metric('Driving time', fmtDur(last.cumT)),
    metric('Distance', `${(last.cumD / 1000).toFixed(1)} km`),
  ];
  if (res.origCost > 0 && res.origCost < BIG) {
    ms.push(metric('Saved vs. order entered', `${Math.round((1 - res.optCost / res.origCost) * 100)}%`));
  }
  $('metrics').replaceChildren(...ms);

  drawMap(res, rows);

  $('links').replaceChildren(...mapsLinks(rows.map((r) => r.p)).map(({ a, b, url }) => el('a', {
    href: url, target: '_blank', rel: 'noreferrer', textContent: `Stops ${rows[a].num} to ${rows[b].num}`,
  })));

  if (!$('sheet-title').value) {
    $('sheet-title').value = `Route - ${new Date().toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  const head = ['#', 'Stop', 'Notes', 'Matched', 'Leg', 'Leg km', 'Cumulative', 'Cum. km'];
  const table = $('table');
  table.replaceChildren(
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { textContent: h })))),
    el('tbody', {}, ...rows.map((r) => el('tr', {},
      el('td', { className: 'num', textContent: r.num }),
      el('td', { textContent: (r.p.label && !['Start', 'Finish'].includes(r.p.label) ? `${r.p.label} — ` : '') + r.p.query }),
      el('td', { textContent: r.p.notes || '' }),
      el('td', { className: r.p.approx ? 'approx' : '', textContent: (r.p.approx ? '* ' : '') + (r.p.matched || '') }),
      el('td', { textContent: r.first ? '' : fmtDur(r.legT) }),
      el('td', { textContent: r.first ? '' : (r.legD / 1000).toFixed(1) }),
      el('td', { textContent: fmtDur(r.cumT) }),
      el('td', { textContent: (r.cumD / 1000).toFixed(1) }),
    ))),
  );
  $('source-note').textContent = `Times from ${res.provider === 'google' ? 'Google Routes (no live traffic)' : 'OSRM / OpenStreetMap'}; they don't include time spent at each stop.`;
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- print / export

async function printSheet() {
  if (!result) return;
  const btn = $('print');
  btn.disabled = true;
  status('Drawing the print map…');
  try {
    const rows = routeRows(result);
    const markersForPrint = rows.filter((r) => r.num !== 'End').map((r) => ({
      lat: r.p.lat, lon: r.p.lon, text: r.num, kind: r.num === 'S' ? 'start' : r.num === 'F' ? 'end' : 'stop',
    }));
    const line = result.geometry || result.seq.map((i) => [result.points[i].lat, result.points[i].lon]);
    const img = await renderPrintMap({ line, markers: markersForPrint });
    buildSheet($('sheet'), { title: $('sheet-title').value.trim() || 'Route', rows, skipped: result.skipped, img });
    status('');
    await nextFrame();
    window.print();
  } catch (err) {
    console.error(err);
    status(`Couldn't build the print sheet: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function downloadCsv() {
  if (!result) return;
  const blob = new Blob([routeCsv(routeRows(result))], { type: 'text/csv' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'optimized-route.csv' });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------------------------------------------------------------- wiring

restoreSettings();
syncVisibility();
document.querySelectorAll('input[name="provider"], input[name="finish"]').forEach((r) => r.addEventListener('change', () => { syncVisibility(); saveSettings(); }));
['google-key', 'remember-key', 'country', 'suffix', 'stops', 'start', 'end'].forEach((id) => $(id).addEventListener('change', saveSettings));
document.querySelectorAll('input[name="objective"]').forEach((r) => r.addEventListener('change', saveSettings));
$('optimize').addEventListener('click', async () => {
  const btn = $('optimize');
  btn.disabled = true;
  try {
    await optimize();
  } catch (err) {
    if (!(err instanceof UserError || err instanceof ProviderError)) console.error(err);
    status(err.message, true);
  } finally {
    btn.disabled = false;
  }
});
$('print').addEventListener('click', printSheet);
$('csv').addEventListener('click', downloadCsv);
