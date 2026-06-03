/*
 * Parcel satellite-snapshot export.
 *
 * For each parcel in a result set, render a 1920×1080 (16:9) satellite PNG
 * with the subject parcel highlighted (the same yellow selection styling a
 * normal search produces), surrounding parcel lines + roll-number labels
 * from the muni fabric, zoomed to the tightest extent that fits the 16:9
 * frame with a small margin. The PNGs are bundled into one ZIP.
 *
 * Why a dedicated OFFSCREEN map instead of the visible one:
 *   - Output is forced to exactly 1920×1080 regardless of the user's
 *     window size — the visible canvas is whatever the browser is.
 *   - The user's on-screen view (zoom, basemap, overlays) is left
 *     untouched while a 25–150-parcel batch runs for a minute or two.
 *   - initMap() builds the full style (Esri satellite basemap + the
 *     highlight / muni-parcel / roll-label layers), so the snapshot looks
 *     identical to an on-screen search result with zero re-styling.
 *
 * All heavy lifting is reused from the existing app: initMap, showResults
 * (sets the 'parcels' highlight source), setMuniParcelsData / Visible,
 * setBasemapSatellite, and fetchAllParcelsInMunicipality (cached).
 */

import bbox from '@turf/bbox';
import {
  initMap,
  showResults,
  setMuniParcelsData,
  setMuniParcelsVisible,
  setBasemapSatellite,
} from './map.js';
import { fetchAllParcelsInMunicipality } from './arcgis.js';
import { buildStoreZip } from './lib/zipStore.js';

const EXPORT_W = 1920;
const EXPORT_H = 1080;
// fitBounds padding in CSS px — the "small margin" so the parcel doesn't
// touch the frame edge.
const FRAME_PADDING = 48;
// Esri World Imagery tiles top out around z20; allow overzoom to this so
// tiny urban parcels still fill the frame (accepting some softness — see
// PARCEL_SNAPSHOTS_PLAN.md caveat). Rural/ag parcels rarely reach it.
const EXPORT_MAX_ZOOM = 20;
// Safety net so a stuck tile fetch can't hang the whole batch.
const IDLE_TIMEOUT_MS = 9000;

/**
 * Generate a ZIP of satellite snapshots, one per parcel.
 *
 * @param {{ type:'FeatureCollection', features: Array }} parcelFc
 * @param {Object} [opts]
 * @param {(p:{done:number,total:number,name:string}) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal] — abort to cancel mid-batch.
 * @param {(muniName:string)=>Promise} [opts.fetchMuniFabric] — injectable
 *   for tests; defaults to fetchAllParcelsInMunicipality.
 * @returns {Promise<{ blob: Blob, count: number, skipped: number }>}
 */
export async function generateParcelSnapshotsZip(parcelFc, opts = {}) {
  const {
    onProgress,
    signal,
    fetchMuniFabric = fetchAllParcelsInMunicipality,
  } = opts;

  const features = (parcelFc?.features || []).filter((f) => f?.geometry);
  if (features.length === 0) {
    throw new Error('No parcels with geometry to snapshot.');
  }

  // Off-screen via fixed positioning (kept out of document flow so it can't
  // add scrollbars). NOT visibility:hidden / display:none — those can make
  // a browser skip compositing the WebGL canvas, which would read back
  // blank. Off-screen-but-rendered + preserveDrawingBuffer gives real bytes.
  const container = document.createElement('div');
  container.style.cssText =
    `position:fixed;left:-10000px;top:0;z-index:-1;width:${EXPORT_W}px;height:${EXPORT_H}px;` +
    'pointer-events:none;';
  document.body.appendChild(container);

  // initMap stamps window._map for debugging — preserve the visible map's
  // reference so we don't leave a dangling pointer to the removed export map.
  const prevDebugMap = window._map;

  let map = null;
  const files = [];
  const usedNames = new Map();
  let skipped = 0;

  try {
    const created = initMap(container);
    map = created.map;
    await created.ready;
    map.resize();
    setBasemapSatellite(map, true);
    setMuniParcelsVisible(map, true);

    // Group by muni name so each muni's fabric (surrounding parcel lines +
    // roll labels) is fetched and set once, then reused for every subject
    // parcel in that muni.
    const groups = new Map();
    for (const f of features) {
      const muniName = f.properties?.Muni_Name_With_Typ || '';
      if (!groups.has(muniName)) groups.set(muniName, []);
      groups.get(muniName).push(f);
    }

    const total = features.length;
    let done = 0;

    for (const [muniName, groupFeatures] of groups) {
      throwIfAborted(signal);
      let fabric = { type: 'FeatureCollection', features: [] };
      if (muniName) {
        try {
          fabric = (await fetchMuniFabric(muniName)) || fabric;
        } catch (err) {
          console.warn(`Snapshot: muni fabric fetch failed for ${muniName} — surrounding lines omitted.`, err);
        }
      }
      setMuniParcelsData(map, fabric);

      for (const feature of groupFeatures) {
        throwIfAborted(signal);
        // Push the single subject parcel onto the 'parcels' source — this
        // is the exact yellow selection styling a normal search produces.
        showResults(map, { type: 'FeatureCollection', features: [feature] }, { fit: false });
        fitParcelTo16by9(map, feature);
        await waitForIdle(map);

        const blob = await captureFrame(map, container);
        const data = new Uint8Array(await blob.arrayBuffer());
        const name = uniqueName(usedNames, fileNameFor(feature));
        files.push({ name, data });

        done += 1;
        onProgress?.({ done, total, name });
      }
    }

    if (files.length === 0) {
      throw new Error('No snapshots were captured.');
    }
    return { blob: buildStoreZip(files), count: files.length, skipped };
  } finally {
    try { map?.remove(); } catch { /* ignore teardown errors */ }
    container.remove();
    window._map = prevDebugMap;
  }
}

