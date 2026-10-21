// Unit tests for lib/cityMaps.js — the highway map's city pages as location
// base maps: georeferencing, registration with locationMap.js, and the
// municipality lookup the Addenda Pack uses.
//
// Run: cd web && node test/cityMaps.test.js

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BASE_MAPS, locateOnMap, placeCallout, estimateTextWidth } from '../src/lib/locationMap.js';
import { CITY_MAPS, CITY_MAP_IDS, cityMapForMuni, registerCityMaps } from '../src/lib/cityMaps.js';
import { CITY_MAP_DATA } from '../src/lib/cityMapData.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const svgWidth = (id) => +readFileSync(path.join(dir, '..', 'public', CITY_MAPS[id].svgUrl), 'utf8')
  .slice(0, 600).match(/viewBox="0 0 ([\d.]+)/)[1];
const near = (a, b, tol, msg) => assert.ok(
  Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol,
  `${msg}: got [${a.map((v) => v.toFixed(2))}], want [${b}] ±${tol}`,
);

// OpenStreetMap street intersections and the points on the SOURCE PDF page
// (Highways-2026/<city>.pdf, top-left origin) where the map draws them,
// read off renders (2026-10-21). 1 pt is ~21 m. The test undoes the crop
// and the unit scaling, so re-cropping the SVGs cannot break it.
const CROSSINGS = {
  brandon: [
    ['18th St & Victoria Ave', -99.961931, 49.842242, [209.3, 370.1]],
    ['1st St & Rosser Ave', -99.939139, 49.848440, [286.6, 337.9]],
  ],
  steinbach: [
    ['Main St & Reimer Ave', -96.684881, 49.526367, [295.7, 355.1]],
    ['Hanover St & Barkman Ave', -96.677840, 49.525997, [319.2, 356.9]],
  ],
  thompson: [
    ['Thompson Dr N & Mystery Lake Rd', -97.850851, 55.745041, [336.4, 324.0]],
    ['Princeton Dr & Station Rd', -97.841701, 55.740898, [363.3, 345.6]],
  ],
};

test('every listed city has data, an SVG of the right size, and crossings to check', () => {
  assert.deepEqual(Object.keys(CITY_MAPS), CITY_MAP_IDS);
  for (const id of CITY_MAP_IDS) {
    const m = CITY_MAPS[id];
    const svgPath = path.join(dir, '..', 'public', m.svgUrl);
    assert.ok(existsSync(svgPath), `${id}: ${m.svgUrl} missing`);
    const head = readFileSync(svgPath, 'utf8').slice(0, 600);
    const vb = head.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    assert.ok(vb, `${id}: no viewBox`);
    // Map units are the page scaled to a common width; the aspect must hold.
    assert.ok(Math.abs(vb[2] / vb[1] - m.height / m.width) < 1e-6, `${id}: viewBox ${vb[1]}x${vb[2]} vs ${m.width}x${m.height}`);
    assert.ok(CROSSINGS[id], `${id}: add check crossings for a new city`);
    assert.ok(Math.round(m.width * m.scale) >= 1400, `${id}: rendered too small`);
  }
});

test('street crossings land on the drawn crossings (within 1 pt, ~21 m)', () => {
  for (const [id, rows] of Object.entries(CROSSINGS)) {
    for (const [name, lng, lat, want] of rows) {
      const got = locateOnMap(CITY_MAPS[id], lng, lat);
      assert.ok(got, `${id} ${name}: off the page`);
      const k = CITY_MAPS[id].width / svgWidth(id);
      const [ox, oy] = CITY_MAP_DATA[id].origin;
      near([got.main[0] / k + ox, got.main[1] / k + oy], want, 1, `${id} ${name}`);
    }
  }
});

test('places well away are off each city page', () => {
  for (const m of Object.values(CITY_MAPS)) {
    assert.equal(locateOnMap(m, -97.1384, 49.8951), null, `${m.id}: Winnipeg on the page`);
  }
  // A point 20 km outside Brandon.
  assert.equal(locateOnMap(CITY_MAPS.brandon, -100.25, 49.85), null);
});

test('registerCityMaps adds the city maps to BASE_MAPS without touching the shared ones', () => {
  const before = { manitoba: BASE_MAPS.manitoba, winnipeg: BASE_MAPS.winnipeg };
  registerCityMaps();
  registerCityMaps();
  for (const id of CITY_MAP_IDS) assert.equal(BASE_MAPS[id], CITY_MAPS[id]);
  assert.equal(BASE_MAPS.manitoba, before.manitoba);
  assert.equal(BASE_MAPS.winnipeg, before.winnipeg);
});

test('cityMapForMuni matches the municipality name the boundaries layer uses', () => {
  assert.equal(cityMapForMuni('BRANDON (CITY)'), CITY_MAPS.brandon);
  assert.equal(cityMapForMuni('steinbach (city)'), CITY_MAPS.steinbach);
  assert.equal(cityMapForMuni('THOMPSON (CITY)'), CITY_MAPS.thompson);
  assert.equal(cityMapForMuni('THOMPSON (RM)'), null);
  assert.equal(cityMapForMuni('CORNWALLIS (RM)'), null);
  assert.equal(cityMapForMuni(undefined), null);
});

test('the callout finds a spot on the page at every crossing', () => {
  const w = estimateTextWidth('SUBJECT') + 16;
  for (const [id, rows] of Object.entries(CROSSINGS)) {
    const m = CITY_MAPS[id];
    for (const [name, lng, lat] of rows) {
      const p = locateOnMap(m, lng, lat).main;
      const placed = placeCallout(p, w, { map: m });
      assert.ok(placed, `${id} ${name}: no callout`);
      const [x0, y0, x1, y1] = placed.box;
      assert.ok(x0 >= 0 && y0 >= 0 && x1 <= m.width && y1 <= m.height, `${id} ${name}: callout off the page`);
    }
  }
});

console.log(`\n${passed} passed`);
