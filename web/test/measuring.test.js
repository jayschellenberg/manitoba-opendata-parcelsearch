// Unit tests for lib/measuring.js — the "a measurement is in progress" flag
// every map click and hover handler reads before answering an event.
//
// The bug that put it here (Jason, 2026-08-20): measuring a distance zoomed
// the map out mid-measurement. MapLibre dispatches a click to every layer
// handler under the point, so a vertex click also reached the Property
// Search municipality picker — which is armed until a search has run. The
// first vertex silently cleared the municipality dropdown and the second
// re-selected it, whose `change` handler flies the map to the municipality's
// whole extent: zoom 17 → 10.7, from a rooftop to a town.
//
// The predicate itself is trivial; what these lock down is the contract
// around it — reads with no DOM don't throw (so lib/ modules stay
// node-loadable), and the flag comes back down when the panel closes. A
// stuck `true` is the failure that would leave the whole map inert.
//
// Run: cd web && node test/measuring.test.js

import assert from 'node:assert/strict';

// ---- no DOM: never throws, never claims a measurement ------------------
{
  const { isMeasuring, setMeasuring } = await import('../src/lib/measuring.js');
  assert.equal(isMeasuring(), false, 'no document → not measuring');
  assert.doesNotThrow(() => setMeasuring(true), 'setMeasuring must no-op without a DOM');
  assert.equal(isMeasuring(), false, 'still not measuring after a DOM-less set');
}

// ---- with a DOM: the flag opens, closes, and is idempotent -------------
{
  const classes = new Set();
  globalThis.document = {
    body: {
      classList: {
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
        contains: (name) => classes.has(name),
      },
    },
  };
  // Fresh module instance so it picks up the global installed above.
  const { isMeasuring, setMeasuring, MEASURING_CLASS } =
    await import('../src/lib/measuring.js?dom');

  assert.equal(isMeasuring(), false, 'starts closed');

  setMeasuring(true);
  assert.equal(isMeasuring(), true, 'panel open → measuring');
  assert.ok(classes.has(MEASURING_CLASS), 'stamps the class style.css matches on');

  setMeasuring(true);
  assert.equal(isMeasuring(), true, 'opening twice is not a toggle');

  setMeasuring(false);
  assert.equal(isMeasuring(), false, 'panel closed → the map answers clicks again');
  assert.equal(classes.size, 0, 'class removed, not just unread');

  // Truthiness, not identity: callers pass whatever they have to hand.
  setMeasuring('yes');
  assert.equal(isMeasuring(), true, 'coerces truthy');
  setMeasuring(undefined);
  assert.equal(isMeasuring(), false, 'coerces falsy');

  delete globalThis.document;
}

console.log('measuring.test.js: all assertions passed');
