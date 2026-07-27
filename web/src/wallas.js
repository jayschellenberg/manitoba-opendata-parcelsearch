// WALLAS client — Manitoba Water Allocation Licensing and Lands
// Administration System.
//
// Source: the same ArcGIS MapServer that backs the province's public
// Water Licensing Portal (the Geocortex viewer at
// web43.gov.mb.ca/Html5Viewer/Index.html?viewer=wallasExt.wallas).
// The viewer is just a front-end; the REST service underneath is public,
// supports Query, speaks GeoJSON, and — unlike the Contaminated Sites
// CSV — sends CORS headers (origin-reflected, `Vary: Origin`). So this
// fetches straight from the browser with no /proxy/ rewrite needed.
//
// What we surface, and why:
//
//   Tile drainage (layer 7, CONTROL_WORKS_TYPE='Tile Drainage')
//     Polygons of the licensed tiled area — the field footprint, not the
//     pipe. ~1,580 licensed province-wide, so we pull the whole layer
//     once and cache it. That also sidesteps the fact that layer 7 has
//     no LOCAL_GOVERNMENT column (see MUNI SCOPING below), and gives the
//     results-grid column + search filter a province-wide set to join
//     against without a second round-trip.
//
//   Tile network (layers 6 + 5, same CONTROL_WORKS_TYPE filter)
//     The actual lateral/header runs and their outlets. 85k lines
//     province-wide — far too much to bundle — so these are fetched for
//     the current map viewport only, gated on zoom. That mirrors the
//     upstream service, which sets minScale 100000/60000 on these layers
//     precisely because they're meaningless zoomed out.
//
//   Irrigation (layers 2 + 3, USAGE_CATEGORY='Irrigation')
//     Point of Diversion = where water is taken from; Point of Use =
//     where it's applied. Both are polygons (legal-location footprints,
//     not points, despite the layer names). ~6k licensed across both.
//
// LICENSED ONLY: every query here filters APPLICATION_STATUS to the four
// values that mean works were actually authorized. The layer also carries
// 'Application Rejected' and 'No Further Action' rows, which would badly
// mislead an appraiser reading the map as "this land is tiled".
//
// MUNI SCOPING: layer 7 has no LOCAL_GOVERNMENT field (layer 8, the
// application tracker, does). Any muni narrowing therefore has to be
// spatial. Since the whole licensed tile layer is only ~1,580 polygons,
// we don't bother — we fetch it all and let the caller clip.
//
// KNOWN LIMITS, worth repeating wherever this data is surfaced:
//   - Layer 7's newest APPLICATION_DATE is 2024-08-29 while the tracking
//     layer runs to the present, so the polygon geometry lags. A parcel
//     with no tile polygon is NOT proof of no tile drainage.
//   - Licensed works only. Older or unlicensed tile never appears.
//   - The TILE_* detail fields are sparsely populated — only 129 of 1,633
//     tile polygons carry TILE_AREA.
//   - Polygons describe the area applied for. LEGACY_LABEL distinguishes
//     "Area of Proposed Tile Drainage Network" from "Area of Tile
//     Drainage Network", but the field is often null, so treat every
//     footprint as approximate.

import { readCache, writeCache } from './cache.js';

const WALLAS_BASE =
  'https://web43.gov.mb.ca/arcgis/rest/services/WALLAS/wallas_op_external/MapServer';

// Layer ids on the MapServer. Named rather than inlined because the
// numbers carry no meaning at the call site.
const LAYER = {
  POINT_OF_DIVERSION: 2,
  POINT_OF_USE: 3,
  WCW_POINTS: 5,
  WCW_LINES: 6,
  WCW_POLYGONS: 7,
};

/** Citable endpoints for evidence-export provenance (lib/provenance.js),
 *  matching the SERVICE_SOURCES shape arcgis.js exports. */
export const WALLAS_SOURCES = [
  { label: 'Tile Drainage (Water Control Works)', url: `${WALLAS_BASE}/${LAYER.WCW_POLYGONS}` },
  { label: 'Water Use — Point of Diversion',      url: `${WALLAS_BASE}/${LAYER.POINT_OF_DIVERSION}` },
  { label: 'Water Use — Point of Use',            url: `${WALLAS_BASE}/${LAYER.POINT_OF_USE}` },
];

/** The four APPLICATION_STATUS values that mean the works were licensed.
 *  Everything else in the layer is a rejected or abandoned application. */
const LICENSED_STATUSES = [
  'Approved Licence Issued',
  'Licence Renewed',
  'Licence Replaced',
  'Certificate Issued',
];

const LICENSED_CLAUSE = `APPLICATION_STATUS IN (${LICENSED_STATUSES.map((s) => `'${s}'`).join(',')})`;
const TILE_CLAUSE = `CONTROL_WORKS_TYPE = 'Tile Drainage' AND ${LICENSED_CLAUSE}`;

