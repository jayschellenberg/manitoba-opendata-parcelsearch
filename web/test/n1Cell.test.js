// The results grid's N1 ID cell (lib/n1Cell.js) — a link that copies the id
// instead of navigating.
//
// These exist because the cell cannot be reached in a browser on a dev box:
// the N1 column is sales-only, and sales rows come from shards fetched off
// raw.githubusercontent, so without network the grid renders empty and the
// cell is never built. The behaviour that matters is small but easy to get
// wrong silently — a cell that copies "19035" out of "19035; 19036" looks
// perfectly fine until someone pastes the wrong half.
//
// No jsdom in this project (see multiSelect.test.js), so the stub below
// implements only the handful of DOM calls buildN1Cell actually makes.
//
// Run: cd web && node test/n1Cell.test.js

import assert from 'node:assert/strict';
import { buildN1Cell } from '../src/lib/n1Cell.js';

// ---- minimal DOM ---------------------------------------------------------

function makeEl(tag) {
  const classes = new Set();
  return {
    tagName: String(tag).toUpperCase(),
    textContent: '',
    title: '',
    href: undefined,
    children: [],
    attrs: {},
    listeners: {},
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    appendChild(child) { this.children.push(child); return child; },
    get className() { return [...classes].join(' '); },
  };
}
const doc = { createElement: (tag) => makeEl(tag) };

/** Build a cell, returning the td plus whatever wireCopy was handed. */
function build(value) {
  const copied = [];
  const cell = buildN1Cell(doc, value, { wireCopy: (a, text) => copied.push([a, text]) });
  return { cell, anchor: cell.children[0], copied };
}

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(false); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// ---- absent: a plain empty cell, no link --------------------------------
// Most sales are not entered in N1 yet, so this is the common row. It must
// read like every other empty column, not like a broken link.
for (const empty of [null, undefined, '', '   ']) {
  test(`absent (${JSON.stringify(empty)}) renders an em dash, not an anchor`, () => {
    const { cell, anchor } = build(empty);
    assert.equal(cell.textContent, '—');
    assert.ok(cell.classList.contains('empty'), 'carries the empty class');
    assert.equal(anchor, undefined, 'no anchor for a blank id');
  });
}

// ---- present: an anchor that copies -------------------------------------
test('a single id becomes an anchor showing the id', () => {
  const { anchor } = build('19035');
  assert.equal(anchor.tagName, 'A');
  assert.equal(anchor.textContent, '19035');
  assert.equal(anchor.href, '#', 'a real link, so table anchor styling and keyboard focus apply');
  assert.equal(anchor.attrs.role, 'button', 'announced as a button — it does not navigate');
});

test('the title says what the click does, before the click', () => {
  const { anchor } = build('19035');
  assert.equal(anchor.title, 'Copy N1 ID 19035 to the clipboard');
});

test('the copy is wired with the id as its payload', () => {
  const { anchor, copied } = build('19035');
  assert.deepEqual(copied, [[anchor, '19035']]);
});

// ---- the one that would fail silently -----------------------------------
test('a two-id cell copies VERBATIM, not the first id', () => {
  const { anchor, copied } = build('19035; 19036');
  assert.equal(copied[0][1], '19035; 19036', 'the whole cell is what the user meant to paste');
  assert.equal(anchor.textContent, '19035; 19036', 'and what they see is what they get');
});

test('surrounding whitespace is trimmed from both text and payload', () => {
  const { anchor, copied } = build('  19035  ');
  assert.equal(anchor.textContent, '19035');
  assert.equal(copied[0][1], '19035');
});

test('a numeric id is accepted, not just a string', () => {
  const { anchor, copied } = build(19035);
  assert.equal(anchor.textContent, '19035');
  assert.equal(copied[0][1], '19035');
});

// ---- the row must not move the map --------------------------------------
test('the click is stopped from reaching the row handler', () => {
  const { anchor } = build('19035');
  let stopped = false;
  assert.ok(anchor.listeners.click?.length, 'a click listener is attached');
  anchor.listeners.click[0]({ stopPropagation: () => { stopped = true; } });
  assert.ok(stopped, 'copying an id must not also fly the map to the parcel');
});

// ---- wireCopy is optional ------------------------------------------------
test('omitting wireCopy still builds the cell rather than throwing', () => {
  const cell = buildN1Cell(doc, '19035');
  assert.equal(cell.children[0].textContent, '19035');
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
