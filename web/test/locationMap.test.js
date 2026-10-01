// Unit tests for lib/locationMap.js — the georeferencing of the NRCan
// Manitoba overview page and the SUBJECT callout placement.
//
// Run: cd web && node test/locationMap.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PAGE_W, PAGE_H, OBSTACLES, DIRECTIONS,
  lngLatToPage, isInManitoba, placeCallout, estimateTextWidth,
} from '../src/lib/locationMap.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const near = (a, b, tol, msg) => assert.ok(
  Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol,
  `${msg}: got [${a.map((v) => v.toFixed(2))}], want [${b}] ±${tol}`,
);

// 1. The graticule vertices drawn on the page (49th-parallel border and
//    60th-parallel border, read from the PDF's border paths) — the fit's
//    own control points, which it must reproduce essentially exactly.
for (const [x, y, lat, lng] of [
  [24.69, 464.8, 49, -101], [107.61, 466.35, 49, -98], [162.89, 465.21, 49, -96],
  [23.32, 9.18, 60, -102], [105.25, 11.36, 60, -98], [166.7, 9.61, 60, -95],
]) near(lngLatToPage(lng, lat), [x, y], 0.05, `graticule ${lat},${lng}`);

// 2. Town dots — independent of the fit, and placed loosely by the
//    cartographer, so only within a few points.
for (const [name, lng, lat, x, y] of [
  ['Steinbach', -96.68389, 49.52583, 143.8, 443.0],
  ['Brandon', -99.95222, 49.84694, 55.4, 430.1],
  ['Thompson', -97.85528, 55.74333, 109.2, 186.3],
  ['Morden', -98.10056, 49.19194, 105.1, 458.4],
]) near(lngLatToPage(lng, lat), [x, y], 2.5, name);

assert.ok(isInManitoba(-97.1, 49.9));
assert.ok(!isInManitoba(-104.6, 50.4), 'Regina is not on the page');

// 3. The SVG asset is the page these coordinates describe.
const svg = readFileSync(path.join(dir, '../public/manitoba-overview.svg'), 'utf8');
const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
assert.ok(vb, 'SVG has a viewBox');
assert.ok(Math.abs(Number(vb[1]) - PAGE_W) < 0.01 && Math.abs(Number(vb[2]) - PAGE_H) < 0.01, 'viewBox matches PAGE_W/H');

// 4. Placement: always on the page, never on the subject, and clear of
//    labels for a typical southern subject.
const w = estimateTextWidth('SUBJECT') + 16;
const inside = (b) => b[0] >= 0 && b[1] >= 0 && b[2] <= PAGE_W && b[3] <= PAGE_H;
const covers = (b, p) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
for (const [lng, lat] of [[-96.684, 49.526], [-101.86, 54.77], [-94.19, 58.78], [-95.2, 49.0], [-102, 60]]) {
  const p = lngLatToPage(lng, lat);
  const r = placeCallout(p, w);
  assert.ok(r, `placed at ${lng},${lat}`);
  assert.ok(inside(r.box), `box on page at ${lng},${lat}`);
  assert.ok(!covers(r.box, p), `box clear of the subject at ${lng},${lat}`);
}
const steinbach = placeCallout(lngLatToPage(-96.684, 49.526), w);
const covered = OBSTACLES.reduce((s, o) => s + overlap(steinbach.box, o), 0);
assert.ok(covered < 1, `Steinbach callout covers ${covered.toFixed(1)} pt² of labels`);

// A forced side is honoured when it fits...
const p = lngLatToPage(-95.5, 54.0);  // mid-page, room on every side
for (const [key, angle] of Object.entries(DIRECTIONS)) {
  const r = placeCallout(p, w, { direction: key });
  const cx = (r.box[0] + r.box[2]) / 2 - p[0];
  const cy = (r.box[1] + r.box[3]) / 2 - p[1];
  const got = Math.atan2(cy, cx) * 180 / Math.PI;
  const diff = Math.abs(((got - angle + 540) % 360) - 180);
  assert.ok(diff < 50, `direction ${key}: box at ${got.toFixed(0)}°, want ~${angle}°`);
}
// ...and falls back to auto instead of leaving the page when it can't.
const corner = lngLatToPage(-101.9, 59.9);
assert.ok(inside(placeCallout(corner, w, { direction: 'nw' }).box), 'forced off-page side falls back');

// 5. Contract: the button is in the page and actually wired.
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const html = readFileSync(path.join(dir, '../index.html'), 'utf8');
assert.ok(html.includes('id="location-map-btn"'), 'button in index.html');
assert.ok(/\$locationMapBtn\.addEventListener\('click', \(\) => generateLocationMap\(\)\)/.test(main), 'button wired to generateLocationMap');

console.log('locationMap: all tests passed');
