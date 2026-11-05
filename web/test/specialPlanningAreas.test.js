// lib/specialPlanningAreas.js — CentrePort (Inland Port SPA, M.R. 48/2016)
// recognised in the zoning / dev-plan layers, and the text it gets.
//
// Run: cd web && node test/specialPlanningAreas.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  specialPlanningArea, spaBylawLine, spaLongName, bylawCellText, spaInBounds, spaPopupHtml,
} from '../src/lib/specialPlanningAreas.js';
import { zoningBylawText, devPlanBylawText } from '../src/lib/amendment.js';
import { addendaZoningLabelText, addendaSpaLabelText } from '../src/lib/addendaZoning.js';
import { readMapLegends } from '../src/lib/mapLegend.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// As the province's zoning layer publishes them (2026-11-05).
const cpZone = { MUNI_NAME: 'Rosser', ZBL: '48/2016', ZBL_A: '10/2021', ZONE: 'I2',
  PLANNINGDISTRICT: 'Inland Port Special Planning Area', AMENDMENT_DESCRIPTION: 'IPR to I2' };
const cpPadded = { MUNI_NAME: 'Rosser', ZBL: ' 48/2016', ZBL_A: '1-23', PLANNINGDISTRICT: null };
const rosser = { MUNI_NAME: 'Rosser', ZBL: '4-21', ZBL_A: '<Null>', PLANNINGDISTRICT: 'Rosser' };
const cpDevPlan = { DP_BYLAW: '48/2016', DPA_BYLAW: null, PLANNINGDISTRICT: 'INLAND PORT SPECIAL PLANNING AREA' };

test('CentrePort zoning polygon is the Inland Port SPA', () => {
  assert.equal(specialPlanningArea(cpZone)?.regulation, '48/2016');
});

test('the " 48/2016" variant with no district still matches', () => {
  assert.equal(specialPlanningArea(cpPadded)?.key, 'inland-port');
});

test('upper-case dev-plan district matches', () => {
  assert.equal(specialPlanningArea(cpDevPlan)?.key, 'inland-port');
});

test("Rosser's own by-law is not a special planning area", () => {
  assert.equal(specialPlanningArea(rosser), null);
  assert.equal(specialPlanningArea({}), null);
});

test('popup by-law line names the regulation', () => {
  assert.equal(zoningBylawText(cpZone).bylaw, 'M.R. 48/2016 (CentrePort SPA)');
  assert.equal(zoningBylawText(cpZone).amendment, 'Amended by 10/2021 (IPR to I2)');
  assert.equal(devPlanBylawText(cpDevPlan).bylaw, 'M.R. 48/2016 (CentrePort SPA)');
  assert.equal(zoningBylawText(rosser).bylaw, 'By-law 4-21');
});

test('grid / CSV cell', () => {
  assert.equal(bylawCellText(cpZone, 'ZBL'), 'M.R. 48/2016 (CentrePort SPA)');
  assert.equal(bylawCellText(cpPadded, 'ZBL'), 'M.R. 48/2016 (CentrePort SPA)');
  assert.equal(bylawCellText(cpDevPlan, 'DP_BYLAW'), 'M.R. 48/2016 (CentrePort SPA)');
  assert.equal(bylawCellText(rosser, 'ZBL'), '4-21');
  assert.equal(bylawCellText(undefined, 'ZBL'), null);
  assert.equal(bylawCellText({ ZBL: '<Null>' }, 'ZBL'), null);
});

test('Addenda label: regulation, registration date, amendment', () => {
  const spa = specialPlanningArea(cpZone);
  assert.equal(addendaZoningLabelText({ muni: 'Rural Municipality of Rosser', bylaw: '48/2016', spa, amendedBy: '10/2021' }),
    'Zoning Map — Inland Port Special Planning Area (CentrePort), Manitoba Regulation 48/2016 '
    + '(registered March 8, 2016), as amended by 10/2021');
});

test('Addenda label: no amendment when ZBL_A is empty or the regulation itself', () => {
  const spa = specialPlanningArea(cpZone);
  const plain = 'Zoning Map — Inland Port Special Planning Area (CentrePort), Manitoba Regulation 48/2016 (registered March 8, 2016)';
  assert.equal(addendaSpaLabelText(spa, null), plain);
  assert.equal(addendaSpaLabelText(spa, '<Null>'), plain);
  assert.equal(addendaSpaLabelText(spa, '48/2016'), plain);
});

test('Addenda label outside an SPA is unchanged', () => {
  assert.equal(addendaZoningLabelText({ muni: 'Rural Municipality of Rosser', bylaw: '4-21', date: '2021-07-13' }),
    'Zoning Map — Rural Municipality of Rosser By-law 4-21 (effective July 13, 2021)');
});

test('long name', () => {
  assert.equal(spaLongName(specialPlanningArea(cpZone)),
    'Inland Port Special Planning Area (CentrePort), Manitoba Regulation 48/2016');
  assert.equal(spaBylawLine(null), null);
});

test('the built boundary file is CentrePort, in Rosser', () => {
  const fc = JSON.parse(readFileSync(new URL('../public/special-planning-areas.geojson', import.meta.url), 'utf8'));
  assert.equal(fc.features.length, 1);
  const p = fc.features[0].properties;
  assert.equal(specialPlanningArea({ PLANNINGDISTRICT: p.district, ZBL: p.regulation })?.key, 'inland-port');
  assert.equal(p.muni, 'Rosser');
  // A frame on CentrePort Canada Way near Hwy 101 overlaps; one on Selkirk does not.
  assert.equal(spaInBounds(fc, [[-97.33, 49.93], [-97.30, 49.95]]), true);
  assert.equal(spaInBounds(fc, [-96.90, 50.13, -96.86, 50.16]), false);
  assert.equal(spaInBounds(fc, null), false);
});

test('popup escapes and names the regulation', () => {
  const html = spaPopupHtml({ district: 'Inland Port Special Planning Area', regulation: '48/2016', muni: 'Rosser' });
  assert.match(html, /Inland Port Special Planning Area \(CentrePort\)/);
  assert.match(html, /Manitoba Regulation 48\/2016/);
  assert.doesNotMatch(spaPopupHtml({ district: '<b>x</b>' }), /<b>x/);
});

test('legend: a data-line swatch reads its border colour and keeps the line style', () => {
  const sw = { dataset: { line: 'dashed' } };
  const li = { querySelector: () => sw, textContent: ' Inland Port SPA (CentrePort), M.R. 48/2016 ' };
  const el = { hidden: false, offsetParent: {}, querySelector: () => ({ textContent: 'Special planning area' }),
    querySelectorAll: () => [li] };
  const root = { querySelectorAll: () => [el] };
  const out = readMapLegends(root, { getComputedStyle: () => ({ borderTopColor: 'rgb(109, 40, 217)', backgroundColor: 'rgba(0, 0, 0, 0)' }) });
  assert.deepEqual(out, [{ title: 'Special planning area',
    items: [{ color: 'rgb(109, 40, 217)', label: 'Inland Port SPA (CentrePort), M.R. 48/2016', line: 'dashed' }] }]);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
