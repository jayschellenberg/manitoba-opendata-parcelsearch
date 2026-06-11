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

const { setOverlayPressed } = await import('../src/lib/overlayToggle.js');

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

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
