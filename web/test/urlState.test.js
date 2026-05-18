// Unit tests for src/urlState.js (Phase 6 item 23). Plan calls for
// thorough coverage: empty params, malformed params, round-trip
// serialize/deserialize. Run with:
//   cd web && node test/urlState.test.js

import assert from 'node:assert/strict';
import { encodeState, decodeState, SCHEMA } from '../src/urlState.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed += 1;
  }
}

console.log('urlState');

// ---------- empty / blank ----------

test('decodeState — null returns empty object', () => {
  assert.deepEqual(decodeState(null), {});
});

test('decodeState — undefined returns empty object', () => {
  assert.deepEqual(decodeState(undefined), {});
});

test('decodeState — empty string returns empty object', () => {
  assert.deepEqual(decodeState(''), {});
});

test('decodeState — bare ? returns empty object', () => {
  assert.deepEqual(decodeState('?'), {});
});

test('encodeState — null state returns empty string', () => {
  assert.equal(encodeState(null), '');
});

test('encodeState — empty object returns empty string', () => {
  assert.equal(encodeState({}), '');
});

test('encodeState — only null/undefined values returns empty string', () => {
  assert.equal(encodeState({ muni: null, roll: undefined, addressFrom: '' }), '');
});

// ---------- happy-path encode + decode ----------

test('encodeState — single string field', () => {
  const out = encodeState({ muni: 'RITCHOT (RM)' });
  assert.match(out, /^m=/);
  const params = new URLSearchParams(out);
  assert.equal(params.get('m'), 'RITCHOT (RM)');
});

test('encodeState — multiple fields', () => {
  const out = encodeState({
    muni: 'RITCHOT (RM)',
    roll: '1234,5678',
    addressFrom: '100',
    addressTo: '200',
    addressStreet: 'main',
  });
  const params = new URLSearchParams(out);
  assert.equal(params.get('m'), 'RITCHOT (RM)');
  assert.equal(params.get('r'), '1234,5678');
  assert.equal(params.get('af'), '100');
  assert.equal(params.get('at'), '200');
  assert.equal(params.get('as'), 'main');
});

test('encodeState — duMin integer formatted as string', () => {
  const out = encodeState({ duMode: 'min', duMin: 3 });
  const params = new URLSearchParams(out);
  assert.equal(params.get('du'), 'min');
  assert.equal(params.get('dn'), '3');
});

test('encodeState — vacantThreshold decimal preserved', () => {
  const out = encodeState({ vacantThreshold: 2.5 });
  const params = new URLSearchParams(out);
  assert.equal(params.get('vt'), '2.5');
});

test('decodeState — single string field', () => {
  const result = decodeState('m=RITCHOT%20(RM)');
  assert.deepEqual(result, { muni: 'RITCHOT (RM)' });
});

test('decodeState — multiple fields', () => {
  const result = decodeState('m=RITCHOT&r=123&af=100&at=200&as=main');
  assert.deepEqual(result, {
    muni: 'RITCHOT',
    roll: '123',
    addressFrom: '100',
    addressTo: '200',
    addressStreet: 'main',
  });
});

test('decodeState — integer field parsed', () => {
  const result = decodeState('du=min&dn=3');
  assert.deepEqual(result, { duMode: 'min', duMin: 3 });
});

test('decodeState — float field parsed', () => {
  const result = decodeState('vt=2.5');
  assert.deepEqual(result, { vacantThreshold: 2.5 });
});

test('decodeState — leading ? tolerated', () => {
  const result = decodeState('?m=RITCHOT');
  assert.deepEqual(result, { muni: 'RITCHOT' });
});

// ---------- malformed / out-of-range / unknown ----------

test('decodeState — unknown param dropped', () => {
  const result = decodeState('xyz=value&m=RITCHOT');
  assert.deepEqual(result, { muni: 'RITCHOT' });
});

test('decodeState — integer out of range dropped', () => {
  // duMin must be 1..9999
  const result = decodeState('du=min&dn=99999');
  assert.deepEqual(result, { duMode: 'min' });
});

test('decodeState — negative integer for duMin dropped', () => {
  const result = decodeState('du=min&dn=-1');
  assert.deepEqual(result, { duMode: 'min' });
});

test('decodeState — non-numeric integer dropped', () => {
  const result = decodeState('du=min&dn=abc');
  assert.deepEqual(result, { duMode: 'min' });
});

test('decodeState — vacantThreshold negative dropped', () => {
  const result = decodeState('vt=-1');
  assert.deepEqual(result, {});
});

