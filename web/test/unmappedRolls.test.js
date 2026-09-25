// unmappedRolls — a roll in MAO with no ROLL_ENTRY polygon yet.
//
// The stand-in pin must land on the quarter / section the legal description
// names when the survey has it, fall back to the municipality otherwise, stay
// inside the picked municipality, and carry flags that keep it from passing
// for a mapped parcel.
//
// Run: cd web && node test/unmappedRolls.test.js

import assert from 'node:assert/strict';
import {
  strRefsFromRecord, distinctSections, sectionWhere, placeFromSurvey,
  municipalityCentre, findMunicipality, muniNoForListName,
  selectUnmappedRecords, buildUnmappedFeature, unmappedCountNote,
  unmappedPlacementText, approxFitMaxZoom, MAX_UNMAPPED,
} from '../src/lib/unmappedRolls.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const pt = (props, lng, lat) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } });
const q = (quarter, lng, lat, meridian = 'E1') => pt({ QUARTER: quarter, SECTION: 12, TOWNSHIP: 7, RANGE: 4, MERIDIAN: meridian }, lng, lat);
const survey = { type: 'FeatureCollection', features: [
  q('NE', -96.10, 49.51), q('NW', -96.12, 49.51), q('SE', -96.10, 49.49), q('SW', -96.12, 49.49),
  // Same numbers west of the principal meridian — must be ignored for an E ref.
  q('NE', -99.00, 49.51, 'W1'),
] };
const bySection = new Map([['12|7|4|E', survey]]);

const muni = {
  type: 'Feature',
  properties: { MUNI_NO: 152, MUNI_NAME: 'RM OF HANOVER', MUNI_LIST_NAME_WITH_TYPE: 'HANOVER (RM)' },
  geometry: { type: 'Polygon', coordinates: [[[-97, 49], [-96, 49], [-96, 50], [-97, 50], [-97, 49]]] },
};

test('quarter refs parse from both the detail and compact description forms', () => {
  const refs = strRefsFromRecord({ legal_description: 'NE12-7-4E', legal_detail: 'NW-12-07-04-E' });
  assert.deepEqual(refs.map((r) => r.q).sort(), ['NE', 'NW']);
  assert.deepEqual(distinctSections(refs), [{ sec: 12, twp: 7, rge: 4, dir: 'E' }]);
});

test('river-lot tokens are not treated as sections', () => {
  assert.deepEqual(strRefsFromRecord({ legal_description: 'RL7E-23-4E', legal_detail: '' }), []);
});

test('a lot-on-plan legal has no refs', () => {
  assert.deepEqual(strRefsFromRecord({ legal_description: 'LOT 4 BLOCK 2 PLAN 12345', legal_detail: '' }), []);
});

test('section WHERE clause, numeric and quoted', () => {
  const s = { sec: 12, twp: 7, rge: 4 };
  assert.equal(sectionWhere(s), "TYPE = 'Quarter' AND SECTION = 12 AND TOWNSHIP = 7 AND RANGE = 4");
  assert.equal(sectionWhere(s, { quoted: true }), "TYPE = 'Quarter' AND SECTION = '12' AND TOWNSHIP = '7' AND RANGE = '4'");
});

test('a named quarter lands on that quarter point, not the west-meridian twin', () => {
  const p = placeFromSurvey([{ q: 'NE', sec: 12, twp: 7, rge: 4, dir: 'E' }], bySection);
  assert.equal(p.basis, 'quarter');
  assert.deepEqual([p.lng, p.lat], [-96.10, 49.51]);
});

test('two quarters average between them', () => {
  const p = placeFromSurvey([
    { q: 'NE', sec: 12, twp: 7, rge: 4, dir: 'E' },
    { q: 'SE', sec: 12, twp: 7, rge: 4, dir: 'E' },
  ], bySection);
  assert.equal(p.basis, 'quarter');
  assert.ok(Math.abs(p.lat - 49.50) < 1e-9);
});

