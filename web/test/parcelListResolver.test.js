// Unit tests for parcelListResolver.js. The resolver is dependency-
// injected with a lookupRollSet function so node tests can pass an
// in-memory synthetic legal index without going through the worker /
// fetch path. Run: cd web && node test/parcelListResolver.test.js

import assert from 'node:assert/strict';
import { resolveParcelList } from '../src/parcelListResolver.js';
import { lookupLegalRecordsByRollSet } from '../src/legalIndex.core.js';
import { parseLegalToken } from '../src/lib/parcelListParser.js';

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

// ---- synthetic legal index --------------------------------------
//
// rowToRecord field order (from legalIndex.core.js):
//   [muni_no, roll_no_txt, extrct_prop_id, municipality, civic_address,
//    legal_description, legal_detail, lot, block, plan,
//    certificates_of_title, source_url]

function row(opts) {
  return [
    opts.muni_no,
    opts.roll_no_txt,
    opts.extrct_prop_id || '',
    opts.municipality || '',
    opts.civic_address || '',
    opts.legal_description || '',
    opts.legal_detail || '',
    opts.lot || '',
    opts.block || '',
    opts.plan || '',
    opts.certificates_of_title || '',
    opts.source_url || '',
  ];
}

// A handful of records spanning two munis with overlapping rolls so
// the resolver actually has to disambiguate. Mirrors realistic MAO
// data: leading roll like "218600.000" canonical form, legal_description
// carrying the grid reference, lot/block/plan filled for subdivision
// parcels.
// Legal-description format is the MAO scrape's short form
// ("NW26-2-13E"), exactly what the user pastes from their spreadsheet
// — both sides normalize identically through normalizeLegalText().
const FIXTURE = {
  metadata: { generated_at: 'test' },
  rows: [
    row({ muni_no: 275, roll_no_txt: '218600.000', municipality: 'STANLEY (RM)',
          legal_description: 'NW26-2-13E', legal_detail: 'NW-26-2-13-E',
          certificates_of_title: '2476500' }),
    row({ muni_no: 275, roll_no_txt: '219000.000', municipality: 'STANLEY (RM)',
          legal_description: 'NW27-2-13E', legal_detail: 'NW-27-2-13-E',
          certificates_of_title: '2476510' }),
    row({ muni_no: 275, roll_no_txt: '218900.000', municipality: 'STANLEY (RM)',
          legal_description: 'NE27-2-13E', legal_detail: 'NE-27-2-13-E',
          certificates_of_title: '2476520' }),
    // Another muni with a COLLIDING roll number — same roll, different muni.
    // This is the cross-muni ambiguity the resolver must handle: roll # alone
    // can't disambiguate; needs a legal or muni# to pick.
    row({ muni_no: 410, roll_no_txt: '218600.000', municipality: 'MORDEN (CITY)',
          legal_description: 'LOT 5 BLOCK 2 PLAN 31654',
          lot: '5', block: '2', plan: '31654',
          certificates_of_title: '3001234' }),
    // LBP-style record for testing the LBP resolution path.
    row({ muni_no: 410, roll_no_txt: '93075.000', municipality: 'MORDEN (CITY)',
          legal_description: 'LOT 5 BLOCK 2 PLAN 31654',
          lot: '5', block: '2', plan: '31654',
          certificates_of_title: '3009999' }),
  ],
};

// Pre-build the lookup the resolver expects. Tests pass it in via the
// opts override.
const lookup = (rolls) => lookupLegalRecordsByRollSet(FIXTURE, rolls);

// ---- helpers ----------------------------------------------------

function makeRow({ roll, muniNo = null, muniName = null, legal = null, title = '', site = null, lineNo = 1 }) {
  return {
    lineNo,
    roll,
    muniNo,
    muniName,
    legal: legal ? parseLegalToken(legal) : null,
    title,
    site,
    raw: { roll, muni: muniNo, muniName, legal, title, site },
  };
}

