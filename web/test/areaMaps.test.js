// Unit tests for lib/areaMaps.js — the RM maps and community plans served
// from R2: projection into map units, which sheet is picked for a subject,
// and the index / sheet loading (with a fake fetch; no network, no R2).
//
// The fixture is three real index entries (obstacles trimmed) from
// tools/city-location-maps/build_area.py, 2026-10-21; their fits were
// checked by overlay against the section grid / parcel fabric.
//
// Run: cd web && node test/areaMaps.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BASE_MAPS, locateOnMap } from '../src/lib/locationMap.js';
import { areaMap, loadAreaMaps, pickAreaMap, prepareAreaMap } from '../src/lib/areaMaps.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const INDEX = JSON.parse(readFileSync(path.join(dir, 'fixtures', 'area-maps-index.json'), 'utf8'));
const BASE = 'https://example.test/location-maps/';
const maps = INDEX.maps.map((e) => areaMap(e, BASE));
const byId = Object.fromEntries(maps.map((m) => [m.id, m]));

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

// CGN gazetteer points (public/mb-places.json).
const ALTONA = [-97.55889, 49.10472];
const ANOLA = [-96.63556, 49.885];
const BRANDON = [-99.95222, 49.84694];

await test('every sheet is 380 units wide and keeps its aspect ratio', () => {
  for (const e of INDEX.maps) {
    const m = byId[e.id];
    assert.equal(m.width, 380);
    assert.ok(Math.abs(m.height / m.width - e.height / e.width) < 1e-9, e.id);
    assert.equal(m.assetUrl, BASE + e.file);
    assert.ok(m.scale * m.width >= 1400, `${e.id}: rendered too small`);
  }
});

await test('a community lands well inside its own plan', () => {
  for (const [id, pt] of [['plan-altona-01', ALTONA], ['plan-anola', ANOLA]]) {
    const where = locateOnMap(byId[id], ...pt);
    assert.ok(where, `${id}: off the page`);
    const [x, y] = where.main;
    const m = byId[id];
    assert.ok(x > 0.1 * m.width && x < 0.9 * m.width && y > 0.1 * m.height && y < 0.9 * m.height, `${id}: at ${x}, ${y}`);
  }
});

await test('pickAreaMap: community plans by page, RM maps by page AND municipality', () => {
  assert.equal(pickAreaMap(maps, 'community', ...ALTONA)?.id, 'plan-altona-01');
  assert.equal(pickAreaMap(maps, 'community', ...ANOLA)?.id, 'plan-anola');
  // Brandon is drawn on the Cornwallis page (it sits inside the RM), but a
  // Brandon subject is not in Cornwallis, so it gets no RM map.
  assert.equal(pickAreaMap(maps, 'rm', ...BRANDON)?.id, 'rm-cornwallis');
  assert.equal(pickAreaMap(maps, 'rm', ...BRANDON, 'BRANDON (CITY)'), null);
  assert.equal(pickAreaMap(maps, 'rm', -99.85, 49.78, 'CORNWALLIS (RM)')?.id, 'rm-cornwallis');
  assert.equal(pickAreaMap(maps, 'rm', -99.85, 49.78, 'cornwallis (rm) ')?.id, 'rm-cornwallis');
  // Far away: nothing.
  assert.equal(pickAreaMap(maps, 'community', -97.1384, 49.8951), null);
  assert.equal(pickAreaMap(maps, 'rm', NaN, 49), null);
});

await test('loadAreaMaps resolves to [] when the index cannot be fetched, and retries later', async () => {
  let calls = 0;
  const bad = async () => { calls++; return { ok: false, status: 503 }; };
  const origWarn = console.warn; console.warn = () => {};
  try {
    assert.deepEqual(await loadAreaMaps(bad, BASE), []);
    assert.deepEqual(await loadAreaMaps(bad, BASE), []);
  } finally { console.warn = origWarn; }
  assert.equal(calls, 2, 'a failed index is not cached');
  const good = async (url) => { assert.equal(url, BASE + 'index.json'); return { ok: true, json: async () => INDEX }; };
  const loaded = await loadAreaMaps(good, BASE);
  assert.deepEqual(loaded.map((m) => m.id), INDEX.maps.map((e) => e.id));
});

await test('prepareAreaMap fetches the sheet to a blob: URL and registers it', async () => {
  const m = areaMap(INDEX.maps[0], BASE);
  let fetched = null;
  const fake = async (url) => { fetched = url; return { ok: true, blob: async () => new Blob(['<svg/>'], { type: 'image/svg+xml' }) }; };
  await prepareAreaMap(m, fake);
  assert.equal(fetched, m.assetUrl);
  assert.match(m.svgUrl, /^blob:/);
  assert.equal(BASE_MAPS[m.id], m);
  const again = m.svgUrl;
  await prepareAreaMap(m, async () => { throw new Error('should not refetch'); });
  assert.equal(m.svgUrl, again);
  delete BASE_MAPS[m.id];
  await assert.rejects(prepareAreaMap(areaMap(INDEX.maps[1], BASE), async () => ({ ok: false, status: 404 })), /404/);
});

console.log(`\n${passed} passed`);
