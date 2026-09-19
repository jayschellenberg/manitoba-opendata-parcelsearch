// pickMunicipality — which municipality a GPS fix is in.
//
// "Use my location" selects the municipality under the fix so the
// Assessment Parcels overlay (scoped to the dropdown) can draw the
// parcels around the user. The lookup must hand back the dropdown's own
// option value, ignore holes and neighbours, and never throw on a
// broken feature.
//
// Run: cd web && node test/muniAt.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickMunicipality } from '../src/lib/muniAt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const sq = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const feat = (props, coords) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: coords } });
const A = feat({ MUNI_NO: 451, MUNI_NAME: 'CITY OF STEINBACH', MUNI_LIST_NAME_WITH_TYPE: 'STEINBACH (CITY)' }, sq(-96.72, 49.50, -96.66, 49.55));
const B = feat({ MUNI_NO: 152, MUNI_NAME: 'RM OF HANOVER', MUNI_LIST_NAME_WITH_TYPE: 'HANOVER (RM)' }, sq(-96.90, 49.40, -96.72, 49.60));

test('a point inside a polygon names that municipality by its dropdown value', () => {
  const m = pickMunicipality([B, A], { lng: -96.69, lat: 49.52 });
  assert.deepEqual(m, { no: 451, name: 'CITY OF STEINBACH', listName: 'STEINBACH (CITY)' });
});

test('a point in the neighbour is the neighbour, and an array pair works too', () => {
  assert.equal(pickMunicipality([A, B], [-96.80, 49.45]).listName, 'HANOVER (RM)');
});

test('a point outside every boundary is null, and a broken feature is skipped', () => {
  assert.equal(pickMunicipality([A, B], { lng: -97.5, lat: 50.0 }), null);
  const broken = { type: 'Feature', properties: {}, geometry: null };
  assert.equal(pickMunicipality([broken, A], { lng: -96.69, lat: 49.52 }).no, 451);
  assert.equal(pickMunicipality(undefined, { lng: 0, lat: 0 }), null);
});

test('the real boundary file puts downtown Steinbach in STEINBACH (CITY)', () => {
  const fc = JSON.parse(fs.readFileSync(path.join(here, '..', 'public', 'mb-municipalities.geojson'), 'utf8'));
  const m = pickMunicipality(fc.features, { lng: -96.6845, lat: 49.5258 });
  assert.equal(m?.listName, 'STEINBACH (CITY)');
  assert.equal(m?.no, 451);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
