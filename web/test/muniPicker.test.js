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
import {
  createMuniPicker, bboxWithin, hoverInertLoadedMuni, hoverDefersToContent,
} from '../src/lib/muniPicker.js';

/** The loaded municipality's extent, and two viewports over it. */
const MUNI_BBOX  = [0, 0, 10, 10];
const VIEW_INSIDE = [4, 4, 6, 6];     // zoomed into its parcels
const VIEW_WHOLE  = [-2, -2, 12, 12]; // the whole muni on screen

/** A picker plus a record of everything it asked the map to do. */
function harness({ enabled = true, loaded = null, view = VIEW_INSIDE } = {}) {
  const calls = { hover: [], cursor: [], picked: [] };
  const state = { enabled, loaded, view };
  const picker = createMuniPicker({
    isEnabled: () => state.enabled,
    // The real rule, wired the way map.js wires it.
    isInert: (id) => hoverInertLoadedMuni({
      featureId: id,
      loadedId: state.loaded,
      featureBbox: state.loaded == null ? null : MUNI_BBOX,
      viewBbox: state.view,
    }),
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

// ---- the LOADED municipality is inert while zoomed into it ------------
// Reported 2026-08-24: with a municipality loaded in Property Search, the
// boundary fill shows through the gaps in the parcel fabric — public roads,
// road allowances, water — so tracking across it flashed the whole RM on
// and off with every road crossed.
{
  const h = harness({ loaded: 7 });
  h.picker.mouseMove(7);
  assert.deepEqual(h.tinted(), [], 'the loaded municipality must not tint');
  assert.equal(h.cursorNow(), '', 'and must not offer a pointer cursor');

  // Its NEIGHBOURS are still pointable — that is how you switch munis.
  h.picker.mouseMove(8);
  assert.deepEqual(h.tinted(), [8], 'a different municipality still tints');
  assert.equal(h.cursorNow(), 'pointer');

  // Crossing back in drops the neighbour's tint rather than leaving it lit.
  h.picker.mouseMove(7);
  assert.deepEqual(h.tinted(), [], 'moving back into the loaded muni clears');
  assert.equal(h.cursorNow(), '');

  // The click goes with the hover (Jason, 2026-08-24). Clicking the loaded
  // muni clears it back to "Any municipality" — destructive, and zoomed in
  // it would fire off a click that landed on a road, with no tint to warn
  // that anything was about to happen.
  h.picker.click('MORDEN (CITY)', 7);
  assert.deepEqual(h.calls.picked, [], 'an inert municipality refuses the click');

  // A neighbour is still clickable — that is how you switch municipalities
  // without going back to the dropdown.
  h.picker.click('WINKLER (CITY)', 8);
  assert.deepEqual(h.calls.picked, ['WINKLER (CITY)'], 'a neighbour still picks');
}

// ---- ...and the click comes back with the whole municipality in view --
{
  const h = harness({ loaded: 7, view: VIEW_WHOLE });
  h.picker.click('MORDEN (CITY)', 7);
  assert.deepEqual(h.calls.picked, ['MORDEN (CITY)'],
    'zoomed out, clicking the loaded muni clears it as before');
}

// ---- a click with no feature id is accepted, as it always was ---------
// The id is an added argument; a caller that doesn't pass one must not
// silently lose the gesture.
{
  const h = harness({ loaded: 7 });
  h.picker.click('MORDEN (CITY)');
  assert.deepEqual(h.calls.picked, ['MORDEN (CITY)'], 'an id-less click still picks');
}

// ---- loading a muni while hovering it drops the tint immediately ------
// Picking from the dropdown with the cursor parked over that municipality:
// no mouse event follows, so refresh() has to clear it.
{
  const h = harness();
  h.picker.mouseMove(7);
  assert.deepEqual(h.tinted(), [7]);

  h.state.loaded = 7;               // the dropdown change lands
  h.picker.refresh();               // paintSelectedMuniBoundary()

  assert.deepEqual(h.tinted(), [], 'the newly loaded muni drops its tint');
  assert.equal(h.cursorNow(), '', 'and its pointer cursor');
}

// ---- refresh() must not blank a hover on some OTHER municipality ------
{
  const h = harness({ loaded: 7 });
  h.picker.mouseMove(8);
  h.picker.refresh();
  assert.deepEqual(h.tinted(), [8], 'a neighbour keeps its hover on refresh');
}

// ---- clearing the municipality re-arms the hover ----------------------
{
  const h = harness({ loaded: 7 });
  h.picker.mouseMove(7);
  assert.deepEqual(h.tinted(), []);
  h.state.loaded = null;            // back to "Any municipality"
  h.picker.mouseMove(7);
  assert.deepEqual(h.tinted(), [7], 'with nothing loaded it shades again');
}

// ---- loaded id 0 is a real municipality, not "nothing loaded" ---------
{
  const h = harness({ loaded: 0 });
  h.picker.mouseMove(0);
  assert.deepEqual(h.tinted(), [], 'loaded feature id 0 must not tint');
  h.picker.mouseMove(1);
  assert.deepEqual(h.tinted(), [1], 'and its neighbour still does');
}

// ---- ...but it DOES tint once the whole municipality is on screen -----
// Jason, 2026-08-24: zoomed out that far the tint is a shape, not a flash.
// It says which municipality in view is the loaded one, and the fabric
// gaps that caused the flicker are far below a pixel.
{
  const h = harness({ loaded: 7, view: VIEW_WHOLE });
  h.picker.mouseMove(7);
  assert.deepEqual(h.tinted(), [7], 'the whole muni in view hovers again');
  assert.equal(h.cursorNow(), 'pointer');
}

// ---- zooming past the muni's extent drops the tint under a parked cursor
// moveend re-runs the rule; no mouse event follows a wheel zoom.
{
  const h = harness({ loaded: 7, view: VIEW_WHOLE });
  h.picker.mouseMove(7);
  assert.deepEqual(h.tinted(), [7]);

  h.state.view = VIEW_INSIDE;       // zoom in on the parcels
  h.picker.refresh();
  assert.deepEqual(h.tinted(), [], 'zooming in clears the loaded muni tint');
  assert.equal(h.cursorNow(), '');

  // And zooming back out brings it back on the next evaluation.
  h.state.view = VIEW_WHOLE;
  h.picker.mouseMove(7);
  assert.deepEqual(h.tinted(), [7], 'zooming back out shades again');
}

// ---- the loaded muni's tint ignores what is drawn over it -------------
// Second report, 2026-08-24 (Brandon): the whole-muni-in-view exception put
// the flashing straight back, because Brandon is 14 km across — selecting
// it fits the map to its bounds, which IS "the whole municipality in view",
// and at that zoom the river, rail corridors and arterials still leave gaps
// in the parcel fabric. The tint has to stop depending on the fabric.
{
  // The loaded municipality: content over it is not a reason to stand down.
  assert.equal(hoverDefersToContent({ featureId: 7, loadedId: 7 }), false,
    'the loaded muni does not defer to the parcel drawn on top of it');

  // Everybody else still does — otherwise the backdrop would tint while
  // you were pointing at a parcel in some other municipality.
  assert.equal(hoverDefersToContent({ featureId: 8, loadedId: 7 }), true,
    'a neighbour still defers');
  assert.equal(hoverDefersToContent({ featureId: 7, loadedId: null }), true,
    'with nothing loaded, everything defers');
  assert.equal(hoverDefersToContent({ featureId: null, loadedId: 7 }), true,
    'an id-less feature defers');
  assert.equal(hoverDefersToContent(), true, 'and so does a bare call');

  // id 0 again: the first municipality in the file must get the exception.
  assert.equal(hoverDefersToContent({ featureId: 0, loadedId: 0 }), false,
    'feature id 0 is a real loaded muni');
}

// ---- the rule itself, at the edges ------------------------------------
{
  // Exactly framed counts as in view — fitBounds lands here (with padding).
  assert.equal(bboxWithin(MUNI_BBOX, MUNI_BBOX), true, 'an exact fit is within');
  // One edge off screen is not the whole municipality.
  assert.equal(bboxWithin(MUNI_BBOX, [0, 0, 9.9, 10]), false, 'east edge cut');
  assert.equal(bboxWithin(MUNI_BBOX, [0.1, 0, 10, 10]), false, 'west edge cut');
  assert.equal(bboxWithin(MUNI_BBOX, [0, 0.1, 10, 10]), false, 'south edge cut');
  assert.equal(bboxWithin(MUNI_BBOX, [0, 0, 10, 9.9]), false, 'north edge cut');
  assert.equal(bboxWithin(null, MUNI_BBOX), false, 'a missing extent is not within');
  assert.equal(bboxWithin(MUNI_BBOX, null), false, 'a missing view is not within');

  // Nothing loaded, or a different municipality: never inert.
  assert.equal(hoverInertLoadedMuni({ featureId: 7, loadedId: null }), false);
  assert.equal(hoverInertLoadedMuni({
    featureId: 8, loadedId: 7, featureBbox: MUNI_BBOX, viewBbox: VIEW_INSIDE,
  }), false, 'a neighbour is never inert');

  // Extent unknown — the boundaries FC has not landed yet. Fall back to
  // the plain rule rather than flashing on a guess.
  assert.equal(hoverInertLoadedMuni({
    featureId: 7, loadedId: 7, featureBbox: null, viewBbox: VIEW_WHOLE,
  }), true, 'an unknown extent suppresses the hover');

  // No arguments at all must not throw.
  assert.equal(hoverInertLoadedMuni(), false);
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
