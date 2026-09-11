// Every overlay button must be connected to its handler.
//
// WHY THIS EXISTS. The Traffic Counts overlay shipped with its button, its
// AUX_META entry, its map layers, its legend and its data join all correct —
// and no click listener. Nothing failed: the button rendered, styled and
// aria-pressed itself, and did nothing. The URL restore path was equally
// silent, because it works by calling btn.click().
//
// Unit tests did not catch it because each piece was individually right; the
// missing thing was the WIRE between them. So this test checks the wiring
// itself, by reading the three places an overlay has to appear and asserting
// they name the same set:
//
//   index.html   a <button id="<name>-toggle" class="overlay-btn">
//   main.js      an AUX_META (or OVERLAY_META) entry
//   main.js      an addEventListener that calls toggle*Overlay('<key>')
//
// Source-text matching is crude, but it is the only way to see a listener
// that was never written without standing up a DOM and booting the whole
// module.
//
// Run: cd web && node test/overlayWiring.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** Keys declared in the AUX_META object literal. */
function auxMetaKeys() {
  const at = main.indexOf('const AUX_META = {');
  assert.ok(at >= 0, 'AUX_META not found in main.js');
  let depth = 0;
  let end = at;
  for (let i = main.indexOf('{', at); i < main.length; i++) {
    if (main[i] === '{') depth++;
    else if (main[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = main.slice(at, end);
  // Top-level keys only: `  key:` at exactly two spaces of indent.
  return [...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):\s/gm)].map((m) => m[1]);
}

/** Overlay keys reachable from a click listener. */
function wiredKeys() {
  const keys = new Set();
  for (const m of main.matchAll(/toggleAuxOverlay\(\s*'([^']+)'\s*\)/g)) keys.add(m[1]);
  // The flood group wires a family through a helper rather than by name.
  if (/toggleAuxOverlay\(floodAuxKey\(/.test(main)) keys.add('__floodFamily');
  return keys;
}

/** Overlay toggle button ids declared in the markup. */
function buttonIds() {
  return [...html.matchAll(/<button[^>]*\bid="([a-z0-9-]+)-toggle"[^>]*class="[^"]*\boverlay-btn\b/g)]
    .map((m) => m[1]);
}

console.log('overlay wiring — index.html <-> main.js');

const aux = auxMetaKeys();
const wired = wiredKeys();
const buttons = buttonIds();

test('AUX_META declares the overlays we expect', () => {
  // A canary: if this list shrinks unexpectedly the parser above has drifted.
  assert.ok(aux.length >= 8, `only found ${aux.length} AUX_META keys: ${aux}`);
  for (const expected of ['contam', 'stations', 'flow', 'highways']) {
    assert.ok(aux.includes(expected), `AUX_META missing ${expected}`);
  }
});

test('every AUX_META overlay is reachable from a click listener', () => {
  // Flood groups are keyed 'flood:<group>' and wired through floodAuxKey().
  const missing = aux.filter((k) => !wired.has(k) && !k.startsWith('flood'));
  assert.deepEqual(missing, [],
    `declared in AUX_META but never wired to a button: ${missing.join(', ')}`);
});

test('every overlay button in the markup has a click handler', () => {
  // Not an allowlist: allowlists rot, and the whole point is to catch the
  // button nobody remembered. Instead follow the actual reference chain —
  // each button is looked up into a `const $x = getElementById(...)`, so
  // require that variable to appear with an addEventListener('click').
  // Overlays reached through toggleAuxOverlay/toggleOverlay and the flood
  // family (collected into a Map and wired in a loop) count as handled.
  const varOf = new Map();
  for (const m of main.matchAll(
    /const\s+(\$[A-Za-z0-9_]+)\s*=\s*document\.getElementById\(\s*'([a-z0-9-]+)-toggle'\s*\)/g)) {
    varOf.set(m[2], m[1]);
  }
  const listens = (v) => new RegExp(
    `\\${v}\\??\\.addEventListener\\(\\s*'click'`).test(main);

  const unwired = buttons.filter((id) => {
    if (id.startsWith('flood-')) return false;          // wired via $floodToggles loop
    const v = varOf.get(id);
    if (v && listens(v)) return false;
    const camel = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return !wired.has(camel) && !wired.has(id);
  });
  assert.deepEqual(unwired, [],
    `overlay buttons with no click handler: ${unwired.join(', ')}`);
});

test('the Traffic Counts button specifically is wired', () => {
  // The regression this file was written for.
  assert.ok(buttons.includes('stations'), 'stations-toggle missing from index.html');
  assert.ok(aux.includes('stations'), 'stations missing from AUX_META');
  assert.ok(wired.has('stations'),
    "stations-toggle has no addEventListener calling toggleAuxOverlay('stations')");
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
