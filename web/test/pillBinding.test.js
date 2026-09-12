// lib/pillBinding.js — the mode ↔ checkbox mapping behind the sidebar's
// segmented pills. Run: cd web && node test/pillBinding.test.js
import assert from 'node:assert/strict';
import { PILL_SPECS, modeFromChecked, checkedFromMode } from '../src/lib/pillBinding.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

test('every mode round-trips through checked and back', () => {
  for (const [name, spec] of Object.entries(PILL_SPECS)) {
    for (const mode of Object.keys(spec.modes)) {
      assert.equal(modeFromChecked(spec, checkedFromMode(spec, mode)), mode, `${name}:${mode}`);
    }
  }
});

test('every spec has one input per pattern slot and its default (all-unticked) mode first', () => {
  for (const [name, spec] of Object.entries(PILL_SPECS)) {
    const first = Object.keys(spec.modes)[0];
    assert.ok(spec.modes[first].every((v) => v === false), `: first mode  must be all-unticked`);
    for (const [mode, pattern] of Object.entries(spec.modes)) {
      assert.equal(pattern.length, spec.inputs.length, `${name}:${mode}`);
    }
  }
});

test('water: both boxes ticked is Any, neither is Off', () => {
  assert.equal(modeFromChecked(PILL_SPECS.water, [true, true]), 'any');
  assert.equal(modeFromChecked(PILL_SPECS.water, [false, false]), 'off');
  assert.equal(modeFromChecked(PILL_SPECS.water, [true, false]), 'waterfront');
  assert.equal(modeFromChecked(PILL_SPECS.water, [false, true]), 'near');
});

test('numbering: entry order without numbering reads as Off', () => {
  assert.equal(modeFromChecked(PILL_SPECS.numbering, [false, true]), 'off');
  assert.deepEqual(checkedFromMode(PILL_SPECS.numbering, 'entry'), [true, true]);
});

test('unknown mode reads as Off; truthy non-booleans compare by truthiness', () => {
  assert.deepEqual(checkedFromMode(PILL_SPECS.tile, 'bogus'), [false]);
  assert.equal(modeFromChecked(PILL_SPECS.tile, [1]), 'on');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
