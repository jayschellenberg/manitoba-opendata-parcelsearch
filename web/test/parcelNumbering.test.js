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
  siteValue,
  groupValue,
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

// ---- Site field wins over the computed sequence --------------------
{
  // Two parcels with imported Site labels (stamped as _siteNo). The
  // computed sequence would number them by muni+roll; Site must override
  // so _seq is the caller's site value verbatim (numeric → a number).
  const a = { properties: { Municipality: '600 - RM OF HEADINGLEY', Roll_No_Txt: '90.000', _siteNo: '7' } };
  const b = { properties: { Municipality: '187 - DE SALABERRY (RM)', Roll_No_Txt: '5.000', _siteNo: '3' } };
  assignParcelSeq([a, b]);
  assert.equal(a.properties._seq, 7);   // Site 7, not sequence position
  assert.equal(b.properties._seq, 3);   // Site 3
}

// ---- siteValue + a non-numeric label + a missing site --------------
{
  assert.equal(siteValue({ _siteNo: ' 4 ' }), '4');
  assert.equal(siteValue({ _siteNo: '' }), null);
  assert.equal(siteValue({}), null);

  // Mixed: one parcel has a Site, the other doesn't. Site mode is active
  // (any site present), so the site-less parcel gets no number.
  const withSite = { properties: { Municipality: '600 - X', Roll_No_Txt: '1.000', _siteNo: 'A' } };
  const without  = { properties: { Municipality: '600 - X', Roll_No_Txt: '2.000' } };
  assignParcelSeq([withSite, without]);
  assert.equal(withSite.properties._seq, 'A'); // non-numeric label kept as string
  assert.equal(without.properties._seq, null); // no site → no number
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

// ---- grouped parcels count as ONE subject ---------------------------
// A multi-roll holding — rolls joined with + / | in the Roll # field, a
// multi-parcel sale in a CSV, or a multi-roll row in a list import — is one
// comp on the map and carries one badge, not one per roll.
{
  const g = (roll, gid) => feat('610 - PINEY (RM)', roll, { _saleGroupId: gid });
  const feats = [
    feat('610 - PINEY (RM)', '18000.000'),          // ungrouped, lowest roll
    g('83100.000', 7),
    g('83200.000', 7),
    g('85200.000', 7),
    feat('610 - PINEY (RM)', '225600.000'),         // ungrouped, highest roll
  ];
  assignParcelSeq(feats);
  const seqOf = (roll) => feats.find((f) => f.properties.Roll_No_Txt === roll).properties._seq;
  assert.equal(seqOf('18000.000'), 1);
  assert.equal(seqOf('83100.000'), 2);
  assert.equal(seqOf('83200.000'), 2, 'group members share one number');
  assert.equal(seqOf('85200.000'), 2);
  assert.equal(seqOf('225600.000'), 3, 'the count advances once per group, not per parcel');
}

// Two groups plus singles — each group consumes exactly one number.
{
  const feats = [
    feat('610 - PINEY (RM)', '100.000', { _saleGroupId: 1 }),
    feat('610 - PINEY (RM)', '200.000', { _saleGroupId: 1 }),
    feat('610 - PINEY (RM)', '300.000'),
    feat('610 - PINEY (RM)', '400.000', { _saleGroupId: 2 }),
    feat('610 - PINEY (RM)', '500.000', { _saleGroupId: 2 }),
  ];
  assignParcelSeq(feats);
  assert.deepEqual(feats.map((f) => f.properties._seq), [1, 1, 2, 3, 3]);
}

// A group id unique to one parcel behaves exactly like an ungrouped one —
// this is the ordinary sales-CSV shape, where every single-parcel sale gets
// its own id.
{
  const feats = [
    feat('610 - PINEY (RM)', '100.000', { _saleGroupId: 11 }),
    feat('610 - PINEY (RM)', '200.000', { _saleGroupId: 12 }),
    feat('610 - PINEY (RM)', '300.000', { _saleGroupId: 13 }),
  ];
  assignParcelSeq(feats);
  assert.deepEqual(feats.map((f) => f.properties._seq), [1, 2, 3]);
}

// Site labels still win outright — a caller-supplied comp number beats the
// computed sequence whether or not the parcels are grouped.
{
  const feats = [
    feat('610 - PINEY (RM)', '100.000', { _saleGroupId: 1, _siteNo: '24' }),
    feat('610 - PINEY (RM)', '200.000', { _saleGroupId: 1, _siteNo: '24' }),
  ];
  assignParcelSeq(feats);
  assert.deepEqual(feats.map((f) => f.properties._seq), [24, 24]);
}

// ---- groupValue -----------------------------------------------------
assert.equal(groupValue({ _saleGroupId: 3 }), '3');
assert.equal(groupValue({ _saleGroupId: '3' }), '3', 'number and string ids are the same group');
assert.equal(groupValue({ _saleGroupId: '' }), null);
assert.equal(groupValue({ _saleGroupId: null }), null);
assert.equal(groupValue({}), null);
assert.equal(groupValue(undefined), null);

console.log('parcelNumbering.test.js: all assertions passed');
