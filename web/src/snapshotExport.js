/*
 * Parcel satellite-snapshot export.
 *
 * For each parcel in a result set, render a 1600×900 (16:9) satellite JPEG
 * with the subject parcel highlighted (the same yellow selection styling a
 * normal search produces), surrounding parcel lines + roll-number labels
 * from the muni fabric, the section/township (DLS) grid turned on, zoomed
 * to the tightest extent that fits the 16:9 frame with a margin. Roll-number
 * labels are scaled up (2×) since these snapshots are mostly of larger rural
 * parcels viewed at a further-out zoom. JPEG keeps each frame well under
 * 1 MB (see lib/imageOutput.js). The frames are bundled into one ZIP.
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
 * setSurveyGridData / Visible, setBasemapSatellite, and
 * fetchAllParcelsInMunicipality (cached).
 */

import bbox from '@turf/bbox';
import {
  initMap,
  showResults,
  setMuniParcelsData,
  setMuniParcelsVisible,
  setSurveyGridData,
  setSurveyGridVisible,
  setBasemapSatellite,
} from './map.js';
import { fetchAllParcelsInMunicipality } from './arcgis.js';
import { buildStoreZip } from './lib/zipStore.js';
import {
  OUTPUT_MIME,
  OUTPUT_QUALITY,
  OUTPUT_EXT,
  SNAPSHOT_W,
  SNAPSHOT_H,
} from './lib/imageOutput.js';

const EXPORT_W = SNAPSHOT_W;
const EXPORT_H = SNAPSHOT_H;
// fitBounds padding in CSS px — the margin so the parcel doesn't touch the
// frame edge. Generous (≈5%/9% of the 1920×1080 frame per side) so the
// surrounding parcel fabric and section grid stay visible around the
// subject — these snapshots are mostly larger rural parcels with context.
const FRAME_PADDING = 96;
// Roll-number labels (muni-parcels-label) are rendered at 2× their normal
// size on the export map. The snapshots are mostly 160-acre / larger rural
// parcels framed at a further-out zoom, where the base label ramp comes out
// too small to read in a saved image.
const ROLL_LABEL_SCALE = 2;
// Esri World Imagery tiles top out around z20; allow overzoom to this so
// tiny urban parcels still fill the frame (accepting some softness — see
// PARCEL_SNAPSHOTS_PLAN.md caveat). Rural/ag parcels rarely reach it.
const EXPORT_MAX_ZOOM = 20;
// Safety net so a stuck tile fetch can't hang the whole batch.
const IDLE_TIMEOUT_MS = 9000;

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

/**
 * Generate a ZIP of satellite snapshots, one per parcel.
 *
 * @param {{ type:'FeatureCollection', features: Array }} parcelFc
 * @param {Object} [opts]
 * @param {(p:{done:number,total:number,name:string}) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal] — abort to cancel mid-batch.
 * @param {(muniName:string)=>Promise} [opts.fetchMuniFabric] — injectable
 *   for tests; defaults to fetchAllParcelsInMunicipality.
 * @param {(muniName:string)=>Promise} [opts.fetchSurveyGrid] — returns the
 *   section/township grid FC for a muni (boundary lookup + survey-grid fetch
 *   live in main.js, which holds the boundaries FC). When omitted, or when it
 *   resolves null for a muni, that muni's snapshots simply have no grid.
 * @param {string} [opts.provenanceText] — when provided, written into the ZIP
 *   as PROVENANCE.txt so the image batch carries its own evidence record
 *   (when/which build/what sources/caveats). Excluded from `count`.
 * @returns {Promise<{ blob: Blob, count: number }>}
 */
export async function generateParcelSnapshotsZip(parcelFc, opts = {}) {
  const {
    onProgress,
    signal,
    fetchMuniFabric = fetchAllParcelsInMunicipality,
    fetchSurveyGrid,
    provenanceText,
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

  try {
    const created = initMap(container);
    map = created.map;
    await created.ready;
    map.resize();
    setBasemapSatellite(map, true);
    setMuniParcelsVisible(map, true);
    setSurveyGridVisible(map, true);
    scaleRollLabels(map, ROLL_LABEL_SCALE);

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

      // Section/township (DLS) grid for this muni. Replaces the previous
      // muni's grid each iteration; set empty when unavailable so a prior
      // muni's lines don't bleed into this one's frames.
      let grid = EMPTY_FC;
      if (fetchSurveyGrid && muniName) {
        try {
          grid = (await fetchSurveyGrid(muniName)) || EMPTY_FC;
        } catch (err) {
          console.warn(`Snapshot: section grid fetch failed for ${muniName} — grid omitted.`, err);
        }
      }
      setSurveyGridData(map, grid);

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
    const count = files.length;
    // Prepend the evidence record (not counted as a snapshot). Sorts to the
    // top of the archive and is the first thing the appraiser sees on unzip.
    if (provenanceText) {
      files.unshift({ name: 'PROVENANCE.txt', data: new TextEncoder().encode(provenanceText) });
    }
    return { blob: buildStoreZip(files), count };
  } finally {
    try { map?.remove(); } catch { /* ignore teardown errors */ }
    container.remove();
    window._map = prevDebugMap;
  }
}

// ---- label sizing ------------------------------------------------------

/**
 * Render the muni roll-number labels at `scale`× their normal size, on the
 * export map only. The base `muni-parcels-label` text-size is a zoom×acreage
 * `interpolate` expression (see map.js); wrapping it in a multiply leaves
 * that whole ramp intact and just scales the result, so it stays correct if
 * the base ramp is ever retuned. No-op when the layer or property is absent.
 */
function scaleRollLabels(map, scale) {
  const LAYER = 'muni-parcels-label';
  if (scale === 1 || !map.getLayer(LAYER)) return;
  const base = map.getLayoutProperty(LAYER, 'text-size');
  if (base == null) return;
  map.setLayoutProperty(LAYER, 'text-size', ['*', scale, base]);
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
 * Read the WebGL canvas, downscale to exactly EXPORT_W×EXPORT_H (the source
 * canvas is CSS-px × devicePixelRatio, so on a HiDPI screen it's larger —
 * the downscale supersamples for a crisp result), and burn the live
 * attribution credit into the corner — same compliance step the on-screen
 * "Generate Map" feature does. Encoded as JPEG (see lib/imageOutput.js).
 */
async function captureFrame(map, container) {
  const src = map.getCanvas();
  const out = document.createElement('canvas');
  out.width = EXPORT_W;
  out.height = EXPORT_H;
  const ctx = out.getContext('2d');
  // White backing: JPEG has no alpha, so any transparent edge pixel (e.g. a
  // tile that didn't load) would otherwise encode as black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, EXPORT_W, EXPORT_H);
  ctx.drawImage(src, 0, 0, EXPORT_W, EXPORT_H);
  drawAttribution(ctx, EXPORT_W, EXPORT_H, attributionText(container));
  return await new Promise((resolve) => out.toBlob(resolve, OUTPUT_MIME, OUTPUT_QUALITY));
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
 * `{muniCode}-{roll}.{ext}`. Muni code is the numeric prefix of the parcel's
 * `Municipality` field, which Roll_Entry stores as "187 - DE SALABERRY
 * (RM)". Roll trims the canonical trailing ".000" like the rest of the UI.
 *
 * Exported for unit testing.
 */
export function fileNameFor(feature) {
  const p = feature?.properties || {};
  const muniCode = muniCodeFromMunicipality(p.Municipality);
  const roll = humanRoll(p.Roll_No_Txt);
  return `${sanitizeSegment(muniCode)}-${sanitizeSegment(roll)}.${OUTPUT_EXT}`;
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