// MapServer 10.51 reports maxRecordCount 1000 and supportsPagination.
const PAGE_SIZE = 1000;
// Province-wide safety cap. The licensed tile layer is ~1,580 and
// irrigation ~6,000; this only exists so an upstream schema change can't
// spin us into an unbounded paging loop.
const MAX_FEATURES = 40000;
// Viewport fetches for the dense line layer. 85k tile lines exist
// province-wide, but a single zoomed-in view is a few hundred at most.
const VIEWPORT_MAX_FEATURES = 6000;

// Water-rights licensing moves on a licence-application cadence — new
// records land over weeks, not minutes — and the polygon layer is
// visibly a year or more behind regardless. A week matches the TTL the
// zoning + dev-plan overlays already use.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TILE_OUTFIELDS = [
  'OBJECTID', 'LICENCE_NO', 'FILE_NO', 'APPLICATION_STATUS', 'APPLICATION_DATE',
  'CLIENT_NAME', 'CONTROL_WORKS_TYPE', 'TILE_AREA', 'TILE_DEPTH',
  'TILE_SPACING_OF_LATERAL_PIPE', 'TILE_DIAMETER_OF_LATERAL_PIPE',
  'TILE_OUTLET_TYPE', 'ENGINEERING_CONSULTANT_NAME', 'LEGACY_LABEL',
].join(',');

// Lines and outlets are drawn, clicked, and thrown away — they never feed
// a column — so they carry only what the popup shows.
const TILE_NETWORK_OUTFIELDS = 'OBJECTID,LICENCE_NO,APPLICATION_STATUS,CLIENT_NAME';

const IRRIGATION_OUTFIELDS = [
  'OBJECTID', 'LICENCE_NO', 'CLIENT_NAME', 'APPLICATION_STATUS', 'APPLICATION_DATE',
  'USAGE_CATEGORY', 'SUB_PROGRAM', 'PROJECT_TYPE', 'WATER_SOURCE_NAME',
  'ACQUIFER_NAME', 'FULL_LOCATION', 'LOCAL_GOVERNMENT',
].join(',');

// ---------- Public API ----------

/**
 * Every licensed tile-drainage area in the province, as GeoJSON polygons
 * in EPSG:4326. Cached for a week; a cold fetch is two pages (~1.3 MB,
 * ~235 KB on the wire gzipped).
 *
 * Returns an empty FeatureCollection rather than throwing when the
 * service is unreachable — a water overlay is supplementary, and the rest
 * of the app must keep working without it. Callers that need to
 * distinguish "no data here" from "fetch failed" should check `_failed`.
 */
export async function fetchTileDrainageAreas() {
  const cacheKey = 'mb_wallas_tile_areas_v1';
  const cached = await readCache(cacheKey, CACHE_TTL_MS);
  if (cached?.features?.length) return cached;
  try {
    const fc = await fetchAllPages(LAYER.WCW_POLYGONS, {
      where: TILE_CLAUSE,
      outFields: TILE_OUTFIELDS,
    }, MAX_FEATURES);
    // Only a non-empty result is worth remembering — same reasoning as
    // arcgis.js's overlay cache: an empty response is ambiguous between
    // "genuinely none" and "the service hiccuped", and pinning that for a
    // week would leave the Tile column blank with no way to tell why.
    if (fc.features.length) await writeCache(cacheKey, fc);
    return fc;
  } catch (err) {
    console.warn('WALLAS tile-drainage fetch failed', err);
    return emptyFc({ failed: true });
  }
}

/**
 * Licensed irrigation licences — Point of Diversion and Point of Use
 * merged into one collection, each feature tagged `_wallasKind` with
 * 'diversion' or 'use' so the map can style and label them apart.
 *
 * Both layers are polygons despite the "Point of ..." naming: the
 * geometry is the legal-location footprint the licence attaches to.
 */
export async function fetchIrrigationLicences() {
  const cacheKey = 'mb_wallas_irrigation_v1';
  const cached = await readCache(cacheKey, CACHE_TTL_MS);
  if (cached?.features?.length) return cached;
  const where = `USAGE_CATEGORY = 'Irrigation' AND ${LICENSED_CLAUSE}`;
  try {
    const [diversion, use] = await Promise.all([
      fetchAllPages(LAYER.POINT_OF_DIVERSION, { where, outFields: IRRIGATION_OUTFIELDS }, MAX_FEATURES),
      fetchAllPages(LAYER.POINT_OF_USE,       { where, outFields: IRRIGATION_OUTFIELDS }, MAX_FEATURES),
    ]);
    const features = [
      ...tagKind(diversion.features, 'diversion'),
      ...tagKind(use.features, 'use'),
    ];
    const fc = { type: 'FeatureCollection', features };
    if (features.length) await writeCache(cacheKey, fc);
    return fc;
  } catch (err) {
    console.warn('WALLAS irrigation fetch failed', err);
    return emptyFc({ failed: true });
  }
}

