// Unit tests for lib/muniPicker.js — the gating on the click-a-municipality
// picker. The rule under test (Jason, 2026-08-12): the gesture is armed only
// BEFORE a search has run, and while disarmed the layer must be completely
// inert — no hover shading, no pointer cursor, no click.
//
// These exist because the gating could not be verified any other way: the
// preview pane would not composite in the session this was written, so
// MapLibre never initialised and the hover was never exercised in a browser.
//
// Run: cd web && node test/muniPicker.test.js

import assert from 'node:assert/strict';
import { createMuniPicker } from '../src/lib/muniPicker.js';

/** A picker plus a record of everything it asked the map to do. */
function harness({ enabled = true } = {}) {
  const calls = { hover: [], cursor: [], picked: [] };
  const state = { enabled };
  const picker = createMuniPicker({
    isEnabled: () => state.enabled,
    setHover: (id, on) => calls.hover.push([id, on]),
    setCursor: (c) => { calls.cursor.push(c); },
    onPick: (name) => calls.picked.push(name),
  });
  return {
    picker, calls, state,
    /** Which features are currently tinted, per the calls made. */
    tinted() {
      const on = new Set();
      for (const [id, isOn] of calls.hover) { if (isOn) on.add(id); else on.delete(id); }
      return [...on];
    },
    cursorNow() { return calls.cursor.length ? calls.cursor[calls.cursor.length - 1] : ''; },
  };
}

// ---- armed: hover paints, click picks --------------------------------
{
  const h = harness();
  h.picker.mouseMove(7);
  assert.deepEqual(h.tinted(), [7], 'hovering tints the municipality');
  assert.equal(h.cursorNow(), 'pointer');

  // Moving to a neighbour hands the tint over rather than lighting both.
  h.picker.mouseMove(8);
  assert.deepEqual(h.tinted(), [8], 'only one municipality is ever tinted');

  // Re-entering the same feature doesn't thrash the feature-state.
  const before = h.calls.hover.length;
  h.picker.mouseMove(8);
  assert.equal(h.calls.hover.length, before, 'no redundant setFeatureState');

  h.picker.click('MORDEN (CITY)');
  assert.deepEqual(h.calls.picked, ['MORDEN (CITY)']);

  h.picker.mouseLeave();
  assert.deepEqual(h.tinted(), [], 'leaving clears the tint');
  assert.equal(h.cursorNow(), '', 'and the cursor');
}

// ---- THE REPORTED CASE: disarmed = no shading, no cursor, no click ----
{
  const h = harness({ enabled: false });
  h.picker.mouseMove(7);
  assert.deepEqual(h.tinted(), [], 'a disarmed picker must not shade on hover');
  assert.equal(h.cursorNow(), '', 'and must not offer a pointer cursor');
  h.picker.click('MORDEN (CITY)');
  assert.deepEqual(h.calls.picked, [], 'and must not accept a click');
}

// ---- disarming mid-hover, with the mouse still over the map ----------
// The path a keyboard-started search takes: Enter in the Roll # field with
// the cursor parked on a municipality. No mouse event follows, so without
// refresh() the tint would sit there over a layer that no longer responds.
{
  const h = harness();
  h.picker.mouseMove(7);
  assert.deepEqual(h.tinted(), [7]);
  assert.equal(h.cursorNow(), 'pointer');

  h.state.enabled = false;          // a search runs
  h.picker.refresh();               // disarmSearchPicker()

  assert.deepEqual(h.tinted(), [], 'the search must drop the existing tint');
  assert.equal(h.cursorNow(), '', 'and reset the cursor');

  // And it stays inert as the mouse keeps moving across municipalities.
  h.picker.mouseMove(8);
  h.picker.mouseMove(9);
  assert.deepEqual(h.tinted(), [], 'no re-shading after the gate closed');
  assert.equal(h.cursorNow(), '');
}

// ---- disarming WITHOUT refresh still self-heals on the next move -----
// Belt and braces: even if a caller forgets refresh(), the first mousemove
// must clear rather than leave a stale tint forever.
{
  const h = harness();
  h.picker.mouseMove(7);
  h.state.enabled = false;
  h.picker.mouseMove(7);            // no refresh() called
  assert.deepEqual(h.tinted(), [], 'the next mousemove clears a stale tint');
  assert.equal(h.cursorNow(), '');
}

// ---- refresh() while ARMED leaves an active hover alone ---------------
// refresh fires on tab changes too; it must not blank a legitimate hover.
{
  const h = harness();
  h.picker.mouseMove(7);
  h.picker.refresh();
  assert.deepEqual(h.tinted(), [7], 'an armed picker keeps its hover');
}

// ---- re-arming (Clear) restores the behaviour -------------------------
{
  const h = harness({ enabled: false });
  h.picker.mouseMove(7);
  assert.deepEqual(h.tinted(), []);
  h.state.enabled = true;           // Clear reloads the page in the app,
  h.picker.mouseMove(7);            // but the state machine must re-arm too
  assert.deepEqual(h.tinted(), [7], 'a re-armed picker shades again');
  assert.equal(h.cursorNow(), 'pointer');
}

// ---- defensiveness ----------------------------------------------------
{
  const h = harness();
  h.picker.mouseMove(null);         // a feature with no id
  h.picker.mouseMove(undefined);
  assert.deepEqual(h.tinted(), [], 'an id-less feature is ignored');
  h.picker.click('');               // an empty muni name
  h.picker.click(null);
  assert.deepEqual(h.calls.picked, [], 'a nameless click is ignored');

  // No io at all must not throw — the picker is wired before the map's
  // data has necessarily landed.
  const bare = createMuniPicker();
  bare.mouseMove(1);
  bare.mouseLeave();
  bare.click('X');
  bare.refresh();
}

// ---- id 0 is a valid feature id, not "no feature" ---------------------
// Feature ids are positional, so the first municipality in the boundary
// file has id 0. A falsy check instead of a null check would make exactly
// one municipality unhoverable and unclickable.
{
  const h = harness();
  h.picker.mouseMove(0);
  assert.deepEqual(h.tinted(), [0], 'feature id 0 must hover like any other');
  assert.equal(h.cursorNow(), 'pointer');
}

console.log('muniPicker.test.js: all assertions passed');
