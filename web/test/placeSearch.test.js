// Unit tests for lib/placeSearch.js — the ranking behind the map's
// "find a town" box, plus a shape check on the generated data file.
//
// The ranking rules matter more than they look. Manitoba has ~2,000
// populated places and heavy name reuse: "Souris" is a town, a river, a
// locality and a set of sand hills; "Gimli" is a town, an industrial park
// and a rural municipality. Typing five letters has to put the settlement
// people mean on the first line, or the box is slower than panning.
//
// Run: cd web && node test/placeSearch.test.js

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizePlaceName, searchPlaces, muniLabel } from '../src/lib/placeSearch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLACES = join(HERE, '..', 'public', 'mb-places.json');

// [name, type, rank, lat, lon, muni, near] — the mb-places.json row shape.
const row = (name, type, rank, muni = 'TEST (RM)', near = 0) =>
  [name, type, rank, 49.5, -100.2, muni, near];

// ---- normalizePlaceName -------------------------------------------

{
  assert.equal(normalizePlaceName('Souris'), 'SOURIS');
  assert.equal(normalizePlaceName('  souris  '), 'SOURIS');

  // Accents fold: nobody types the circumflex in Île-des-Chênes.
  assert.equal(normalizePlaceName('L’Île-des-Chênes'), 'L ILE DES CHENES');

  // Punctuation becomes space, so "Ste. Rose du Lac" and "Ste Rose du
  // Lac" are the same key — the two spellings both occur in the wild.
  assert.equal(normalizePlaceName('Ste. Rose du Lac'), 'STE ROSE DU LAC');
  assert.equal(normalizePlaceName('St-Pierre-Jolys'), 'ST PIERRE JOLYS');

  assert.equal(normalizePlaceName(null), '');
  assert.equal(normalizePlaceName(undefined), '');
}

// ---- match tiers ---------------------------------------------------

{
  // Exact beats prefix, even when the prefix hit is a "better" place type.
  const rows = [
    row('Souris Corner', 'Locality', 9),
    row('Souris', 'Town', 2),
  ];
  const hits = searchPlaces(rows, 'Souris');
  assert.equal(hits[0].name, 'Souris', 'exact match must rank first');
  assert.equal(hits[1].name, 'Souris Corner');
}

{
  // Prefix beats word-start beats bare substring.
  const rows = [
    row('Grand Rapids', 'Community', 8),     // contains "rapid" mid-word? no: word-start
    row('Rapid City', 'Town', 2),            // prefix
    row('Therapide', 'Locality', 9),         // substring only
  ];
  const hits = searchPlaces(rows, 'rapid');
  assert.deepEqual(hits.map((h) => h.name), ['Rapid City', 'Grand Rapids', 'Therapide']);
}

{
  // Within one tier, the place's own rank decides: a town outranks a
  // railway point of the same name length.
  const rows = [
    row('Elm Creek', 'Railway Point', 13),
    row('Elm Creek', 'Local Urban District', 5),
  ];
  const hits = searchPlaces(rows, 'elm creek');
  assert.equal(hits[0].type, 'Local Urban District');
}

{
  // Same tier and same rank: shorter name first, so the settlement wins
  // over the thing named after it.
  const rows = [
    row('Gimli Industrial Park', 'Locality', 9),
    row('Gimli Beach', 'Locality', 9),
  ];
  const hits = searchPlaces(rows, 'gimli');
  assert.equal(hits[0].name, 'Gimli Beach');
}

{
  // Punctuation-insensitive both ways.
  const rows = [row('L’Île-des-Chênes', 'Community', 8)];
  assert.equal(searchPlaces(rows, 'ile des chenes').length, 1);
  assert.equal(searchPlaces(rows, 'Île-des-Chênes').length, 1);
}

