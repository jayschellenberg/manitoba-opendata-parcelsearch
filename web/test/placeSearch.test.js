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
import {
  normalizePlaceName, searchPlaces, muniLabel,
  searchMunis, muniAliases, muniTypeLabel, muniPickHint, MUNI_TYPE_LABELS, muniShortName,
} from '../src/lib/placeSearch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLACES = join(HERE, '..', 'public', 'mb-places.json');
const BOUNDARIES = join(HERE, '..', 'public', 'mb-municipalities.geojson');

// [name, type, rank, lat, lon, muni, near] — the mb-places.json row shape.
const row = (name, type, rank, muni = 'TEST (RM)', near = 0) =>
  [name, type, rank, 49.5, -100.2, muni, near];

// The municipality row shape main.js hands the control, derived from the
// boundary file's MUNI_LIST_NAME_WITH_TYPE / MUNI_LIST_NAME / MUNI_TYPE.
const muni = (shortName, type, selectable = true) =>
  ({ name: `${shortName} (${type})`, shortName, type, selectable });

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

// ---- municipality search -------------------------------------------

{
  // Abbreviations spell out; anything unknown title-cases rather than
  // shouting the raw code.
  assert.equal(muniTypeLabel('RM'), 'Rural Municipality');
  assert.equal(muniTypeLabel('LGD'), 'Local Government District');
  assert.equal(muniTypeLabel('NORTHERN COMMUNITY'), 'Northern Community');
  assert.equal(muniTypeLabel('rm'), 'Rural Municipality');
  assert.equal(muniTypeLabel('SOMETHING NEW'), 'Something New');
  assert.equal(muniTypeLabel(''), 'Municipality');
  assert.equal(muniTypeLabel(null), 'Municipality');
}

{
  // All four spoken/written forms are matchable keys.
  const keys = muniAliases(muni('HANOVER', 'RM'));
  assert.ok(keys.includes('HANOVER RM'));
  assert.ok(keys.includes('HANOVER'));
  assert.ok(keys.includes('RM OF HANOVER'));
  assert.ok(keys.includes('RURAL MUNICIPALITY OF HANOVER'));
}

{
  // The bare name is an EXACT hit even though the stored name is longer,
  // so a municipality typed plainly outranks one it merely prefixes.
  const rows = [muni('ST ANDREWS', 'RM'), muni('ST', 'RM')];
  assert.equal(searchMunis(rows, 'st andrews')[0].name, 'ST ANDREWS (RM)');
}

{
  // "RM of Hanover" — the type leads, which matches nothing in a stored
  // name that ends with it. This is the case the aliases exist for.
  const rows = [muni('HANOVER', 'RM')];
  assert.equal(searchMunis(rows, 'RM of Hanover').length, 1);
  assert.equal(searchMunis(rows, 'rural municipality of hanover').length, 1);
  assert.equal(searchMunis(rows, 'hanover (rm)').length, 1);
}

{
  // Name collisions: the settlement type wins. All six real ones in the
  // boundary file are city-or-town versus RM.
  const rows = [muni('DAUPHIN', 'RM'), muni('DAUPHIN', 'CITY')];
  assert.equal(searchMunis(rows, 'dauphin')[0].name, 'DAUPHIN (CITY)');

  const morris = [muni('MORRIS', 'RM'), muni('MORRIS', 'TOWN')];
  assert.equal(searchMunis(morris, 'morris')[0].name, 'MORRIS (TOWN)');
}

{
  // A municipality with no parcel data is a dead end for a search and
  // sorts below one that isn't — but only within a tier: an exact
  // unsearchable hit still beats a searchable prefix hit.
  const rows = [muni('BIFROST', 'RM', false), muni('BIFROST-RIVERTON', 'MUNICIPALITY', true)];
  const hits = searchMunis(rows, 'bifrost');
  assert.equal(hits[0].name, 'BIFROST (RM)');
  assert.equal(hits[0].selectable, false);

  const tied = [muni('ALPHA', 'RM', false), muni('ALPHA', 'RM', true)];
  assert.equal(searchMunis(tied, 'alpha')[0].selectable, true);
}

{
  // Accents and punctuation fold on this side too.
  const rows = [muni('STE ANNE', 'RM')];
  assert.equal(searchMunis(rows, 'ste. anne').length, 1);
  assert.equal(searchMunis(rows, 'STE-ANNE').length, 1);
}

