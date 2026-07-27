// WALLAS client (src/wallas.js) — query construction, paging, and the
// attribute normalisation the live service makes necessary.
//
// Everything here runs against a stubbed fetch. The shapes it returns are
// copied from real responses off
// web43.gov.mb.ca/arcgis/rest/services/WALLAS/wallas_op_external — in
// particular the ~250-character space padding on LICENCE_NO, which is
// what the trimming exists for.

import assert from 'node:assert/strict';

function makeFakeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}
// cache.js prefers IndexedDB and falls back to localStorage; Node has no
// IDB, so the fallback path is what gets exercised.
globalThis.localStorage = makeFakeStorage();
globalThis.sessionStorage = makeFakeStorage();

const calls = [];
let handler = () => ({ type: 'FeatureCollection', features: [] });

globalThis.fetch = async (url, options = {}) => {
  const params = new URLSearchParams(options.body || '');
  const call = { url, params, method: options.method, credentials: options.credentials };
  calls.push(call);
  const out = handler(call);
  if (out instanceof Error) throw out;
  return {
    ok: out.__httpOk !== false,
    status: out.__httpOk === false ? 500 : 200,
    headers: { get: () => null },
    json: async () => out,
  };
};

function feature(props, geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }) {
  return { type: 'Feature', properties: props, geometry };
}

const {
  fetchTileDrainageAreas,
  fetchIrrigationLicences,
  fetchTileNetwork,
  WALLAS_SOURCES,
} = await import('../src/wallas.js');

// ---- Tile drainage: WHERE clause, paging, normalisation ----------------

// 1,580 licensed tile polygons live behind a maxRecordCount of 1000, so a
// complete fetch is two pages. Page two comes back short, which is the
// only end-of-data signal this service reliably gives — the real service
// omits exceededTransferLimit entirely on the final page rather than
// setting it false.
handler = ({ params }) => {
  const offset = Number(params.get('resultOffset'));
  const count = offset === 0 ? 1000 : 580;
  return {
    type: 'FeatureCollection',
    features: Array.from({ length: count }, (_, i) => feature({
      OBJECTID: offset + i,
      // Real padding, verbatim in shape: value then a wall of spaces.
      LICENCE_NO: `2019-11${i % 10}${' '.repeat(240)}`,
      APPLICATION_STATUS: 'Approved Licence Issued',
      APPLICATION_DATE: 1346112000000,
      CLIENT_NAME: 'Enns, Peter',
      TILE_AREA: '310',
      ACQUIFER_NAME: '',
      LEGACY_LABEL: '   ',
    })),
    ...(offset === 0 ? { exceededTransferLimit: true } : {}),
  };
};

const tiles = await fetchTileDrainageAreas();
assert.equal(tiles.features.length, 1580, 'both pages should be concatenated');
assert.equal(calls.length, 2, 'exactly two requests — no third page after a short one');

