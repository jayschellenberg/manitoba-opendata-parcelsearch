// Unit tests for legalIndex.core.js + assessmentIndex.core.js.
//
// Both modules are pure (no I/O, no module state), so we can test
// the entire matching surface in node without any worker shim. The
// main-thread fallback path in legalIndex.js / assessmentIndex.js
// runs these exact same functions, so passing here means the
// fallback works identically.
//
// Run: cd web && node test/indexes.test.js

import assert from 'node:assert/strict';
import {
  hasLegalCriteria,
  legalRecordKey,
  parcelLegalKey,
  parseLegalIndex,
  searchLegalIndex,
  lookupLegalRecordsByParcelKeys,
} from '../src/legalIndex.core.js';
import {
  parseAssessmentIndex,
  lookupAssessment,
  isVacantLand,
  VACANT_BUILDING_PCT,
} from '../src/assessmentIndex.core.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

// ---------- Fixtures ----------

// Legal-index fixture mimicking the real packed-row shape:
// [muni_no, roll_no_txt, extrct_prop_id, municipality, civic_address,
//  legal_description, legal_detail, lot, block, plan,
//  certificates_of_title, source_url]
const LEGAL_FIXTURE = {
  rows: [
    [600, '12345.000', 'P1', '600 - RM OF HEADINGLEY', '123 MAIN ST', 'LOT 2 PLAN 71948', 'Lot 2 Plan 71948 District 14', '2', '', '71948', '2476500', 'https://example.test/p1'],
    [600, '12346.000', 'P2', '600 - RM OF HEADINGLEY', '125 MAIN ST', 'LOT 3 PLAN 71948', 'Lot 3 Plan 71948 District 14', '3', '', '71948', '2476501', 'https://example.test/p2'],
    [700, '99000.000', 'P3', '700 - CITY OF WINKLER', 'DESC NE34-2-4W',  'NE 34-2-4W', 'NE-34-02-04-W', '', '', '', '1234567', 'https://example.test/p3'],
    [800, '88000.000', 'P4', '800 - RM OF DE SALABERRY', '203 MACAIRE AVE S', 'Parcel 4--66600', '', '4', '', '66600', '7777777', 'https://example.test/p4'],
  ],
  metadata: { generated_at: '2026-05-05T00:00:00Z', row_count: 4, source: 'fixture' },
};

const ASSESSMENT_FIXTURE = {
  rows: [
    // [muni_no, roll_no_txt, year, land, buildings, total, class, tax_status]
    [600, '12345.000', 2026, 50000, 0,      50000,  'FARM PROPERTY',    'TAXABLE'],
    [600, '12346.000', 2026, 80000, 320000, 400000, 'RESIDENTIAL 1',    'TAXABLE'],
    [700, '99000.000', 2026, 30000, 5000,   35000,  'OTHER PROPERTY',   'EXEMPT'],
    [800, '88000.000', 2026, 12000, 0,      12000,  'FARM PROPERTY',    'TAXABLE'],
    [900, '77000.000', 2026, 0,     0,      0,      'EXEMPT PROPERTY',  'EXEMPT'],   // zero-total: never vacant
  ],
  metadata: { generated_at: '2026-05-11T00:00:00Z', row_count: 5, vacant_threshold_pct: 2 },
};

// ---------- legalIndex.core tests ----------

console.log('legalIndex.core.js tests');

await test('parseLegalIndex — returns rows + metadata', () => {
  const idx = parseLegalIndex(LEGAL_FIXTURE);
  assert.equal(idx.rows.length, 4);
  assert.equal(idx.metadata.row_count, 4);
});

await test('parseLegalIndex — throws on malformed input', () => {
  assert.throws(() => parseLegalIndex({}), /malformed/);
  assert.throws(() => parseLegalIndex({ rows: 'nope' }), /malformed/);
});

await test('hasLegalCriteria — true when any field is set', () => {
  assert.equal(hasLegalCriteria({}), false);
  assert.equal(hasLegalCriteria({ legalText: '' }), false);
  assert.equal(hasLegalCriteria({ legalText: 'lot 5' }), true);
  assert.equal(hasLegalCriteria({ plan: '24208' }), true);
  assert.equal(hasLegalCriteria({ title: '2476500' }), true);
});

await test('legalRecordKey + parcelLegalKey produce matching keys', () => {
  const idx = parseLegalIndex(LEGAL_FIXTURE);
  // rowToRecord isn't exported, but searchLegalIndex returns the
  // friendly objects we can key off.
  const matches = searchLegalIndex(idx, { plan: '71948' });
  for (const rec of matches.matches) {
    const k = legalRecordKey(rec);
    assert.ok(k && /^\d+\|\d+\.\d{3}$/.test(k), `expected key format, got ${k}`);
  }
  // parcelLegalKey computes the same key from Roll_Entry-style
  // properties — verify it matches.
  const pk = parcelLegalKey({ Municipality: '600 - RM OF HEADINGLEY', Roll_No_Txt: '12345.000' });
  assert.equal(pk, '600|12345.000');
});

