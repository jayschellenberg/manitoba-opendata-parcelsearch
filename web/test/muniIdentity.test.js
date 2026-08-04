// Characterization tests for lib/muniIdentity.js — the municipality
// matching behind the split-boundary MASC river-lot filtering
// (the De Salaberry / St-Pierre-Jolys case). Previously untested.
//
// Inputs that exercise the Unicode character classes use \u escapes so
// the test source is unambiguous: if the accent-strip class were wrong,
// "François" -> "FRANCIS" would fail; if the dash class were wrong,
// the U+2010 hyphen case would diverge.
//
// Run: cd web && node test/muniIdentity.test.js

import assert from 'node:assert/strict';
import {
  normalizeMuniType,
  parseMuniIdentity,
  muniIdentitiesMatch,
  featureMascMunis,
  filterMascRiverlotsForMuni,
} from '../src/lib/muniIdentity.js';

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

console.log('normalizeMuniType');

test('canonicalizes RURAL MUNICIPALITY to RM, passes others through', () => {
  assert.equal(normalizeMuniType('RURAL MUNICIPALITY'), 'RM');
  assert.equal(normalizeMuniType('rural municipality'), 'RM');
  assert.equal(normalizeMuniType('Town'), 'TOWN');
  assert.equal(normalizeMuniType(''), '');
});

console.log('\nparseMuniIdentity');

test('parses the three type-token placements to the same identity', () => {
  assert.deepEqual(parseMuniIdentity('DE SALABERRY (RM)'), { name: 'DE SALABERRY', type: 'RM' });
  assert.deepEqual(parseMuniIdentity('RM OF DE SALABERRY'), { name: 'DE SALABERRY', type: 'RM' });
  assert.deepEqual(parseMuniIdentity('DE SALABERRY RM'), { name: 'DE SALABERRY', type: 'RM' });
});

test('RURAL MUNICIPALITY token normalizes to RM type', () => {
  assert.deepEqual(parseMuniIdentity('DE SALABERRY (RURAL MUNICIPALITY)'), { name: 'DE SALABERRY', type: 'RM' });
});

test('no type token leaves type null', () => {
  assert.deepEqual(parseMuniIdentity('DE SALABERRY'), { name: 'DE SALABERRY', type: null });
});

test('strips accents via NFD + combining-mark class (cedilla case)', () => {
  // "François" -> NFD decomposes ç to c + combining cedilla
  // (U+0327), which the diacritic class removes -> FRANCOIS -> FRANCIS.
  assert.equal(parseMuniIdentity('François').name, 'FRANCIS');
  assert.equal(parseMuniIdentity('ST FRANÇOIS XAVIER (RM)').name, 'ST FRANCIS XAVIER');
});

test('Unicode dash (U+2010) normalizes like an ASCII hyphen', () => {
  assert.equal(parseMuniIdentity('BIFROST‐RIVERTON').name, 'BIFROST RIVERTON');
  assert.equal(parseMuniIdentity('BIFROST-RIVERTON').name, 'BIFROST RIVERTON');
});

test('applies the spelling reconciliations', () => {
  assert.equal(parseMuniIdentity('RIDING MTN WEST (RM)').name, 'RIDING MOUNTAIN WEST');
  assert.equal(parseMuniIdentity('SAINTE ROSE').name, 'STE ROSE');
  assert.equal(parseMuniIdentity('DESALABERRY').name, 'DE SALABERRY');
});

test('dotted spelling and dropped period', () => {
  assert.deepEqual(parseMuniIdentity('ST. PIERRE-JOLYS (VILLAGE)'), { name: 'ST PIERRE JOLYS', type: 'VILLAGE' });
});

console.log('\nmuniIdentitiesMatch');

test('same name + same type matches across spellings', () => {
  assert.equal(muniIdentitiesMatch('DE SALABERRY (RM)', 'RM OF DE SALABERRY'), true);
  assert.equal(muniIdentitiesMatch('RM OF ST. ANDREWS', 'ST ANDREWS (RM)'), true);
});

test('different name never matches', () => {
  assert.equal(muniIdentitiesMatch('DE SALABERRY (RM)', 'ST PIERRE-JOLYS (VILLAGE)'), false);
});

test('same name + different type: matches only with the fallback', () => {
  assert.equal(muniIdentitiesMatch('HEADINGLEY (RM)', 'HEADINGLEY (TOWN)'), false);
  assert.equal(muniIdentitiesMatch('HEADINGLEY (RM)', 'HEADINGLEY (TOWN)', { allowTypeFallback: true }), true);
});

test('a missing type on either side matches regardless of fallback', () => {
  assert.equal(muniIdentitiesMatch('DE SALABERRY', 'DE SALABERRY (RM)'), true);
});

console.log('\nfeatureMascMunis');

test('collects distinct muni strings across the property aliases', () => {
  const f = { properties: { muni: 'A', rating_muni: 'B', ratingMuni: 'A', source_muni: 'C' } };
  assert.deepEqual(featureMascMunis(f), ['A', 'B', 'C']);  // A de-duped, falsy dropped
  assert.deepEqual(featureMascMunis({}), []);
});

console.log('\nfilterMascRiverlotsForMuni');

test('prefers exact typed matches when any exist', () => {
  const feats = [
    { properties: { muni: 'DE SALABERRY (RM)' } },          // exact
    { properties: { muni: 'ST-PIERRE-JOLYS (VILLAGE)' } },   // enclave town, diff name
  ];
  const out = filterMascRiverlotsForMuni(feats, 'DE SALABERRY (RM)');
  assert.equal(out.length, 1);
  assert.equal(out[0].properties.muni, 'DE SALABERRY (RM)');
});

test('falls back to shared bare name only when no exact match exists', () => {
  // No exact RM match; an enclave Town-tagged lot shares the bare name.
  const feats = [
    { properties: { muni: 'HEADINGLEY (TOWN)', rating_muni: 'HEADINGLEY (RM)' } },
  ];
  // rating_muni gives an exact RM match here, so it's returned exactly.
  assert.equal(filterMascRiverlotsForMuni(feats, 'HEADINGLEY (RM)').length, 1);

  // Pure enclave case: only a Town tag, queried as RM -> fallback path.
  const enclaveOnly = [{ properties: { muni: 'HEADINGLEY (TOWN)' } }];
  assert.equal(filterMascRiverlotsForMuni(enclaveOnly, 'HEADINGLEY (RM)').length, 1);
});

test('returns empty when nothing shares the name', () => {
  const feats = [{ properties: { muni: 'MORRIS (RM)' } }];
  assert.deepEqual(filterMascRiverlotsForMuni(feats, 'DE SALABERRY (RM)'), []);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
