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

globalThis.localStorage = makeFakeStorage();
globalThis.sessionStorage = makeFakeStorage();

// Reproduce Rockwood's current source shape: 2,769 matching polygons, which
// requires two feature batches after the complete ID snapshot is captured.
let sourceIds = Array.from({ length: 2769 }, (_, i) => i + 1);
let omitLastFeature = false;
let idResponseOverride = null;
const calls = [];
globalThis.fetch = async (_url, options = {}) => {
  const params = new URLSearchParams(options.body || '');
  if (params.get('returnIdsOnly') === 'true') {
    calls.push({ type: 'ids' });
    return response(idResponseOverride || { objectIdFieldName: 'OBJECTID', objectIds: sourceIds });
  }

  const ids = (params.get('objectIds') || '')
    .split(',')
    .filter(Boolean)
    .map(Number);
  calls.push({ type: 'features', count: ids.length, hasGeometryFilter: params.has('geometry') });
  const returnedIds = omitLastFeature ? ids.slice(0, -1) : ids;
  return response({
    type: 'FeatureCollection',
    features: returnedIds.map((id) => ({
      type: 'Feature',
      properties: { OBJECTID: id },
      geometry: null,
    })),
  });
};

function response(json) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => json,
  };
}

const {
  fetchCliAgrForMuni,
  fetchCompleteFeatureSet,
  fetchSoilSurveyForMuni,
  fetchSoilSurveyLabelsForMuni,
} = await import('../src/arcgis.js');

const boundary = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [-97.5, 50.0], [-96.5, 50.0], [-96.5, 51.0],
      [-97.5, 51.0], [-97.5, 50.0],
    ]],
  },
};

const fc = await fetchCliAgrForMuni('ROCKWOOD (RM)', boundary);
assert.equal(fc.features.length, 2769);
assert.equal(fc._expectedCount, 2769);
assert.deepEqual(calls, [
  { type: 'ids' },
  { type: 'features', count: 2000, hasGeometryFilter: false },
  { type: 'features', count: 769, hasGeometryFilter: false },
]);

let cacheKeys = Array.from(
  { length: globalThis.localStorage.length },
  (_, i) => globalThis.localStorage.key(i),
);
assert.ok(
  cacheKeys.some((key) => key.includes('mb_cli_agr_ROCKWOOD (RM)_v8')),
  'expected the corrected payload to use a fresh v8 cache key',
);
assert.ok(
  cacheKeys.every((key) => !key.includes('mb_cli_agr_ROCKWOOD (RM)_v7')),
  'must not reuse the incomplete v7 cache key',
);

// The dedicated polygon and label paths must use the same complete policy,
// not drift back to their former independent fixed caps.
sourceIds = [101, 102, 103];
calls.length = 0;
assert.equal((await fetchSoilSurveyForMuni('TEST (RM)', boundary)).features.length, 3);
assert.equal((await fetchSoilSurveyLabelsForMuni('TEST (RM)', boundary)).features.length, 3);
assert.deepEqual(calls.map((call) => call.type), ['ids', 'features', 'ids', 'features']);
cacheKeys = Array.from(
  { length: globalThis.localStorage.length },
  (_, i) => globalThis.localStorage.key(i),
);
assert.ok(cacheKeys.some((key) => key.includes('mb_soil_survey_TEST (RM)_v7')));
assert.ok(cacheKeys.some((key) => key.includes('mb_soil_survey_labels_TEST (RM)_v3')));

// A valid zero-ID response means the municipality has no coverage. It is not
// confused with a failed or truncated request.
sourceIds = [];
calls.length = 0;
const empty = await fetchCompleteFeatureSet('https://example.test/FeatureServer/0', {
  where: '1=1',
  returnGeometry: 'true',
  outFields: 'OBJECTID',
  f: 'geojson',
}, 'Empty test layer');
assert.deepEqual(empty.features, []);
assert.equal(empty._expectedCount, 0);
assert.deepEqual(calls, [{ type: 'ids' }]);

// If even one requested polygon is absent, fail before the caller can cache
// plausible-looking partial data.
sourceIds = [201, 202, 203];
omitLastFeature = true;
await assert.rejects(
  fetchCompleteFeatureSet('https://example.test/FeatureServer/0', {
    where: '1=1',
    returnGeometry: 'true',
    outFields: 'OBJECTID',
    f: 'geojson',
  }, 'Partial test layer'),
  /incomplete \(2\/3 polygons; 1 missing\).*Nothing was cached/,
);

omitLastFeature = false;
sourceIds = [301, 301];
await assert.rejects(
  fetchCompleteFeatureSet('https://example.test/FeatureServer/0', {
    where: '1=1',
    returnGeometry: 'true',
    outFields: 'OBJECTID',
    f: 'geojson',
  }, 'Duplicate-ID test layer'),
  /duplicate OBJECTIDs/,
);

idResponseOverride = { objectIdFieldName: 'OBJECTID' };
await assert.rejects(
  fetchCompleteFeatureSet('https://example.test/FeatureServer/0', {
    where: '1=1',
    returnGeometry: 'true',
    outFields: 'OBJECTID',
    f: 'geojson',
  }, 'Malformed-ID test layer'),
  /did not return an OBJECTID list/,
);

console.log('soil fetch completeness tests passed');
