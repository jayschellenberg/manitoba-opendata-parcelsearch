// Tests for the derived legal-token layer in legalIndex.core.js — the
// condo / parish-lot / section-township-range searches that mirror
// MAO's structured search rows. Every legal_description / legal_detail
// string here is a real (truncated) value from the 2026-08 archive, so
// the derivations are exercised against the shapes they must survive
// in production.
//
// Run: cd web && node test/legalIndexDerived.test.js

import assert from 'node:assert/strict';
import {
  deriveCondoTokens,
  deriveParishTokens,
  deriveStrTokens,
  condoSearchNeedle,
  parishSearchNeedle,
  strSearchNeedle,
  hasLegalCriteria,
  searchLegalIndex,
  listParishOptions,
  PARISH_NAMES,
  PARISH_LOT_TYPES,
} from '../src/legalIndex.core.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log('deriveCondoTokens');

test('classic condo: reversed plan-unit pair in the detail', () => {
  assert.equal(
    deriveCondoTokens('DESC 1-38239', '38239-1 TOGETHER WITH AN UNDIVIDED 22.7423% INTEREST'),
    ';38239|1;'
  );
});

test('parcel-plan double dash is NOT a condo', () => {
  assert.equal(deriveCondoTokens('1-1116', '1--1116 ORG NE-33-14-29-W'), '');
  assert.equal(deriveCondoTokens('DESC --58418', '--58418 PUBLIC RESERVE ORG SL-4-MH-0'), '');
});

test('unit range in the description expands against the detail plan', () => {
  const toks = deriveCondoTokens('DESC 1/8-39000', '39000-1 TOGETHER WITH AN UNDIVIDED 12.5% INTEREST');
  for (let u = 1; u <= 8; u++) assert.ok(toks.includes(`;39000|${u};`), `unit ${u}`);
});

test('unit range glued into the detail itself expands', () => {
  const toks = deriveCondoTokens('DESC 1/10-41827', '41827-1/10 3-P-2 4-P-2 ORG RL-4-AG');
  assert.ok(toks.includes(';41827|1;'));
  assert.ok(toks.includes(';41827|10;'));
  assert.ok(!toks.includes(';41827|11;'));
});

test('multiple leading pairs with the same plan all count', () => {
  const toks = deriveCondoTokens('21&30-27691', '27691-21 27691-30 ORG 2--27491 ORG SW-05-13-08-E');
  assert.ok(toks.includes(';27691|21;'));
  assert.ok(toks.includes(';27691|30;'));
});

test('a mismatched description plan is ignored', () => {
  // Description says plan 99999 but the detail is plan 38239 — only
  // the detail is trusted.
  const toks = deriveCondoTokens('DESC 1/8-99999', '38239-1 TOGETHER WITH');
  assert.equal(toks, ';38239|1;');
});

console.log('deriveParishTokens');

test('canonical detail codes parse: type, lot, parish, plan', () => {
  const toks = deriveParishTokens('DESC RL45/51-BP-626',
    'RL-45-BP-626 RL-46-BP-626 RL-47-BP-626 RL-48-BP-626 RL-49-BP-626 EX RD 658');
  assert.ok(toks.includes(';RL|45|BP|626;'));
  assert.ok(toks.includes(';RL|49|BP|626;'));
  // The description range fills lots the truncated detail dropped.
  assert.ok(toks.includes(';RL|51|BP|626;'));
});

test('missing dash after the type still parses (IT65-FX-5066)', () => {
  const toks = deriveParishTokens('DESC IT65-FX-5066', 'RL-65-FX-5066 ALL THAT PORTION');
  assert.ok(toks.includes(';IT|65|FX|5066;'));
  assert.ok(toks.includes(';RL|65|FX|5066;'));
});

test('plan-less codes parse with an empty plan slot', () => {
  const toks = deriveParishTokens('', '41827-1/10 ORG RL-4-AG ORG RL-5-AG');
  assert.ok(toks.includes(';RL|4|AG|;'));
  assert.ok(toks.includes(';RL|5|AG|;'));
});