// ---- framing -----------------------------------------------------------

/**
 * Fit the camera to a single parcel's bbox. On a 16:9 canvas, fitBounds
 * already yields "the maximum extent that fits in a 16:9 window" — it
 * scales to whichever of width/height is the binding constraint and
 * centres the rest. FRAME_PADDING supplies the small margin.
 *
 * Exported for unit testing of the bbox/aspect math.
 */
export function fitParcelTo16by9(map, feature, padding = FRAME_PADDING) {
  const [minX, minY, maxX, maxY] = bbox(feature);
  map.fitBounds(
    [[minX, minY], [maxX, maxY]],
    { padding, maxZoom: EXPORT_MAX_ZOOM, duration: 0 },
  );
}

// ---- capture -----------------------------------------------------------

function waitForIdle(map) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      map.off('idle', onIdle);
      clearTimeout(timer);
      resolve();
    };
    const onIdle = () => finish();
    const timer = setTimeout(finish, IDLE_TIMEOUT_MS);
    map.on('idle', onIdle);
    // Force a render cycle so 'idle' fires even when the camera change was
    // a no-op (e.g. two same-muni parcels at the same scale).
    map.triggerRepaint();
  });
}

/**
 * Read the WebGL canvas, downscale to exactly 1920×1080 (the source canvas
 * is CSS-px × devicePixelRatio, so on a HiDPI screen it's larger), and
 * burn the live attribution credit into the corner — same compliance step
 * the on-screen "Generate Map" feature does.
 */
async function captureFrame(map, container) {
  const src = map.getCanvas();
  const out = document.createElement('canvas');
  out.width = EXPORT_W;
  out.height = EXPORT_H;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0, EXPORT_W, EXPORT_H);
  drawAttribution(ctx, EXPORT_W, EXPORT_H, attributionText(container));
  return await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
}

function attributionText(container) {
  const el = container.querySelector('.maplibregl-ctrl-attrib-inner') ||
             container.querySelector('.maplibregl-ctrl-attrib');
  const text = el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
  return text || 'Imagery © Esri';
}

/** Bottom-right semi-transparent credit pill (mirrors main.js's
 *  composeWithAttribution, self-contained so it can read the export
 *  container's own attribution control). */
function drawAttribution(ctx, w, h, text) {
  const fontSize = 13;
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  const maxWidth = Math.floor(w * 0.85);
  const lines = wrapToWidth(ctx, text, maxWidth);
  const padX = 8;
  const padY = 5;
  const lineHeight = Math.round(fontSize * 1.25);
  const blockH = lines.length * lineHeight + padY * 2 - (lineHeight - fontSize);
  let blockW = 0;
  for (const line of lines) blockW = Math.max(blockW, ctx.measureText(line).width);
  blockW = Math.ceil(blockW + padX * 2);
  const x0 = w - blockW - 6;
  const y0 = h - blockH - 6;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillRect(x0, y0, blockW, blockH);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, blockW - 1, blockH - 1);
  ctx.fillStyle = '#1a1a1a';
  for (let i = 0; i < lines.length; i++) {
    const yMid = y0 + padY + i * lineHeight + Math.round(fontSize / 2);
    ctx.fillText(lines[i], x0 + padX, yMid);
  }
}

function wrapToWidth(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ---- file naming -------------------------------------------------------

/**
 * `{muniCode}-{roll}.png`. Muni code is the numeric prefix of the parcel's
 * `Municipality` field, which Roll_Entry stores as "187 - DE SALABERRY
 * (RM)". Roll trims the canonical trailing ".000" like the rest of the UI.
 *
 * Exported for unit testing.
 */
export function fileNameFor(feature) {
  const p = feature?.properties || {};
  const muniCode = muniCodeFromMunicipality(p.Municipality);
  const roll = humanRoll(p.Roll_No_Txt);
  return `${sanitizeSegment(muniCode)}-${sanitizeSegment(roll)}.png`;
}

function muniCodeFromMunicipality(municipality) {
  if (!municipality) return 'NA';
  const code = String(municipality).split(' - ')[0].trim();
  return code || 'NA';
}

function humanRoll(roll) {
  const s = String(roll ?? '').trim();
  if (!s) return 'NA';
  return s.endsWith('.000') ? s.slice(0, -4) : s;
}

function sanitizeSegment(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'NA';
}

/** Disambiguate duplicate filenames by appending -2, -3, … before .png. */
function uniqueName(usedNames, name) {
  const count = usedNames.get(name) || 0;
  usedNames.set(name, count + 1);
  if (count === 0) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? '' : name.slice(dot);
  return `${stem}-${count + 1}${ext}`;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Snapshot export cancelled.', 'AbortError');
  }
}