// Stub for the injected muni-name reconciler. `known` maps canonical
// roll → { muni_no, roll_no_txt }; anything else comes back as a miss.
// Mirrors the { resolvedByLine, unresolvedByLine } contract that
// main.js's resolveMuniNamesForImport fulfils against Roll Entry.
function makeMuniNameStub(known) {
  return async (rows) => {
    const resolvedByLine = new Map();
    const unresolvedByLine = new Map();
    for (const r of rows) {
      const hit = known[r.roll];
      if (hit) resolvedByLine.set(r.lineNo, hit);
      else unresolvedByLine.set(r.lineNo, `roll ${r.roll} not found in ${r.muniName}`);
    }
    return { resolvedByLine, unresolvedByLine };
  };
}

// ---- tests ------------------------------------------------------

console.log('resolveParcelList');

await test('supplied muni # short-circuits the lookup', async () => {
  const out = await resolveParcelList(
    [makeRow({ roll: '218600.000', muniNo: 275 })],
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved.length, 1);
  assert.equal(out.unresolved.length, 0);
  assert.equal(out.resolved[0].muniNo, 275);
  assert.equal(out.resolved[0].via, 'muni-supplied');
  assert.deepEqual(out.parcelKeys, [{ muni_no: 275, roll_no_txt: '218600.000' }]);
  assert.equal(out.stats.byVia.muni, 1);
});

await test('Site label is carried onto the resolved entry', async () => {
  const out = await resolveParcelList(
    [makeRow({ roll: '218600.000', muniNo: 275, site: '4' })],
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved.length, 1);
  assert.equal(out.resolved[0].site, '4');
});

await test('legal grid resolves muni when roll alone would be ambiguous', async () => {
  const out = await resolveParcelList(
    [makeRow({ roll: '218600.000', legal: 'NW26-2-13E' })],
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved.length, 1);
  assert.equal(out.unresolved.length, 0);
  assert.equal(out.resolved[0].muniNo, 275);
  assert.equal(out.resolved[0].via, 'legal');
});

await test('legal grid + different muni picks the right side of the ambiguity', async () => {
  // Same roll 218600 exists in muni 275 (Stanley) and 410 (Morden).
  // The Morden record's legal is "LOT 5 BLOCK 2 PLAN 31654", so a
  // grid-style legal can only match Stanley.
  const out = await resolveParcelList(
    [
      makeRow({ roll: '218600.000', legal: 'NW26-2-13E', lineNo: 1 }),
    ],
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved[0].muniNo, 275);
});

await test('title # supplied with no muni resolves via title path', async () => {
  const out = await resolveParcelList(
    [makeRow({ roll: '218600.000', title: '2476500' })],
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved.length, 1);
  assert.equal(out.resolved[0].muniNo, 275);
  assert.equal(out.resolved[0].via, 'title');
  assert.equal(out.stats.byVia.title, 1);
});

await test('title # with CT prefix normalizes and matches', async () => {
  const out = await resolveParcelList(
    [makeRow({ roll: '218600.000', title: 'CT 2476500' })],
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved.length, 1);
  assert.equal(out.resolved[0].muniNo, 275);
});

await test('title-first beats legal when both supplied (and title is decisive)', async () => {
  // Title 2476500 → Stanley. Legal "5-2-31654" → Morden. Title wins.
  const out = await resolveParcelList(
    [makeRow({ roll: '218600.000', legal: '5-2-31654', title: '2476500' })],
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved.length, 1);
  assert.equal(out.resolved[0].muniNo, 275);
  assert.equal(out.resolved[0].via, 'title');
});

await test('title miss falls back to legal when both supplied', async () => {
  // Bogus title that won't match any candidate, but legal "5-2-31654"
  // matches the Morden record on roll 218600.000.
  const out = await resolveParcelList(
    [makeRow({ roll: '218600.000', legal: '5-2-31654', title: '9999999' })],
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved.length, 1);
  assert.equal(out.resolved[0].muniNo, 410);
  assert.equal(out.resolved[0].via, 'legal');
});

