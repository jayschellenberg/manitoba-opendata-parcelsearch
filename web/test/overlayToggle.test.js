// Unit tests for lib/overlayToggle.js. The helper coordinates two DOM
// mutations (CSS class + aria-pressed) that always have to move
// together — these tests are the canonical contract.
//
// Run: cd web && node test/overlayToggle.test.js

import assert from 'node:assert/strict';

// Minimal HTMLElement shim — just the surface setOverlayPressed needs.
function fakeButton() {
  const classes = new Set();
  const attrs = new Map();
  return {
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attrs.set(name, value); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    // Inspection helpers for tests.
    _classes: classes,
    _attrs: attrs,
  };
}

const { setOverlayPressed, overlayGroupExpanded } = await import('../src/lib/overlayToggle.js');

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

console.log('setOverlayPressed');

test('true → adds .active and aria-pressed="true"', () => {
  const btn = fakeButton();
  setOverlayPressed(btn, true);
  assert.equal(btn.classList.contains('active'), true);
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
});

test('false → removes .active and aria-pressed="false"', () => {
  const btn = fakeButton();
  setOverlayPressed(btn, true);
  setOverlayPressed(btn, false);
  assert.equal(btn.classList.contains('active'), false);
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
});

test('"mixed" → keeps .active and aria-pressed="mixed"', () => {
  const btn = fakeButton();
  setOverlayPressed(btn, 'mixed');
  assert.equal(btn.classList.contains('active'), true);
  assert.equal(btn.getAttribute('aria-pressed'), 'mixed');
});

test('null button is a no-op (no throw)', () => {
  setOverlayPressed(null, true);
  setOverlayPressed(undefined, 'mixed');
});

test('truthy non-boolean values coerce to true', () => {
  const btn = fakeButton();
  setOverlayPressed(btn, 1);
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(btn.classList.contains('active'), true);
});

test('falsy non-boolean values coerce to false', () => {
  const btn = fakeButton();
  setOverlayPressed(btn, true);
  setOverlayPressed(btn, 0);
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(btn.classList.contains('active'), false);
});

test('round-trip: pressed → unpressed → pressed cleans up state', () => {
  const btn = fakeButton();
  setOverlayPressed(btn, true);
  setOverlayPressed(btn, 'mixed');
  setOverlayPressed(btn, false);
  setOverlayPressed(btn, true);
  assert.equal(btn.classList.contains('active'), true);
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
});

// ---- overlayGroupExpanded -------------------------------------------
//
// Decides whether the parcel popups render MASC + Soil composition. The
// fail-open case is the one that matters: getting it backwards would
// strip real data out of every popup on a markup rename, silently.

/** Minimal Document shim returning `el` for the expected selector only. */
function fakeDoc(group, el) {
  return {
    querySelector(sel) {
      return sel === `.overlay-group[data-group="${group}"]` ? el : null;
    },
  };
}

test('expanded group reads as expanded', () => {
  assert.equal(overlayGroupExpanded('agricultural', fakeDoc('agricultural', { open: true })), true);
});

test('collapsed group reads as collapsed', () => {
  assert.equal(overlayGroupExpanded('agricultural', fakeDoc('agricultural', { open: false })), false);
});

test('a missing group fails OPEN, not closed', () => {
  // A renamed or removed data-group must not silently hide parcel data.
  assert.equal(overlayGroupExpanded('agricultural', fakeDoc('nope', { open: false })), true);
  assert.equal(overlayGroupExpanded('agricultural', { querySelector: () => null }), true);
});

test('no document at all fails OPEN rather than throwing', () => {
  // map.js is imported in contexts (SSR-ish tooling, tests) with no DOM.
  assert.equal(overlayGroupExpanded('agricultural', undefined), true);
  assert.equal(overlayGroupExpanded('agricultural', {}), true);
});

test('a non-boolean open property is not treated as expanded', () => {
  // <details>.open is always a real boolean; anything else means we are
  // not looking at the element we think we are, so fall back to hiding
  // rather than guessing from a truthy string.
  assert.equal(overlayGroupExpanded('agricultural', fakeDoc('agricultural', { open: 'true' })), false);
  assert.equal(overlayGroupExpanded('agricultural', fakeDoc('agricultural', {})), false);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