test('decodeState — vacantMode invalid dropped', () => {
  const result = decodeState('vd=both');
  assert.deepEqual(result, {});
});

test('decodeState — vacantMode pct accepted', () => {
  const result = decodeState('vd=pct');
  assert.deepEqual(result, { vacantMode: 'pct' });
});

test('decodeState — vacantMode dollar accepted', () => {
  const result = decodeState('vd=dollar');
  assert.deepEqual(result, { vacantMode: 'dollar' });
});

test('decodeState — bad oneOf value dropped', () => {
  // changedStatus must be in zoning / devplan / both
  const result = decodeState('cs=junk');
  assert.deepEqual(result, {});
});

test('decodeState — oneOf with valid value parsed', () => {
  const result = decodeState('cs=zoning');
  assert.deepEqual(result, { changedStatus: 'zoning' });
});

test('decodeState — duMode rejects values outside [zero,min]', () => {
  const result = decodeState('du=any');
  assert.deepEqual(result, {});
});

test('decodeState — string over 200 chars dropped', () => {
  const long = 'x'.repeat(201);
  const result = decodeState(`m=${long}`);
  assert.deepEqual(result, {});
});

test('decodeState — empty-string value treated as missing', () => {
  const result = decodeState('m=&r=123');
  // m= is an empty string; cleanString returns undefined; m dropped.
  assert.deepEqual(result, { roll: '123' });
});

test('decodeState — whitespace-only string dropped', () => {
  const result = decodeState('m=%20%20');
  assert.deepEqual(result, {});
});

test('decodeState — malformed URL query handled gracefully', () => {
  // % decoding can throw; verify no exception.
  let threw = false;
  try { decodeState('m=%E0%A4'); } catch { threw = true; }
  assert.equal(threw, false);
});

// ---------- round-trip ----------

test('round-trip — full state survives encode + decode', () => {
  const state = {
    muni: 'RITCHOT (RM)',
    roll: '1234,5678',
    addressFrom: '100',
    addressTo: '200',
    addressStreet: 'main',
    legalText: 'PCL G',
    title: '2476500',
    zoneCategory: 'Residential',
    changedStatus: 'zoning',
    duMode: 'min',
    duMin: 5,
    tab: 'property',
    selectedRoll: '4000000',
    vacantThreshold: 2.5,
    vacantMode: 'pct',
  };
  const encoded = encodeState(state);
  const decoded = decodeState(encoded);
  assert.deepEqual(decoded, state);
});

test('round-trip — empty state survives', () => {
  const encoded = encodeState({});
  assert.equal(encoded, '');
  assert.deepEqual(decodeState(encoded), {});
});

test('round-trip — partial state preserves only set keys', () => {
  const state = { muni: 'TACHE (RM)', vacantThreshold: 2 };
  const encoded = encodeState(state);
  const decoded = decodeState(encoded);
  assert.deepEqual(decoded, state);
});

test('round-trip — special chars in muni name encoded + decoded', () => {
  const state = { muni: 'EAST ST. PAUL (RM)' };
  const encoded = encodeState(state);
  assert.ok(encoded.includes('%20') || encoded.includes('+'));
  const decoded = decodeState(encoded);
  assert.deepEqual(decoded, state);
});

test('round-trip — comma-separated roll list preserved', () => {
  const state = { roll: '123,456,789' };
  const encoded = encodeState(state);
  const decoded = decodeState(encoded);
  assert.deepEqual(decoded, state);
});

test('encodeState — extra / unknown keys silently ignored', () => {
  const out = encodeState({ muni: 'RITCHOT', nonsense: 'value', another: 42 });
  const params = new URLSearchParams(out);
  assert.equal(params.get('m'), 'RITCHOT');
  assert.equal(params.size, 1);
});

// ---------- schema sanity ----------

test('SCHEMA — every entry has param, validate, format', () => {
  for (const [key, def] of Object.entries(SCHEMA)) {
    assert.ok(typeof def.param === 'string' && def.param.length > 0, `${key} missing param`);
    assert.ok(typeof def.validate === 'function', `${key} missing validate`);
    assert.ok(typeof def.format === 'function', `${key} missing format`);
  }
});

test('SCHEMA — param keys are unique', () => {
  const seen = new Set();
  for (const def of Object.values(SCHEMA)) {
    assert.ok(!seen.has(def.param), `Duplicate param key: ${def.param}`);
    seen.add(def.param);
  }
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