await test('LBP legal resolves to the correct muni via lot/block/plan match', async () => {
  const out = await resolveParcelList(
    [makeRow({ roll: '93075.000', legal: '5-2-31654' })],
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved.length, 1);
  assert.equal(out.resolved[0].muniNo, 410);
});

await test('roll alone with a single candidate resolves implicitly', async () => {
  const out = await resolveParcelList(
    [makeRow({ roll: '219000.000' })],   // only in muni 275
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved.length, 1);
  assert.equal(out.resolved[0].via, 'roll-alone');
});

await test('roll alone with multiple-muni candidates lands in unresolved', async () => {
  // Roll 218600 exists in 275 and 410; no disambiguator supplied.
  const out = await resolveParcelList(
    [makeRow({ roll: '218600.000' })],
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved.length, 0);
  assert.equal(out.unresolved.length, 1);
  assert.match(out.unresolved[0].reason, /2 munis/);
  assert.deepEqual(out.unresolved[0].candidates.sort(), [275, 410]);
});

await test('roll not in index → unresolved with helpful reason', async () => {
  const out = await resolveParcelList(
    [makeRow({ roll: '99999.000', legal: 'NW26-2-13E' })],
    { lookupRollSet: lookup }
  );
  assert.equal(out.unresolved.length, 1);
  assert.match(out.unresolved[0].reason, /not found in legal index/);
});

await test('missing roll # → unresolved before lookup runs', async () => {
  const out = await resolveParcelList(
    [makeRow({ roll: '', muniNo: 275 })],
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved.length, 0);
  assert.equal(out.unresolved.length, 1);
  assert.match(out.unresolved[0].reason, /no roll/);
});

await test('mixed batch: supplied muni + legal + unresolved coexist', async () => {
  const out = await resolveParcelList(
    [
      makeRow({ roll: '218600.000', muniNo: 275, lineNo: 1 }),
      makeRow({ roll: '219000.000', legal: 'NW27-2-13E', lineNo: 2 }),
      makeRow({ roll: '218600.000', lineNo: 3 }),  // ambiguous → unresolved
    ],
    { lookupRollSet: lookup }
  );
  assert.equal(out.resolved.length, 2);
  assert.equal(out.unresolved.length, 1);
  assert.equal(out.parcelKeys.length, 2);
  // Stats should reflect resolution paths used.
  assert.equal(out.stats.byVia.muni, 1);
  assert.equal(out.stats.byVia.legal, 1);
  assert.equal(out.stats.total, 3);
});

await test('lookup failure routes every needs-lookup row to unresolved', async () => {
  const failing = async () => { throw new Error('worker crashed'); };
  const out = await resolveParcelList(
    [
      makeRow({ roll: '218600.000', muniNo: 275, lineNo: 1 }),  // supplied muni, skips lookup
      makeRow({ roll: '219000.000', legal: 'NW27-2-13E', lineNo: 2 }),  // needs lookup
    ],
    { lookupRollSet: failing }
  );
  assert.equal(out.resolved.length, 1);
  assert.equal(out.unresolved.length, 1);
  assert.match(out.unresolved[0].reason, /worker crashed/);
});

await test('parcelKeys are sorted in the order they resolved', async () => {
  const out = await resolveParcelList(
    [
      makeRow({ roll: '218600.000', muniNo: 275, lineNo: 1 }),
      makeRow({ roll: '93075.000',  muniNo: 410, lineNo: 2 }),
    ],
    { lookupRollSet: lookup }
  );
  assert.deepEqual(out.parcelKeys, [
    { muni_no: 275, roll_no_txt: '218600.000' },
    { muni_no: 410, roll_no_txt: '93075.000' },
  ]);
});

