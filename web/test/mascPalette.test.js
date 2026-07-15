// Characterization tests for the single-source MASC palette in masc.js.
// Before this, the A→J colours were duplicated four ways: masc.js's
// MASC_PALETTE, main.js's soilColor object, and two inline MapLibre
// paint expressions in map.js. main.js and map.js now derive from
// MASC_PALETTE; these tests pin the exact values + the exact paint
// array those consumers depend on, so the unification is provably
// byte-identical.
//
// Run: cd web && node test/mascPalette.test.js

import assert from 'node:assert/strict';
import {
  MASC_PALETTE,
  MASC_RATING_LABEL_MIN_ZOOM,
  MASC_RISK_SOURCE_OPTIONS,
  masccolor,
} from '../src/masc.js';

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

// The exact A→J colours (what main.js's soilColor used and what map.js
// inlined). If MASC publishes a palette change, update here in lockstep.
const EXPECTED = {
  A: '#fff8c8', B: '#f2d640', C: '#847b14', D: '#a6e29f', E: '#4fab57',
  F: '#1a6b26', G: '#f4c2d1', H: '#e6228b', I: '#dc0000', J: '#9c27b0',
};

console.log('masccolor (replaces main.js soilColor)');

test('returns the published hex for every A→J rating', () => {
  for (const [code, hex] of Object.entries(EXPECTED)) {
    assert.equal(masccolor(code), hex, `code ${code}`);
  }
});

test('unknown / missing codes fall back to grey', () => {
  assert.equal(masccolor('Z'), '#cccccc');
  assert.equal(masccolor(''), '#cccccc');
  assert.equal(masccolor(null), '#cccccc');
  assert.equal(masccolor(undefined), '#cccccc');
});

console.log('\nMASC_PALETTE → map.js paint expression');

test('spreads into the exact masc-fill / masc-riverlots paint array', () => {
  // The golden literal that map.js carried inline (twice). Building it
  // from MASC_PALETTE must reproduce it byte-for-byte.
  const GOLDEN = [
    'match', ['get', 'rating'],
    'A', '#fff8c8',
    'B', '#f2d640',
    'C', '#847b14',
    'D', '#a6e29f',
    'E', '#4fab57',
    'F', '#1a6b26',
    'G', '#f4c2d1',
    'H', '#e6228b',
    'I', '#dc0000',
    'J', '#9c27b0',
    '#cccccc',
  ];
  const built = ['match', ['get', 'rating'], ...MASC_PALETTE, '#cccccc'];
  assert.deepEqual(built, GOLDEN);
});

test('palette is flat [code, hex, code, hex, …] with 10 ratings', () => {
  assert.equal(MASC_PALETTE.length, 20);
  for (let i = 0; i < MASC_PALETTE.length; i += 2) {
    assert.equal(MASC_PALETTE[i], 'ABCDEFGHIJ'[i / 2]);
    assert.equal(MASC_PALETTE[i + 1], EXPECTED[MASC_PALETTE[i]]);
  }
});

console.log('\nMASC map display configuration');

test('rating letters appear at a readable municipality scale', () => {
  assert.equal(MASC_RATING_LABEL_MIN_ZOOM, 11);
});

test('risk-area GeoJSON keeps the authoritative source vertices', () => {
  assert.deepEqual(MASC_RISK_SOURCE_OPTIONS, {
    maxzoom: 24,
    tolerance: 0,
  });
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