const where = calls[0].params.get('where');
assert.match(where, /CONTROL_WORKS_TYPE = 'Tile Drainage'/);
// Licensed-only is the whole point: a rejected application must never be
// able to render as "this field is tiled".
assert.match(where, /APPLICATION_STATUS IN \(/);
for (const status of ['Approved Licence Issued', 'Licence Renewed', 'Licence Replaced', 'Certificate Issued']) {
  assert.ok(where.includes(`'${status}'`), `licensed status ${status} must be in the IN-list`);
}
assert.ok(!/Rejected|No Further Action/.test(where), 'rejected states must not be requested');

// Stable paging needs an explicit sort; without it ArcGIS can repeat or
// skip rows across resultOffset pages.
assert.equal(calls[0].params.get('orderByFields'), 'OBJECTID ASC');
assert.equal(calls[0].params.get('resultOffset'), '0');
assert.equal(calls[1].params.get('resultOffset'), '1000');
assert.equal(calls[0].params.get('outSR'), '4326');
assert.equal(calls[0].params.get('f'), 'geojson');
assert.equal(calls[0].method, 'POST');
// The service answers with Access-Control-Allow-Credentials and sets a
// session cookie; we want an anonymous read, not a stateful one.
assert.equal(calls[0].credentials, 'omit');
assert.match(calls[0].url, /\/MapServer\/7\/query$/, 'tile areas come from layer 7');

const p = tiles.features[0].properties;
assert.equal(p.LICENCE_NO, '2019-110', 'fixed-width padding must be trimmed off');
assert.equal(p.APPLICATION_DATE, '2012-08-28', 'epoch ms should normalise to YYYY-MM-DD');
assert.equal(p.ACQUIFER_NAME, null, 'empty string becomes null');
assert.equal(p.LEGACY_LABEL, null, 'whitespace-only becomes null');
assert.equal(p.TILE_AREA, '310', 'real values survive untouched');

// ---- Caching ----------------------------------------------------------

calls.length = 0;
const again = await fetchTileDrainageAreas();
assert.equal(again.features.length, 1580);
assert.equal(calls.length, 0, 'a warm cache must not re-hit the service');

// An empty response is ambiguous between "genuinely none" and "the
// service hiccuped". Caching it would pin a week of blank Tile columns
// with no way for the user to tell why, so it must not be stored.
globalThis.localStorage = makeFakeStorage();
const { fetchIrrigationLicences: freshIrrigation } = await import(`../src/wallas.js?empty=${Date.now()}`);
handler = () => ({ type: 'FeatureCollection', features: [] });
calls.length = 0;
assert.equal((await freshIrrigation()).features.length, 0);
const afterEmpty = calls.length;
assert.ok(afterEmpty > 0);
calls.length = 0;
await freshIrrigation();
assert.ok(calls.length > 0, 'an empty result must not be cached');

// ---- Irrigation: both layers, tagged so the map can style them apart ---

const modIrr = await import(`../src/wallas.js?irr=${Date.now()}`);
globalThis.localStorage = makeFakeStorage();
calls.length = 0;
handler = ({ url, params }) => {
  if (Number(params.get('resultOffset')) > 0) return { type: 'FeatureCollection', features: [] };
  const layer = url.match(/MapServer\/(\d+)\/query/)[1];
  return {
    type: 'FeatureCollection',
    features: [feature({ OBJECTID: Number(layer), LICENCE_NO: `L-${layer}` })],
  };
};
const irrigation = await modIrr.fetchIrrigationLicences();
const kinds = irrigation.features.map((f) => f.properties._wallasKind);
assert.deepEqual(kinds.sort(), ['diversion', 'use'], 'both POD and POU, each tagged');
const irrLayers = calls.map((c) => c.url.match(/MapServer\/(\d+)\/query/)[1]);
assert.ok(irrLayers.includes('2') && irrLayers.includes('3'), 'layers 2 and 3');
assert.match(calls[0].params.get('where'), /USAGE_CATEGORY = 'Irrigation'/);

// ---- Tile network: viewport-scoped ------------------------------------

calls.length = 0;
handler = () => ({ type: 'FeatureCollection', features: [] });
const net = await fetchTileNetwork([-97.23, 50.13, -97.20, 50.15]);
assert.ok(net.lines && net.outlets, 'lines and outlets return together');
const netLayers = calls.map((c) => c.url.match(/MapServer\/(\d+)\/query/)[1]);
assert.ok(netLayers.includes('6'), 'lines come from layer 6');
assert.ok(netLayers.includes('5'), 'outlets come from layer 5');
assert.equal(calls[0].params.get('geometryType'), 'esriGeometryEnvelope');
assert.equal(calls[0].params.get('geometry'), '-97.23,50.13,-97.2,50.15');
assert.equal(calls[0].params.get('spatialRel'), 'esriSpatialRelIntersects');
assert.match(calls[0].params.get('where'), /CONTROL_WORKS_TYPE = 'Tile Drainage'/);

// A malformed bbox must not become an unbounded province-wide request
// for a 160,000-feature layer.
calls.length = 0;
const badBox = await fetchTileNetwork([NaN, 1, 2, 3]);
assert.equal(badBox.lines.features.length, 0);
assert.equal(calls.length, 0, 'invalid bbox short-circuits before any fetch');

// ---- Failure handling -------------------------------------------------

// The overlays are supplementary; an unreachable service must degrade to
// an empty layer rather than take the search down with it. `_failed`
// distinguishes that from a genuine "nothing here" so callers that need
// to (the tile-only search filter) can refuse to answer.
globalThis.localStorage = makeFakeStorage();
const modFail = await import(`../src/wallas.js?fail=${Date.now()}`);
handler = () => new Error('network down');
const failed = await modFail.fetchTileDrainageAreas();
assert.equal(failed.features.length, 0);
assert.equal(failed._failed, true, 'a transport failure is flagged, not silently empty');

// ArcGIS reports query errors as HTTP 200 with an `error` body — treating
// that as success would yield a silently empty overlay.
globalThis.localStorage = makeFakeStorage();
const modErr = await import(`../src/wallas.js?err=${Date.now()}`);
handler = () => ({ error: { code: 400, message: 'Invalid field' } });
const errored = await modErr.fetchTileDrainageAreas();
assert.equal(errored._failed, true, 'a 200-with-error body counts as failure');

// ---- Provenance -------------------------------------------------------

assert.ok(WALLAS_SOURCES.length >= 3);
for (const s of WALLAS_SOURCES) {
  assert.ok(s.label && s.url.startsWith('https://web43.gov.mb.ca/'));
}

console.log('WALLAS client tests passed');