// ---- municipality-name resolution (sales-export shape) ----------

console.log('\nresolveParcelList — municipality name');

await test('municipality name resolves via the injected reconciler', async () => {
  const resolveMuniNames = makeMuniNameStub({
    '12800.000': { muni_no: 42, roll_no_txt: '12800.000' },
  });
  const out = await resolveParcelList(
    [makeRow({ roll: '12800.000', muniName: 'RM OF SPRINGFIELD' })],
    { lookupRollSet: lookup, resolveMuniNames },
  );
  assert.equal(out.resolved.length, 1);
  assert.equal(out.resolved[0].muniNo, 42);
  assert.equal(out.resolved[0].via, 'muni-name');
  assert.deepEqual(out.parcelKeys, [{ muni_no: 42, roll_no_txt: '12800.000' }]);
  assert.equal(out.stats.byVia.muniName, 1);
});

await test('municipality-name miss lands in unresolved with the reconciler reason', async () => {
  const resolveMuniNames = makeMuniNameStub({});   // nothing known
  const out = await resolveParcelList(
    [makeRow({ roll: '99999.000', muniName: 'RM OF SPRINGFIELD' })],
    { lookupRollSet: lookup, resolveMuniNames },
  );
  assert.equal(out.resolved.length, 0);
  assert.equal(out.unresolved.length, 1);
  assert.match(out.unresolved[0].reason, /RM OF SPRINGFIELD/);
});

await test('both members of an expanded row resolve as independent parcels', async () => {
  // A row that listed two rolls in one cell arrives here already expanded
  // into two rows. They resolve separately and carry no shared identity —
  // Property Search never binds parcels together.
  const resolveMuniNames = makeMuniNameStub({
    '32200.000': { muni_no: 42, roll_no_txt: '32200.000' },
    '44600.000': { muni_no: 42, roll_no_txt: '44600.000' },
  });
  const out = await resolveParcelList(
    [
      makeRow({ roll: '32200.000', muniName: 'RM OF SPRINGFIELD', lineNo: 1 }),
      makeRow({ roll: '44600.000', muniName: 'RM OF SPRINGFIELD', lineNo: 2 }),
    ],
    { lookupRollSet: lookup, resolveMuniNames },
  );
  assert.equal(out.resolved.length, 2);
  assert.deepEqual(out.resolved.map((r) => r.roll), ['32200.000', '44600.000']);
  assert.deepEqual(out.resolved.map((r) => r.groupId), [undefined, undefined]);
  assert.equal(out.stats.byVia.muniName, 2);
});

await test('a supplied numeric muni # still wins over a muni name', async () => {
  // Both muniNo and muniName present → trust the numeric code, no lookup.
  const resolveMuniNames = makeMuniNameStub({});   // would miss if consulted
  const out = await resolveParcelList(
    [makeRow({ roll: '12800.000', muniNo: 275, muniName: 'RM OF SPRINGFIELD' })],
    { lookupRollSet: lookup, resolveMuniNames },
  );
  assert.equal(out.resolved.length, 1);
  assert.equal(out.resolved[0].muniNo, 275);
  assert.equal(out.resolved[0].via, 'muni-supplied');
});

await test('muniName rows are unresolved (not dropped) when no reconciler is injected', async () => {
  const out = await resolveParcelList(
    [makeRow({ roll: '12800.000', muniName: 'RM OF SPRINGFIELD' })],
    { lookupRollSet: lookup },   // no resolveMuniNames
  );
  assert.equal(out.resolved.length, 0);
  assert.equal(out.unresolved.length, 1);
  assert.match(out.unresolved[0].reason, /unavailable/);
});

// ---- summary ----------------------------------------------------

const fails = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length > 0) {
  console.log('Failures:');
  for (const f of fails) console.log(`  - ${f.name}: ${f.err.message}`);
  process.exit(1);
}
