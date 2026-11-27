// Preliminary report helpers: municipality -> census subdivision, distances,
// "nearby" filtering, zoning text and traffic summaries.
//
// Run: cd web && node test/reportData.test.js

import assert from 'node:assert/strict';
import { csdCodesFor, splitMuniName, isUnorganizedPlace, normName } from '../src/lib/censusCsd.js';
import {
  distanceM, centreOf, nearby, clean, fmtDistance, zoningText, bylawText, censusColumns, nearbyTraffic, reportUrl,
} from '../src/lib/reportData.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('preliminary report helpers');

const regions = [
  { uid: '4602044', name: 'Steinbach (CY)', level: 'CSD' },
  { uid: '4602037', name: 'Hanover (RM)', level: 'CSD' },
  { uid: '4615063', name: 'Yellowhead (RM)', level: 'CSD' },
  { uid: '4611042', name: 'St. François Xavier (RM)', level: 'CSD' },
  { uid: '4607062', name: 'Dauphin (CY)', level: 'CSD' },
  { uid: '4617050', name: 'Dauphin (RM)', level: 'CSD' },
  { uid: '4611056', name: 'Taché (RM)', level: 'CSD' },
  { uid: '46', name: 'Manitoba (Man.)', level: 'PR' },
];

test('name + type match, accents and punctuation ignored', () => {
  assert.deepEqual(csdCodesFor('STEINBACH (CITY)', regions), ['4602044']);
  assert.deepEqual(csdCodesFor('ST FRANCOIS XAVIER (RM)', regions), ['4611042']);
  assert.deepEqual(csdCodesFor('TACHE (RM)', regions), ['4611056']);
});

test('the type decides between a city and an RM of the same name', () => {
  assert.deepEqual(csdCodesFor('DAUPHIN (CITY)', regions), ['4607062']);
  assert.deepEqual(csdCodesFor('DAUPHIN (RM)', regions), ['4617050']);
});

test('overrides cover renamed and split CSDs', () => {
  assert.deepEqual(csdCodesFor('YELLOWHEAD (MUNICIPALITY)', regions), ['4615063']);
  assert.deepEqual(csdCodesFor('MOUNTAIN (RM)', regions), ['4620032', '4620055']);
});

test('northern communities resolve to nothing rather than a neighbour', () => {
  assert.ok(isUnorganizedPlace('CROSS LAKE (NORTHERN COMMUNITY)'));
  assert.deepEqual(csdCodesFor('CROSS LAKE (NORTHERN COMMUNITY)', regions), []);
  assert.deepEqual(csdCodesFor('INDIGENOUS&NORTHERN RELATIONS (700)', regions), []);
});

test('name helpers', () => {
  assert.deepEqual(splitMuniName('KILLARNEY TURTLE MOUNTAIN (MUNICIPALITY)'), ['KILLARNEY TURTLE MOUNTAIN', 'MUNICIPALITY']);
  assert.equal(normName('St. François'), 'STFRANCOIS');
});

test('distance and nearby', () => {
  const d = distanceM(49.8951, -97.1384, 49.8951, -97.1245);   // ~1 km east in Winnipeg
  assert.ok(d > 950 && d < 1050, `got ${d}`);
  const at = { lat: 49.5, lon: -96.7 };
  const fs = [
    { geometry: { type: 'Point', coordinates: [-96.7, 49.509] }, properties: { n: 'b' } },
    { geometry: { type: 'Point', coordinates: [-96.7, 49.501] }, properties: { n: 'a' } },
    { geometry: { type: 'Point', coordinates: [-96.7, 49.6] }, properties: { n: 'far' } },
    { geometry: null, properties: { n: 'none' } },
  ];
  assert.deepEqual(nearby(fs, at, 2000).map((f) => f.properties.n), ['a', 'b']);
  assert.equal(fmtDistance(140), '140 m');
  assert.equal(fmtDistance(2345), '2.3 km');
});

test('centre of a polygon', () => {
  const c = centreOf({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 4], [0, 4], [0, 0]]] });
  assert.deepEqual(c, { lon: 1, lat: 2 });
});

test('zoning text drops slivers and shows split percentages', () => {
  const m = [
    { feature: { properties: { ZONE: 'RR', ZONE_NAME: 'Rural Residential', ZBL: '2190-19' } }, ratio: 0.82 },
    { feature: { properties: { ZONE: 'AG', ZONE_NAME: 'AG', ZBL: '2190-19' } }, ratio: 0.18 },
    { feature: { properties: { ZONE: 'X' } }, ratio: 0.004 },
  ];
  assert.equal(zoningText(m), 'RR Rural Residential (82%) · AG (18%)');
  assert.equal(zoningText([{ feature: { properties: { ZONE: 'C2' } }, ratio: 1 }]), 'C2');
  assert.equal(bylawText(m), '2190-19');
});

test('census columns: subject first, comparisons after, no duplicates', () => {
  const summary = { regions: [{ uid: '4602044', name: 'Steinbach (CY)' }, { uid: '46602', name: 'Winnipeg (B)' }, { uid: '46', name: 'Manitoba' }] };
  assert.deepEqual(censusColumns(summary, ['4602044']).columns.map((c) => c.uid), ['4602044', '46602', '46']);
  assert.deepEqual(censusColumns(summary, []).columns.map((c) => c.uid), ['46602', '46']);
});

test('traffic: latest count and 10-year compound change', () => {
  const stations = { features: [{ geometry: { type: 'Point', coordinates: [-96.7, 49.51] }, properties: { StationNum: 7 } }] };
  const history = { stations: { 7: { hwy: '12', loc: 'N of PR 311', y: { 2014: 1000, 2024: 1219 } } } };
  const [t] = nearbyTraffic(stations, history, { lat: 49.5, lon: -96.7 });
  assert.equal(t.aadt, 1219);
  assert.equal(t.year, 2024);
  assert.equal(t.fromYear, 2014);
  assert.ok(Math.abs(t.cagr - 2.0) < 0.05, `cagr ${t.cagr}`);
});

test('ArcGIS "<Null>" never reaches the page; MultiPoint stations have a centre', () => {
  assert.equal(clean('<Null>'), '');
  assert.equal(clean(' 2245 '), '2245');
  assert.equal(bylawText([{ feature: { properties: { ZBL: '2245', ZBL_A: '<Null>' } } }]), '2245');
  assert.deepEqual(centreOf({ type: 'MultiPoint', coordinates: [[-96.7, 49.5]] }), { lon: -96.7, lat: 49.5 });
});

test('report URL carries muni and roll', () => {
  assert.equal(reportUrl('PINEY (RM)', '123.000'), './report.html?muni=PINEY+%28RM%29&roll=123.000');
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
