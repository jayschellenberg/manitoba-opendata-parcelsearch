// Unit tests for lib/parcelNumbering.js — the stable 1..N sequence the
// map callouts and the results-table "#" column share. Verifies the
// municipality-then-roll-as-a-number ordering, that _seq is glued to
// the feature (not the array position), and the clear helper.
//
// Run: cd web && node test/parcelNumbering.test.js

import assert from 'node:assert/strict';
import {
  muniCodeValue,
  rollNumericValue,
  orderForNumbering,
  assignParcelSeq,
  clearParcelSeq,
} from '../src/lib/parcelNumbering.js';

function feat(municipality, roll, extra = {}) {
  return { properties: { Municipality: municipality, Roll_No_Txt: roll, ...extra } };
}

// ---- muniCodeValue --------------------------------------------------
assert.equal(muniCodeValue({ Municipality: '600 - RM OF HEADINGLEY' }), 600);
assert.equal(muniCodeValue({ Municipality: '187 - DE SALABERRY (RM)' }), 187);
// No parseable code sorts last.
assert.equal(muniCodeValue({ Muni_Name_With_Typ: 'TOWN OF MORRIS' }), Infinity);
assert.equal(muniCodeValue({}), Infinity);

// ---- rollNumericValue ----------------------------------------------
assert.equal(rollNumericValue({ Roll_No_Txt: '123456.000' }), 123456);
assert.equal(rollNumericValue({ Roll_No_Txt: '90.000' }), 90);
// Sub-roll ordering preserved as a fraction.
assert.ok(rollNumericValue({ Roll_No_Txt: '100.010' }) < rollNumericValue({ Roll_No_Txt: '100.500' }));
// Missing / junk sorts last.
assert.equal(rollNumericValue({ Roll_No_Txt: '' }), Infinity);
assert.equal(rollNumericValue({}), Infinity);

// ---- orderForNumbering: muni code first, then roll as a NUMBER ------
{
  // Two munis, deliberately out of order, with rolls that would sort
  // wrong under a string comparison (90 vs 100).
  const feats = [
    feat('600 - RM OF HEADINGLEY', '100.000'),
    feat('187 - DE SALABERRY (RM)', '90.000'),
    feat('600 - RM OF HEADINGLEY', '90.000'),
    feat('187 - DE SALABERRY (RM)', '100.000'),
  ];
  const ordered = orderForNumbering(feats);
  const seen = ordered.map((f) => `${muniCodeValue(f.properties)}|${f.properties.Roll_No_Txt}`);
  assert.deepEqual(seen, [
    // muni 187 sorts before 600, 90 before 100.
    '187|90.000',
    '187|100.000',
    '600|90.000',
    '600|100.000',
  ]);
}

// ---- ordering is by CODE, not by muni NAME -------------------------
{
  // Lower code but later-in-the-alphabet name; higher code but earlier
  // name. Code sort must win (100 before 900), which is the opposite of
  // an alphabetical name sort (ALPHA before ZEBRA).
  const feats = [
    feat('900 - ALPHA (RM)', '5.000'),
    feat('100 - ZEBRA (RM)', '5.000'),
  ];
  const ordered = orderForNumbering(feats);
  assert.deepEqual(ordered.map((f) => muniCodeValue(f.properties)), [100, 900]);
}

// ---- assignParcelSeq stamps a glued 1..N ---------------------------
{
  const a = feat('600 - RM OF HEADINGLEY', '100.000');
  const b = feat('187 - DE SALABERRY (RM)', '90.000');
  const c = feat('600 - RM OF HEADINGLEY', '90.000');
  const feats = [a, b, c];
  assignParcelSeq(feats);
  // b (De Salaberry 90) = 1, c (Headingley 90) = 2, a (Headingley 100) = 3.
  assert.equal(b.properties._seq, 1);
  assert.equal(c.properties._seq, 2);
  assert.equal(a.properties._seq, 3);
  // The number is glued to the feature object regardless of the input
  // array order — re-sorting the array later must not change _seq.
  const reversed = [a, c, b];
  assert.deepEqual(reversed.map((f) => f.properties._seq), [3, 2, 1]);
}

// ---- clearParcelSeq -------------------------------------------------
{
  const feats = [feat('600 - RM OF HEADINGLEY', '1.000')];
  assignParcelSeq(feats);
  assert.equal(feats[0].properties._seq, 1);
  clearParcelSeq(feats);
  assert.ok(!('_seq' in feats[0].properties));
}

// ---- defensiveness: features without properties are dropped --------
{
  const good = feat('600 - RM OF HEADINGLEY', '5.000');
  const ordered = orderForNumbering([null, {}, good, undefined]);
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0], good);
}

console.log('parcelNumbering.test.js: all assertions passed');
