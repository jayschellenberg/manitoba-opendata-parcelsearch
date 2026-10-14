// lib/addendaZoning.js — the Addenda Pack zoning map's frame width and
// top-left label.
//
// Run: cd web && node test/addendaZoning.test.js

import assert from 'node:assert/strict';
import {
  zoningMinWidthM, zoningBylawDate, formatBylawDate, addendaZoningLabelText,
} from '../src/lib/addendaZoning.js';
import { ZONING_BYLAW_DATES } from '../src/lib/zoningBylawDates.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

test('frame: under 1 acre is 750 m, 1-5 acres 1 km, larger 1.5 km', () => {
  assert.equal(zoningMinWidthM(0.2), 750);
  assert.equal(zoningMinWidthM(0.99), 750);
  assert.equal(zoningMinWidthM(1), 1000);
  assert.equal(zoningMinWidthM(4.9), 1000);
  assert.equal(zoningMinWidthM(5), 1500);
  assert.equal(zoningMinWidthM(160), 1500);
});

test('frame: unreadable area falls back to the full 1.5 km', () => {
  assert.equal(zoningMinWidthM(null), 1500);
  assert.equal(zoningMinWidthM(NaN), 1500);
});

test('date lookup: muni-qualified key wins over the bare number', () => {
  const table = { '2022-09': '2022-05-10', '2022-09|Gilbert Plains': '2022-11-01' };
  assert.equal(zoningBylawDate({ ZBL: '2022-09', MUNI_NAME: 'Gilbert Plains' }, table), '2022-11-01');
  assert.equal(zoningBylawDate({ ZBL: '2022-09', MUNI_NAME: 'Louise' }, table), '2022-05-10');
  assert.equal(zoningBylawDate({ ZBL: ' 2022-09 ' }, table), '2022-05-10');
});

test('date lookup: unknown or null-ish by-law gives null', () => {
  assert.equal(zoningBylawDate({ ZBL: '99-9999' }, {}), null);
  assert.equal(zoningBylawDate({ ZBL: '<Null>' }, { '<Null>': '2020-01-01' }), null);
  assert.equal(zoningBylawDate({}), null);
});

test('every table date is a real YYYY-MM-DD', () => {
  for (const [k, v] of Object.entries(ZONING_BYLAW_DATES)) {
    assert.ok(formatBylawDate(v), `${k}: ${v}`);
    assert.ok(v >= '1950-01-01' && v <= '2027-12-31', `${k}: ${v}`);
  }
});

test('formatBylawDate', () => {
  assert.equal(formatBylawDate('2019-03-04'), 'March 4, 2019');
  assert.equal(formatBylawDate('2019-13-04'), null);
  assert.equal(formatBylawDate('March 2019'), null);
  assert.equal(formatBylawDate(null), null);
});

test('label: municipality, by-law and date', () => {
  assert.equal(addendaZoningLabelText({ muni: 'Rural Municipality of Piney', bylaw: '7-2019', date: '2019-03-04' }),
    'Zoning Map — Rural Municipality of Piney By-law 7-2019 (effective March 4, 2019)');
});

test('label: no date known', () => {
  assert.equal(addendaZoningLabelText({ muni: 'Town of Carman', bylaw: '04/2014' }),
    'Zoning Map — Town of Carman By-law 04/2014');
});

test('label: number that already says By-law is not doubled', () => {
  assert.equal(addendaZoningLabelText({ muni: 'City of Brandon', bylaw: 'By-law No. 7124' }),
    'Zoning Map — City of Brandon By-law No. 7124');
});

test('label: parts drop out down to plain "Zoning Map"', () => {
  assert.equal(addendaZoningLabelText({ bylaw: '7-2019', date: '2019-03-04' }),
    'Zoning Map — By-law 7-2019 (effective March 4, 2019)');
  assert.equal(addendaZoningLabelText({ muni: 'Town of Carman' }), 'Zoning Map — Town of Carman');
  assert.equal(addendaZoningLabelText({ muni: 'Town of Carman', date: '2019-03-04' }), 'Zoning Map — Town of Carman');
  assert.equal(addendaZoningLabelText({}), 'Zoning Map');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