test('a missing quarter falls back to the section centre', () => {
  const partial = new Map([['12|7|4|E', { type: 'FeatureCollection', features: [q('SW', -96.12, 49.49), q('NW', -96.12, 49.51)] }]]);
  const p = placeFromSurvey([{ q: 'NE', sec: 12, twp: 7, rge: 4, dir: 'E' }], partial);
  assert.equal(p.basis, 'section');
  assert.ok(Math.abs(p.lat - 49.50) < 1e-9);
});

test('no survey points → null (caller uses the municipality)', () => {
  assert.equal(placeFromSurvey([{ q: 'NE', sec: 1, twp: 1, rge: 1, dir: 'E' }], bySection), null);
  assert.equal(placeFromSurvey([], bySection), null);
});

test('municipality lookup and centre', () => {
  assert.equal(muniNoForListName([muni], 'hanover (rm)'), 152);
  assert.equal(muniNoForListName([muni], 'NOWHERE'), null);
  assert.equal(findMunicipality([muni], '152'), muni);
  assert.deepEqual(municipalityCentre(muni), { lng: -96.5, lat: 49.5 });
});

test('records are scoped to the picked municipality, deduped and capped', () => {
  const recs = new Map([['100.000', [
    { muni_no: 152, roll_no_txt: '100.000' },
    { muni_no: 152, roll_no_txt: '100.000' },
    { muni_no: 451, roll_no_txt: '100.000' },
  ]]]);
  assert.equal(selectUnmappedRecords(['100.000'], recs, 152).length, 1);
  assert.equal(selectUnmappedRecords(['100.000'], recs, null).length, 2);
  assert.equal(selectUnmappedRecords(['999.000'], recs, null).length, 0);
  const many = new Map([['1.000', Array.from({ length: 40 }, (_, i) => ({ muni_no: i, roll_no_txt: '1.000' }))]]);
  assert.equal(selectUnmappedRecords(['1.000'], many, null).length, MAX_UNMAPPED);
});

test('the stand-in feature reads like a ROLL_ENTRY parcel and is flagged', () => {
  const rec = { muni_no: 152, roll_no_txt: '100.000', civic_address: '1 MAIN ST', source_url: 'https://example/mao', municipality: 'HANOVER' };
  const f = buildUnmappedFeature(rec, { lng: -96.1, lat: 49.5, basis: 'quarter', ref: { sec: 12, twp: 7, rge: 4, dir: 'E' } }, muni, 3);
  assert.equal(f.geometry.type, 'Point');
  assert.equal(f.properties.OBJECTID, -3);
  assert.equal(f.properties.Roll_No_Txt, '100.000');
  assert.equal(f.properties.Municipality, '152 - RM OF HANOVER');
  assert.equal(f.properties.Muni_Name_With_Typ, 'HANOVER (RM)');
  assert.equal(f.properties.Property_Address, '1 MAIN ST');
  assert.equal(f.properties._unmapped, true);
  assert.equal(f.properties._unmappedRef, '12-7-4E');
  assert.match(unmappedPlacementText(f.properties), /quarter section.*12-7-4E/);
});

test('municipality-basis pin says so', () => {
  const f = buildUnmappedFeature({ muni_no: 152, roll_no_txt: '1.000' }, { lng: -96.5, lat: 49.5, basis: 'municipality' }, muni, 1);
  assert.match(unmappedPlacementText(f.properties), /centre of the municipality/);
});

test('count note and zoom cap', () => {
  const a = buildUnmappedFeature({ muni_no: 152, roll_no_txt: '1.000' }, { lng: 0, lat: 0, basis: 'municipality' }, muni, 1);
  const b = buildUnmappedFeature({ muni_no: 152, roll_no_txt: '2.000' }, { lng: 0, lat: 0, basis: 'quarter' }, muni, 2);
  const real = { type: 'Feature', properties: {}, geometry: null };
  assert.equal(unmappedCountNote([real]), '');
  assert.match(unmappedCountNote([real, a]), /^1 not yet on the parcel map/);
  assert.equal(approxFitMaxZoom([a, b]), 10);
  assert.equal(approxFitMaxZoom([b]), 14);
  assert.equal(approxFitMaxZoom([a, real]), null);
  assert.equal(approxFitMaxZoom([]), null);
});

const failed = results.filter((r) => r === 0).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
