// Area location maps — the provincial RM maps (2017 municipal series) and
// the town / village / unincorporated community plans, as further base maps
// for lib/locationMap.js, alongside the highway-map city pages in
// cityMaps.js. The Addenda Pack adds them automatically (Jason, 2026-10-21):
//   - the RM map when the subject is in that municipality;
//   - the community plan when the subject is on one of its sheets.
//
// ~620 sheets (~180 MB) are far too much for the Vercel build, so the pages
// and their index live on R2 (tools/city-location-maps/build_area.py,
// README.md). The index is fetched only when a pack or the panel needs it.
// Pages are fetched to blob: URLs before drawing, because locationMap.js
// (shared with the Winnipeg app) loads base maps without crossOrigin and a
// cross-origin image would taint the canvas.
//
// Each sheet carries a UTM 14N -> page affine fitted to the section grid
// (RM maps) or to the assessment-parcel fabric (community plans).

import { BASE_MAPS, utm14 } from './locationMap.js';

export const AREA_MAPS_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_AREA_MAPS_BASE)
  || 'https://pub-091058079bf6458da1681945177e1682.r2.dev/location-maps/';

/** Same output size and unit width as the city maps (cityMaps.js), so the
 *  SUBJECT box reads the same size on every figure. */
const TARGET_PX = 1500;
const UNIT_WIDTH = 380;

/** Build a base map from one index entry:
 *  { id, kind: 'rm' | 'community', label, muni, file, width, height,
 *    affine: [a, b, c, d, e, f], obstacles: [[x0, y0, x1, y1], ...] }
 *  in the sheet's own units (page points or scan pixels). */
export function areaMap(entry, base = AREA_MAPS_BASE) {
  const [a, b, c, d, e, f] = entry.affine;
  const k = UNIT_WIDTH / entry.width;
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    muni: entry.muni,
    assetUrl: base + entry.file,
    svgUrl: null,                 // a blob: URL once prepareAreaMap() has run
    width: UNIT_WIDTH,
    height: entry.height * k,
    scale: TARGET_PX / UNIT_WIDTH,
    project(lng, lat) {
      const [E, N] = utm14(lng, lat);
      return [k * (a * E + b * N + c), k * (d * E + e * N + f)];
    },
    obstacles: (entry.obstacles || []).map((box) => box.map((v) => v * k)),
  };
}

let indexPromise = null;
/** The area-map index, fetched once per page. Resolves to [] on failure, so
 *  a missing index only drops these maps, never the pack. */
export function loadAreaMaps(fetchFn = globalThis.fetch, base = AREA_MAPS_BASE) {
  if (!indexPromise) {
    indexPromise = fetchFn(base + 'index.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`index ${r.status}`))))
      .then((idx) => (idx.maps || []).map((e) => areaMap(e, base)))
      .catch((err) => { indexPromise = null; console.warn('area maps unavailable:', err); return []; });
  }
  return indexPromise;
}

/** Fetch a sheet to a blob: URL (same-origin, so the canvas stays
 *  exportable) and register it for locationMap.js. */
export async function prepareAreaMap(map, fetchFn = globalThis.fetch) {
  if (!map.svgUrl) {
    const r = await fetchFn(map.assetUrl);
    if (!r.ok) throw new Error(`could not load ${map.assetUrl} (${r.status})`);
    map.svgUrl = URL.createObjectURL(await r.blob());
  }
  if (!BASE_MAPS[map.id]) BASE_MAPS[map.id] = map;
  return map;
}

/** How far inside the page a subject must be, as a share of each side, for
 *  a sheet to count as showing it (the edges carry title and margins). */
const INSET = 0.04;

function inside(map, lng, lat) {
  const [x, y] = map.project(lng, lat);
  const mx = map.width * INSET, my = map.height * INSET;
  return x > mx && y > my && x < map.width - mx && y < map.height - my ? [x, y] : null;
}

/** The sheet of `kind` that best shows the point: on the page, nearest the
 *  page centre. `muni` (MUNI_LIST_NAME_WITH_TYPE) narrows RM maps to the
 *  subject's own municipality. */
export function pickAreaMap(maps, kind, lng, lat, muni = null) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const want = muni && String(muni).trim().toUpperCase();
  let best = null;
  for (const m of maps) {
    if (m.kind !== kind || (want && kind === 'rm' && m.muni !== want)) continue;
    const p = inside(m, lng, lat);
    if (!p) continue;
    const off = Math.hypot(p[0] / m.width - 0.5, p[1] / m.height - 0.5);
    if (!best || off < best.off) best = { off, m };
  }
  return best ? best.m : null;
}
