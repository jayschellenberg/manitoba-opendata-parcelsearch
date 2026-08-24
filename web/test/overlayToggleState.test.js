// Unit tests for nextOverlayToggleState in lib/overlayToggle.js — the
// zoning overlay's three-state cycle, and the degraded two-state cycle it
// must fall back to when SELECTED ONLY is not reachable.
//
// Run: cd web && node test/overlayToggleState.test.js

import assert from 'node:assert/strict';
import { nextOverlayToggleState } from '../src/lib/overlayToggle.js';

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

/** Drive N clicks from a starting state, returning the `pressed` value
 *  after each — i.e. exactly what the button's aria-pressed becomes. */
function cycle(clicks, { triState = true, canSelectOnly = true } = {}) {
  let wasActive = false, wasSelectedOnly = false;
  const seen = [];
  for (let i = 0; i < clicks; i++) {
    const r = nextOverlayToggleState({ triState, wasActive, wasSelectedOnly, canSelectOnly });
    seen.push(r.pressed);
    // setOverlayPressed: 'mixed' and true both add .active; false removes it.
    wasActive = r.pressed !== false;
    wasSelectedOnly = r.pressed === 'mixed';
  }
  return seen;
}

// ---------- the full three-state cycle ----------

test('zoning cycles off -> ALL -> SELECTED ONLY -> off, then repeats', () => {
  assert.deepEqual(cycle(6, { canSelectOnly: true }),
    [true, 'mixed', false, true, 'mixed', false]);
});

test('the middle state is reported as selectedOnly exactly once per cycle', () => {
  const r1 = nextOverlayToggleState({ triState: true, wasActive: true, wasSelectedOnly: false, canSelectOnly: true });
  assert.equal(r1.selectedOnly, true);
  assert.equal(r1.visible, true);
  const r2 = nextOverlayToggleState({ triState: true, wasActive: true, wasSelectedOnly: true, canSelectOnly: true });
  assert.equal(r2.selectedOnly, false);
  assert.equal(r2.visible, false, 'the third click turns the overlay off');
});

// ---------- the bug ----------

test('with nothing to select, zoning degrades to off -> ALL -> off', () => {
  // THE REGRESSION. Previously this returned ALL forever: the click entered
  // the selected-only branch, found nothing to clip to, and reset the button
  // to ALL, so the next click repeated it. With no search loaded — how the
  // app opens — zoning could not be switched off at all.
  assert.deepEqual(cycle(6, { canSelectOnly: false }),
    [true, false, true, false, true, false]);
});

test('the skipped middle state is flagged so the UI can explain it', () => {
  const r = nextOverlayToggleState({ triState: true, wasActive: true, wasSelectedOnly: false, canSelectOnly: false });
  assert.equal(r.skippedSelection, true);
  assert.equal(r.visible, false, 'skipping the middle state must land OFF, never back on ALL');
});

test('nothing is flagged as skipped when the middle state is reachable', () => {
  const r = nextOverlayToggleState({ triState: true, wasActive: true, wasSelectedOnly: false, canSelectOnly: true });
  assert.equal(r.skippedSelection, false);
});

test('turning the overlay ON never counts as a skipped selection', () => {
  const r = nextOverlayToggleState({ triState: true, wasActive: false, wasSelectedOnly: false, canSelectOnly: false });
  assert.equal(r.skippedSelection, false);
  assert.equal(r.pressed, true);
});

// ---------- dev plan: plain on/off ----------

test('a non-tri-state overlay just alternates on and off', () => {
  assert.deepEqual(cycle(4, { triState: false, canSelectOnly: true }),
    [true, false, true, false]);
});

test('canSelectOnly is irrelevant to a non-tri-state overlay', () => {
  assert.deepEqual(cycle(4, { triState: false, canSelectOnly: false }),
    [true, false, true, false]);
  const r = nextOverlayToggleState({ triState: false, wasActive: true, wasSelectedOnly: false, canSelectOnly: false });
  assert.equal(r.skippedSelection, false, 'dev plan has no middle state to skip');
  assert.equal(r.selectedOnly, false);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