{
  assert.deepEqual(searchMunis([muni('HANOVER', 'RM')], ''), []);
  assert.deepEqual(searchMunis([muni('HANOVER', 'RM')], '  '), []);
  assert.deepEqual(searchMunis(null, 'hanover'), []);
  assert.deepEqual(searchMunis([{ shortName: 'no name' }], 'no name'), []);

  // Cap honoured, default is the muni ration rather than the full list.
  const many = Array.from({ length: 20 }, (_, i) => muni(`TEST ${i}`, 'RM'));
  assert.equal(searchMunis(many, 'test').length, 4);
  assert.equal(searchMunis(many, 'test', { limit: 8 }).length, 8);
}

{
  // Every hit is tagged so the caller can tell the two halves apart —
  // handlePlacePick branches on exactly this.
  assert.equal(searchMunis([muni('HANOVER', 'RM')], 'hanover')[0].kind, 'muni');
  assert.equal(searchPlaces([row('Souris', 'Town', 2)], 'souris')[0].kind, 'place');
}

{
  assert.equal(muniPickHint({ selectable: true }), 'Selects in Property Search');
  assert.equal(muniPickHint({ selectable: false }), 'No parcel data — map only');
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

// ---- municipality rows, against the real boundary file --------------

if (!existsSync(BOUNDARIES)) {
  console.log('  (skipped boundary-file checks — mb-municipalities.geojson missing)');
} else {
  const fc = JSON.parse(readFileSync(BOUNDARIES, 'utf8'));
  const props = fc.features.map((f) => f.properties || {});
  // Exactly what main.js's muniSearchRows() builds — no shortName, because
  // the live ArcGIS FC the app runs on doesn't carry MUNI_LIST_NAME and
  // searchMunis derives it. `selectable` comes off the dropdown and has no
  // meaning under node.
  const munis = props
    .filter((p) => p.MUNI_LIST_NAME_WITH_TYPE)
    .map((p) => ({ name: p.MUNI_LIST_NAME_WITH_TYPE, type: p.MUNI_TYPE || '', selectable: true }));

  assert.ok(munis.length > 150, `expected ~183 municipalities, got ${munis.length}`);
  assert.equal(munis.length, fc.features.length,
    'every boundary feature must carry MUNI_LIST_NAME_WITH_TYPE');

  // The derivation the app depends on, checked against the authoritative
  // field on all 183 rows. If a municipality is ever named with a trailing
  // parenthetical of its own, this is what catches it.
  //
  // Compared against the TRIMMED field: the province ships one row with
  // stray whitespace — "CARTWRIGHT-ROBLIN  (MUNICIPALITY)", double space,
  // and a MUNI_LIST_NAME with a trailing one — and muniShortName trims,
  // which is the behaviour we want rather than a mismatch to fix.
  for (const p of props) {
    assert.equal(muniShortName(p.MUNI_LIST_NAME_WITH_TYPE), p.MUNI_LIST_NAME.trim(),
      `stripping the type off ${p.MUNI_LIST_NAME_WITH_TYPE} does not give MUNI_LIST_NAME`);
  }
  assert.equal(searchMunis(munis, 'hanover')[0].shortName, 'HANOVER',
    'searchMunis must derive shortName when the caller supplies none');

  // Every MUNI_TYPE in the file has a spelled-out label. A new code would
  // still render (title-cased) but should be added deliberately, and this
  // is where that gets noticed — "LGD" falling through to "Lgd" is not an
  // answer.
  const unlabelled = [...new Set(munis.map((m) => m.type))]
    .filter((t) => !(t in MUNI_TYPE_LABELS));
  assert.deepEqual(unlabelled, [], `MUNI_TYPE codes with no label: ${unlabelled}`);

  // The worked example: having learned Souris is in SOURIS-GLENWOOD from
  // the place half, typing that name finds the municipality itself.
  assert.equal(searchMunis(munis, 'souris-glenwood')[0].name,
    'SOURIS-GLENWOOD (MUNICIPALITY)');

  // Typed the way people say them.
  const spoken = [
    ['RM of Hanover', 'HANOVER (RM)'],
    ['City of Winkler', 'WINKLER (CITY)'],
    ['Rural Municipality of Rockwood', 'ROCKWOOD (RM)'],
    ['ste. anne', 'STE ANNE (TOWN)'],
    ['portage la prairie', 'PORTAGE LA PRAIRIE (CITY)'],
  ];
  for (const [query, want] of spoken) {
    const hit = searchMunis(munis, query)[0];
    assert.ok(hit, `"${query}" found no municipality`);
    assert.equal(hit.name, want, `"${query}" resolved to ${hit.name}`);
  }

  // Every municipality is findable by its own bare name.
  for (const m of munis) {
    const hits = searchMunis(munis, muniShortName(m.name), { limit: 200 });
    assert.ok(hits.some((h) => h.name === m.name),
      `${m.name} is not findable by its own name`);
  }
}

console.log('placeSearch.test.js: all assertions passed');