await test('searchLegalIndex — plan match (exact + substring fallback)', () => {
  const idx = parseLegalIndex(LEGAL_FIXTURE);
  // Plan 71948 — should hit the two Headingley rows.
  const exact = searchLegalIndex(idx, { plan: '71948' });
  assert.equal(exact.matches.length, 2);
  // Plan 66600 — should hit the De Salaberry row via plan field.
  const desal = searchLegalIndex(idx, { plan: '66600' });
  assert.equal(desal.matches.length, 1);
  assert.equal(desal.matches[0].muni_no, 800);
});

await test('searchLegalIndex — legal-text free search with section-twp-range', () => {
  const idx = parseLegalIndex(LEGAL_FIXTURE);
  // Should match the Winkler row (legal_detail "NE-34-02-04-W").
  const a = searchLegalIndex(idx, { legalText: 'NE 34-2-4W' });
  assert.equal(a.matches.length, 1);
  assert.equal(a.matches[0].muni_no, 700);
  // Normalization: "04-W" / "4W" / "4-W" all map to the same form.
  const b = searchLegalIndex(idx, { legalText: 'NE-34-02-04-W' });
  assert.equal(b.matches.length, 1);
});

await test('searchLegalIndex — title (CT) match strips prefixes', () => {
  const idx = parseLegalIndex(LEGAL_FIXTURE);
  const a = searchLegalIndex(idx, { title: '2476500' });
  assert.equal(a.matches.length, 1);
  const b = searchLegalIndex(idx, { title: 'CT 2476500' });
  assert.equal(b.matches.length, 1);
});

await test('searchLegalIndex — no criteria returns empty', () => {
  const idx = parseLegalIndex(LEGAL_FIXTURE);
  const r = searchLegalIndex(idx, {});
  assert.deepEqual(r.matches, []);
  assert.equal(r.truncated, false);
});

await test('lookupLegalRecordsByParcelKeys — resolves multiple keys', () => {
  const idx = parseLegalIndex(LEGAL_FIXTURE);
  const recs = lookupLegalRecordsByParcelKeys(idx, ['600|12345.000', '800|88000.000']);
  assert.equal(recs.length, 2);
  assert.ok(recs.some((r) => r.muni_no === 600 && r.roll_no_txt === '12345.000'));
  assert.ok(recs.some((r) => r.muni_no === 800 && r.roll_no_txt === '88000.000'));
});

await test('lookupLegalRecordsByParcelKeys — empty input returns []', () => {
  const idx = parseLegalIndex(LEGAL_FIXTURE);
  assert.deepEqual(lookupLegalRecordsByParcelKeys(idx, []), []);
});

// ---------- assessmentIndex.core tests ----------

console.log('\nassessmentIndex.core.js tests');

await test('parseAssessmentIndex — builds key→row map', () => {
  const p = parseAssessmentIndex(ASSESSMENT_FIXTURE);
  assert.equal(p.map.size, 5);
  assert.ok(p.map.has('600|12345.000'));
  assert.equal(p.metadata.row_count, 5);
});

await test('parseAssessmentIndex — throws on malformed input', () => {
  assert.throws(() => parseAssessmentIndex({}), /malformed/);
});

await test('lookupAssessment — returns friendly record for hit', () => {
  const p = parseAssessmentIndex(ASSESSMENT_FIXTURE);
  const rec = lookupAssessment(p, { muni_no: 600, roll_no_txt: '12346.000' });
  assert.equal(rec.land, 80000);
  assert.equal(rec.buildings, 320000);
  assert.equal(rec.total, 400000);
  assert.equal(rec.pctBuildings, 320000 / 400000);
  assert.equal(rec.class, 'RESIDENTIAL 1');
});

await test('lookupAssessment — null when key missing', () => {
  const p = parseAssessmentIndex(ASSESSMENT_FIXTURE);
  assert.equal(lookupAssessment(p, { muni_no: 600, roll_no_txt: 'nope' }), null);
  assert.equal(lookupAssessment(p, {}), null);
  assert.equal(lookupAssessment(p, null), null);
});

await test('isVacantLand — flags low-building parcels', () => {
  const p = parseAssessmentIndex(ASSESSMENT_FIXTURE);
  const r1 = lookupAssessment(p, { muni_no: 600, roll_no_txt: '12345.000' }); // 0 buildings
  const r2 = lookupAssessment(p, { muni_no: 600, roll_no_txt: '12346.000' }); // 80% buildings
  const r3 = lookupAssessment(p, { muni_no: 800, roll_no_txt: '88000.000' }); // 0 buildings, farm
  const r4 = lookupAssessment(p, { muni_no: 900, roll_no_txt: '77000.000' }); // zero-total
  assert.equal(isVacantLand(r1), true);
  assert.equal(isVacantLand(r2), false);
  assert.equal(isVacantLand(r3), true);
  assert.equal(isVacantLand(r4), false);  // zero-total parcels never count
});

await test('VACANT_BUILDING_PCT is the 2% threshold', () => {
  assert.equal(VACANT_BUILDING_PCT, 0.02);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