/**
 * Tile lateral/header lines and their outlet points for one map viewport.
 *
 * Not cached: the key would be a continuous bbox, so hit rate would be
 * near zero while the entries pile up. Each call is small (a zoomed-in
 * view is a few hundred features) and the caller debounces on map idle.
 *
 * `bbox` is [west, south, east, north] in EPSG:4326. Returns
 * `{ lines, outlets }`, each a FeatureCollection — empty on failure, so a
 * pan into a dead spot or a flaky response just draws nothing.
 */
export async function fetchTileNetwork(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) {
    return { lines: emptyFc(), outlets: emptyFc() };
  }
  const spatial = {
    geometry: bbox.join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
  };
  try {
    const [lines, outlets] = await Promise.all([
      fetchAllPages(LAYER.WCW_LINES,  { where: TILE_CLAUSE, outFields: TILE_NETWORK_OUTFIELDS, ...spatial }, VIEWPORT_MAX_FEATURES),
      fetchAllPages(LAYER.WCW_POINTS, { where: TILE_CLAUSE, outFields: TILE_NETWORK_OUTFIELDS, ...spatial }, VIEWPORT_MAX_FEATURES),
    ]);
    return { lines, outlets };
  } catch (err) {
    console.warn('WALLAS tile-network fetch failed', err);
    return { lines: emptyFc({ failed: true }), outlets: emptyFc({ failed: true }) };
  }
}

// ---------- Internals ----------

function emptyFc({ failed = false } = {}) {
  return { type: 'FeatureCollection', features: [], _failed: failed };
}

function tagKind(features, kind) {
  for (const f of features) {
    if (f.properties) f.properties._wallasKind = kind;
  }
  return features;
}

/**
 * Page through a WALLAS layer until the result set is exhausted or `cap`
 * is reached.
 *
 * orderByFields is mandatory, not optional: ArcGIS gives no stable row
 * order across resultOffset pages without it, so pages can silently
 * overlap or skip. arcgis.js's fetchAllPages learned the same lesson.
 */
async function fetchAllPages(layerId, params, cap) {
  const all = [];
  for (let offset = 0; offset < cap; offset += PAGE_SIZE) {
    const page = Math.min(PAGE_SIZE, cap - offset);
    const fc = await fetchPage(layerId, {
      ...params,
      orderByFields: 'OBJECTID ASC',
      resultOffset: String(offset),
      resultRecordCount: String(page),
    });
    const feats = fc.features || [];
    all.push(...feats);
    // Short page means we've reached the end. A full page might or might
    // not have more behind it, so we trust exceededTransferLimit when the
    // service sets it and otherwise loop once more to find out.
    if (feats.length < page) break;
    if (fc.exceededTransferLimit === false) break;
  }
  return { type: 'FeatureCollection', features: all.map(normalizeFeature) };
}

async function fetchPage(layerId, params) {
  const body = new URLSearchParams({
    returnGeometry: 'true',
    outSR: '4326',
    // ~0.1 m at Manitoba's latitude. Far finer than the survey accuracy
    // of a drainage application, and it roughly halves the payload
    // against the service's default full float precision.
    geometryPrecision: '6',
    f: 'geojson',
    ...params,
  });
  // POST unconditionally: the tile WHERE clause plus an envelope pushes
  // some of these past the URL-length limits proxies impose, and POST is
  // valid for every ArcGIS query regardless of size.
  const res = await fetch(`${WALLAS_BASE}/${layerId}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    // The service sets a session cookie and answers with
    // Access-Control-Allow-Credentials. We want neither — omitting
    // credentials keeps this a plain anonymous read.
    credentials: 'omit',
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`WALLAS layer ${layerId} returned HTTP ${res.status}`);
  const json = await res.json();
  // ArcGIS reports query errors as HTTP 200 with an `error` body.
  if (json.error) {
    throw new Error(`WALLAS layer ${layerId}: ${json.error.message || 'query failed'}`);
  }
  return json;
}

/**
 * Trim and normalize one feature's attributes in place.
 *
 * WALLAS pads its fixed-width character columns hard — LICENCE_NO comes
 * back as a 12-character number followed by ~240 spaces, and LEAD_AGENT
 * is similar. Left alone that padding breaks equality checks and string
 * comparisons, bloats the cached payload several times over, and renders
 * as a run of whitespace in popups.
 *
 * Epoch-millisecond dates become 'YYYY-MM-DD' here so every consumer
 * (popup, grid cell, CSV) formats them the same way. Read as UTC
 * deliberately: these are calendar dates with no meaningful time, and
 * local-time parsing would shift some of them a day backwards.
 */
function normalizeFeature(feature) {
  const p = feature?.properties;
  if (!p) return feature;
  for (const [key, value] of Object.entries(p)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      p[key] = trimmed === '' ? null : trimmed;
    }
  }
  if (Number.isFinite(p.APPLICATION_DATE)) {
    p.APPLICATION_DATE = new Date(p.APPLICATION_DATE).toISOString().slice(0, 10);
  }
  return feature;
}