{
  // Empty / whitespace queries return nothing rather than everything —
  // an empty box must not render 2,000 rows.
  const rows = [row('Souris', 'Town', 2)];
  assert.deepEqual(searchPlaces(rows, ''), []);
  assert.deepEqual(searchPlaces(rows, '   '), []);
  assert.deepEqual(searchPlaces(rows, 'zzzznotaplace'), []);
}

{
  // The result cap is honoured.
  const rows = Array.from({ length: 50 }, (_, i) => row(`Test ${i}`, 'Locality', 9));
  assert.equal(searchPlaces(rows, 'test').length, 8);
  assert.equal(searchPlaces(rows, 'test', { limit: 3 }).length, 3);
}

// ---- muniLabel -----------------------------------------------------

{
  assert.equal(muniLabel({ muni: 'SOURIS-GLENWOOD (MUNICIPALITY)', near: false }),
    'SOURIS-GLENWOOD (MUNICIPALITY)');

  // A place matched by the build script's nearest-boundary fallback is
  // labelled as such — it sits outside the polygon, and saying so plainly
  // is better than implying a containment that isn't there.
  assert.equal(muniLabel({ muni: 'DUNNOTTAR (VILLAGE)', near: true }),
    'near DUNNOTTAR (VILLAGE)');

  assert.equal(muniLabel({ muni: null, near: false }), 'Unorganized territory');
}

// ---- generated data file ------------------------------------------

if (!existsSync(PLACES)) {
  console.log('  (skipped data-file checks — run `npm run places` to generate it)');
} else {
  const data = JSON.parse(readFileSync(PLACES, 'utf8'));

  assert.deepEqual(data.fields, ['name', 'type', 'rank', 'lat', 'lon', 'muni', 'near'],
    'row schema drifted from what searchPlaces() destructures');
  assert.ok(data.rows.length > 1500, `expected ~2K places, got ${data.rows.length}`);

  // Every row well-formed and inside Manitoba's envelope. A coordinate
  // that escapes this box means a column-order bug in the generator, which
  // would silently fly the map into Ontario.
  for (const r of data.rows) {
    assert.equal(r.length, 7);
    assert.ok(typeof r[0] === 'string' && r[0].length, 'name');
    assert.ok(typeof r[1] === 'string' && r[1].length, 'type');
    assert.ok(r[3] >= 48.9 && r[3] <= 60.1, `lat out of Manitoba: ${r[0]} ${r[3]}`);
    assert.ok(r[4] >= -102.1 && r[4] <= -88.9, `lon out of Manitoba: ${r[0]} ${r[4]}`);
    assert.ok(r[5] === null || typeof r[5] === 'string', 'muni');
  }

  // The worked example from the feature request: Souris the town resolves
  // to the municipality that contains it, and outranks the other Souris
  // entries. This is the whole point of the feature.
  const souris = searchPlaces(data.rows, 'Souris');
  assert.equal(souris[0].name, 'Souris');
  assert.equal(souris[0].type, 'Town');
  assert.equal(souris[0].muni, 'SOURIS-GLENWOOD (MUNICIPALITY)');

  // Unincorporated places — the reason this uses CGNDB rather than the
  // 183-row municipal boundary list — resolve to their containing RM.
  const cases = [
    ['Ninette', 'PRAIRIE LAKES (RM)'],
    ['Kelwood', 'ROSEDALE (RM)'],
    ['Elphinstone', 'YELLOWHEAD (MUNICIPALITY)'],
    ['Cypress River', 'VICTORIA (RM)'],
    ['Petersfield', 'ST ANDREWS (RM)'],
  ];
  for (const [name, muni] of cases) {
    const hit = searchPlaces(data.rows, name)[0];
    assert.ok(hit, `${name} missing from the place list`);
    assert.equal(hit.muni, muni, `${name} resolved to ${hit.muni}`);
  }

  // Reserves are present and carry the distinct label, so they never read
  // as ordinary towns.
  assert.ok(data.rows.some((r) => r[1] === 'Indian Reserve'),
    'reserves should be included with their own label');
}

console.log('placeSearch.test.js: all assertions passed');