test('township river lots are NOT parish tokens', () => {
  // RL-03-22-02-E has a numeric third part — that's the STR family.
  assert.equal(deriveParishTokens('', 'RL-03-22-02-E ALL THAT PORTION'), '');
});

test('zero-stripping makes 04 and 4 the same lot and plan', () => {
  const toks = deriveParishTokens('', 'OT-057-AD-0626');
  assert.ok(toks.includes(';OT|57|AD|626;'));
});

console.log('deriveStrTokens');

test('canonical detail tokens parse with zero-stripping', () => {
  assert.equal(deriveStrTokens('NE1-13-28W', 'NE-01-13-28-W'), ';NE|1|13|28|W;');
});

test('township river lots carry lot suffixes (RL-7E-23-04-E)', () => {
  const toks = deriveStrTokens('DESC RL7E0&8E0-23-4E',
    'RL-7E-23-04-E ALL THAT PORTION OF RIVER LOT 7 EAST OF THE ICELANDIC RIVER');
  assert.ok(toks.includes(';RL|7E|23|4|E;'));
  // Compact description &-list: each entry gets a token.
  assert.ok(toks.includes(';RL|7E0|23|4|E;'));
  assert.ok(toks.includes(';RL|8E0|23|4|E;'));
});

test('multiple quarters in one row all tokenize', () => {
  const toks = deriveStrTokens('DESC NW25-15-28W',
    'NW-25-15-28-W PORTIONS OF 24&25-15-28W COMM AT NE ANGLE ORG SE-24-15-28-W');
  assert.ok(toks.includes(';NW|25|15|28|W;'));
  assert.ok(toks.includes(';SE|24|15|28|W;'));
});

test('parish codes are NOT STR tokens', () => {
  assert.equal(deriveStrTokens('DESC RL5-PQ-4734', 'RL-5-PQ-4734 NE 1/2'), '');
});

console.log('needles');

test('condo needle: plan only, unit only, both', () => {
  assert.ok(condoSearchNeedle({ condoPlan: '38239' }).test(';38239|1;'));
  assert.ok(condoSearchNeedle({ condoUnit: '1' }).test(';38239|1;'));
  assert.ok(condoSearchNeedle({ condoPlan: '38239', condoUnit: '1' }).test(';38239|1;'));
  assert.ok(!condoSearchNeedle({ condoPlan: '38239', condoUnit: '2' }).test(';38239|1;'));
  // Unit 1 must not match unit 11 or plan suffixes.
  assert.ok(!condoSearchNeedle({ condoUnit: '1' }).test(';38239|11;'));
  assert.equal(condoSearchNeedle({}), null);
});

test('parish needle: any subset of the four fields works', () => {
  const tok = ';RL|65|FX|5066;';
  assert.ok(parishSearchNeedle({ parish: 'FX' }).test(tok));
  assert.ok(parishSearchNeedle({ parishLotType: 'RL' }).test(tok));
  assert.ok(parishSearchNeedle({ parishLot: '65' }).test(tok));
  assert.ok(parishSearchNeedle({ parishLot: '065' }).test(tok));  // zero-stripped
  assert.ok(parishSearchNeedle({ parishPlan: '5066' }).test(tok));
  assert.ok(parishSearchNeedle({ parish: 'FX', parishLotType: 'RL', parishLot: '65', parishPlan: '5066' }).test(tok));
  assert.ok(!parishSearchNeedle({ parish: 'BP' }).test(tok));
  assert.ok(!parishSearchNeedle({ parishLot: '6' }).test(tok));
  assert.equal(parishSearchNeedle({}), null);
});

