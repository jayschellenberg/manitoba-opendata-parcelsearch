// lib/amendment.js — the by-law / amendment text the zoning and dev-plan
// hover tooltips and click popups show.
//
// Run: cd web && node test/amendment.test.js

import assert from 'node:assert/strict';
import { zoningBylawText, devPlanBylawText } from '../src/lib/amendment.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

test('zoning: amended by a different by-law with a description', () => {
  assert.deepEqual(zoningBylawText({ ZBL: '08-2023', ZBL_A: '19-2023', AMENDMENT_DESCRIPTION: 'AG to CH' }),
    { base: '08-2023', bylaw: 'By-law 08-2023', amendment: 'Amended by 19-2023 (AG to CH)' });
});

test('zoning: amended by a different by-law, no description', () => {
  assert.deepEqual(zoningBylawText({ ZBL: '3-2011', ZBL_A: '3-2018' }),
    { base: '3-2011', bylaw: 'By-law 3-2011', amendment: 'Amended by 3-2018' });
});

test('zoning: description only (ZBL_A equals ZBL) still reads as amended', () => {
  assert.deepEqual(zoningBylawText({ ZBL: '7124', ZBL_A: '7124', AMENDMENT_DESCRIPTION: 'DR to OS' }),
    { base: '7124', bylaw: 'By-law 7124', amendment: 'Amended (DR to OS)' });
});

test('zoning: unamended polygon shows only the base by-law', () => {
  assert.deepEqual(zoningBylawText({ ZBL: '7124', ZBL_A: '7124' }),
    { base: '7124', bylaw: 'By-law 7124', amendment: null });
  assert.deepEqual(zoningBylawText({ ZBL: '7124' }),
    { base: '7124', bylaw: 'By-law 7124', amendment: null });
});

test('zoning: null sentinels are not amendments', () => {
  for (const v of [null, undefined, '', ' ', '<Null>', 'null']) {
    assert.deepEqual(zoningBylawText({ ZBL: '7124', ZBL_A: v, AMENDMENT_DESCRIPTION: v }),
      { base: '7124', bylaw: 'By-law 7124', amendment: null }, `sentinel ${JSON.stringify(v)}`);
  }
});

test('zoning: amending by-law without a parent by-law', () => {
  assert.deepEqual(zoningBylawText({ ZBL: '<Null>', ZBL_A: '91', AMENDMENT_DESCRIPTION: 'I to SR' }),
    { base: null, bylaw: null, amendment: 'Amended by 91 (I to SR)' });
});

test('zoning: values are trimmed', () => {
  assert.deepEqual(zoningBylawText({ ZBL: ' 9-2019 ', ZBL_A: ' 12-2022 ', AMENDMENT_DESCRIPTION: ' RG8 to RG5 ' }),
    { base: '9-2019', bylaw: 'By-law 9-2019', amendment: 'Amended by 12-2022 (RG8 to RG5)' });
});

test('zoning: empty input', () => {
  assert.deepEqual(zoningBylawText({}), { base: null, bylaw: null, amendment: null });
  assert.deepEqual(zoningBylawText(), { base: null, bylaw: null, amendment: null });
});

test('dev plan: amended by a different by-law', () => {
  assert.deepEqual(devPlanBylawText({ DP_BYLAW: '18-09', DPA_BYLAW: '21-07' }),
    { base: '18-09', bylaw: 'By-law 18-09', amendment: 'Amended by 21-07' });
});

test('dev plan: unamended', () => {
  assert.deepEqual(devPlanBylawText({ DP_BYLAW: '7392', DPA_BYLAW: '7392' }),
    { base: '7392', bylaw: 'By-law 7392', amendment: null });
  assert.deepEqual(devPlanBylawText({ DP_BYLAW: '7392', DPA_BYLAW: '<Null>' }),
    { base: '7392', bylaw: 'By-law 7392', amendment: null });
  assert.deepEqual(devPlanBylawText({}), { base: null, bylaw: null, amendment: null });
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