test('str needle: bare range matches both meridians, suffixed does not', () => {
  const west = ';NE|1|13|28|W;';
  const east = ';NE|1|13|28|E;';
  assert.ok(strSearchNeedle({ strRange: '28' }).test(west));
  assert.ok(strSearchNeedle({ strRange: '28' }).test(east));
  assert.ok(strSearchNeedle({ strRange: '28W' }).test(west));
  assert.ok(!strSearchNeedle({ strRange: '28W' }).test(east));
  assert.ok(strSearchNeedle({ strSection: '1', strTownship: '13', strRange: '28W', strQuarter: 'NE' }).test(west));
  assert.ok(!strSearchNeedle({ strQuarter: 'SW' }).test(west));
  // Garbage in the range box matches nothing rather than everything.
  assert.ok(!strSearchNeedle({ strRange: 'abc' }).test(west));
  assert.equal(strSearchNeedle({}), null);
});

console.log('hasLegalCriteria');

test('each new field lights the legal-search path', () => {
  for (const key of ['condoPlan', 'condoUnit', 'parish', 'parishLotType', 'parishLot',
    'parishPlan', 'strSection', 'strTownship', 'strRange', 'strQuarter']) {
    assert.ok(hasLegalCriteria({ [key]: 'x' }), key);
  }
  assert.ok(!hasLegalCriteria({}));
});

console.log('searchLegalIndex integration');

// Rows in FIELD order: muni_no, roll_no_txt, extrct_prop_id,
// municipality, civic_address, legal_description, legal_detail, lot,
// block, plan, certificates_of_title, source_url.
function row(muni, roll, des, det) {
  return [muni, roll, '', `RM OF TEST`, '', des, det, '', '', '', '', ''];
}
const INDEX = {
  rows: [
    row(101, '100.000', 'DESC 1-38239', '38239-1 TOGETHER WITH AN UNDIVIDED 22% INTEREST'),
    row(101, '200.000', 'NE1-13-28W', 'NE-01-13-28-W'),
    row(102, '300.000', 'DESC RL45/51-BP-626', 'RL-45-BP-626 RL-46-BP-626 EX RD 658'),
    row(102, '400.000', '1-1116', '1--1116 ORG NE-33-14-29-W'),
    row(103, '500.000', 'DESC IT65-FX-5066', 'RL-65-FX-5066 ALL THAT PORTION'),
  ],
  metadata: null,
};

test('condo search finds the condo, not the parcel-plan row', () => {
  const { matches } = searchLegalIndex(INDEX, { condoPlan: '38239' });
  assert.deepEqual(matches.map((m) => m.roll_no_txt), ['100.000']);
  const none = searchLegalIndex(INDEX, { condoPlan: '1116' });
  assert.equal(none.matches.length, 0);
});

test('str search matches derived tokens across both text fields', () => {
  const { matches } = searchLegalIndex(INDEX, { strSection: '1', strTownship: '13', strRange: '28W' });
  assert.deepEqual(matches.map((m) => m.roll_no_txt), ['200.000']);
  // The parcel-plan row's ORG NE-33-14-29-W is searchable too.
  const org = searchLegalIndex(INDEX, { strSection: '33', strTownship: '14', strRange: '29' });
  assert.deepEqual(org.matches.map((m) => m.roll_no_txt), ['400.000']);
});

test('parish search: range-expanded lots and criteria AND together', () => {
  const { matches } = searchLegalIndex(INDEX, { parish: 'BP', parishLot: '51' });
  assert.deepEqual(matches.map((m) => m.roll_no_txt), ['300.000']);
  const both = searchLegalIndex(INDEX, { parishLotType: 'RL' });
  assert.deepEqual(both.matches.map((m) => m.roll_no_txt), ['300.000', '500.000']);
});

test('listParishOptions is data-derived, named, counted, sorted', () => {
  const opts = listParishOptions(INDEX);
  assert.deepEqual(opts, [
    { code: 'BP', name: 'BAIE ST PAUL', count: 1 },
    { code: 'FX', name: 'ST FRANCOIS XAVIER', count: 1 },
  ]);
});

test('lot-type vocabulary covers every code the derivations emit', () => {
  const codes = PARISH_LOT_TYPES.map((t) => t.code).sort();
  assert.deepEqual(codes, ['IT', 'OT', 'PK', 'PL', 'RL', 'SL', 'WL']);
  assert.ok(PARISH_NAMES.FX);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
