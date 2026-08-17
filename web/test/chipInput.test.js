// Paste handling for the Roll # chip input (lib/chipInput.js).
//
// Covers the one case that broke in the wild: a column copied out of Excel or
// a CSV, where the rolls are separated by NEWLINES. That paste used to arrive
// as a single concatenated chip ("12700\n13000\n13200" -> "127001300013200")
// while comma-, tab- and space-separated pastes worked fine.
//
// The cause was not the parser — parseRollList and the chip splitter both
// already treat any whitespace as a separator. It was that the handler staged
// the clipboard text in `textInput.value` before splitting it, and an
// <input type="text"> strips CR/LF from its value per the HTML value
// sanitisation algorithm. So the delimiter was gone before anything tried to
// split on it. Hence these tests drive the real paste listener rather than
// calling the splitter directly: a parser-level test passes either way and
// would not have caught this.
//
// There is no jsdom in this project (see multiSelect.test.js), so the stub
// below implements only the handful of DOM calls initChipInput actually makes.
// The text input deliberately reproduces the newline-stripping behaviour that
// caused the bug, so the regression is reachable.
//
// Run: cd web && node test/chipInput.test.js

import assert from 'node:assert/strict';

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

// ---- minimal DOM ---------------------------------------------------------

function makeEl(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    title: '',
    dataset: {},
    children: [],
    parent: null,
    _on: {},
    addEventListener(type, fn) { (this._on[type] ||= []).push(fn); },
    dispatchEvent(ev) { for (const fn of this._on[ev.type] || []) fn(ev); return !ev.defaultPrevented; },
    setAttribute() {},
    focus() {},
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    insertBefore(c, ref) {
      c.parent = this;
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? this.children.length : i, 0, c);
      return c;
    },
    remove() {
      if (!this.parent) return;
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const want = String(sel).replace(/^\./, '');
      const hit = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (String(c.className).split(/\s+/).includes(want)) hit.push(c);
          walk(c);
        }
      };
      walk(this);
      return hit;
    },
  };
}

// A single-line text input: assigning a value strips CR/LF exactly as the
// HTML value sanitisation algorithm does. This is the behaviour the bug
// depended on, so the stub has to model it or the test proves nothing.
function makeTextInput() {
  const el = makeEl('input');
  let raw = '';
  Object.defineProperty(el, 'value', {
    get: () => raw,
    set: (v) => { raw = String(v).replace(/[\r\n]/g, ''); },
  });
  el.className = 'chip-input-text';
  return el;
}

function pasteEvent(text) {
  return {
    type: 'paste',
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    clipboardData: { getData: () => text },
  };
}

// ---- harness -------------------------------------------------------------

globalThis.Event = class { constructor(type) { this.type = type; } };
globalThis.setTimeout = globalThis.setTimeout || ((fn) => fn());

async function setup() {
  const wrapper = makeEl('div');
  wrapper.className = 'chip-input';
  wrapper.dataset.target = 'roll';

  const hidden = makeEl('input');
  hidden.value = '';

  const textInput = makeTextInput();
  wrapper.appendChild(textInput);

  globalThis.document = {
    getElementById: (id) => (id === 'roll' ? hidden : null),
    createElement: (tag) => makeEl(tag),
  };

  const { initChipInput } = await import('../src/lib/chipInput.js');
  const ok = initChipInput(wrapper);
  assert.equal(ok, true, 'initChipInput should accept the stub markup');

  return {
    hidden,
    textInput,
    paste(text) { textInput.dispatchEvent(pasteEvent(text)); },
    chips() { return wrapper.querySelectorAll('.chip-text').map((c) => c.textContent); },
    reset() {
      for (const b of wrapper.querySelectorAll('.chip-remove')) {
        b.dispatchEvent({ type: 'click', stopPropagation() {} });
      }
      textInput.value = '';
    },
  };
}

const h = await setup();

console.log('chipInput paste — Excel / CSV column (the regression)');

test('a column of rolls separated by CRLF becomes one chip each', () => {
  h.reset();
  h.paste('12700\r\n13000\r\n13200\r\n');
  assert.deepEqual(h.chips(), ['12700', '13000', '13200']);
  assert.equal(h.hidden.value, '12700,13000,13200');
});

test('bare LF newlines split too', () => {
  h.reset();
  h.paste('12700\n13000\n13200');
  assert.deepEqual(h.chips(), ['12700', '13000', '13200']);
});

test('a trailing newline does not add an empty chip', () => {
  h.reset();
  h.paste('12700\n13000\n');
  assert.deepEqual(h.chips(), ['12700', '13000']);
});

test('newlines never concatenate — the exact symptom that was reported', () => {
  h.reset();
  h.paste('12700\r\n13000\r\n13200\r\n');
  assert.ok(
    !h.chips().includes('127001300013200'),
    'rolls were merged into one value; clipboard text is being staged through the text input again',
  );
});

test('sub-roll suffixes survive a pasted column', () => {
  h.reset();
  h.paste('218600.000\r\n218601.000');
  assert.deepEqual(h.chips(), ['218600.000', '218601.000']);
});

test('text already typed in the box is kept and split with the paste', () => {
  h.reset();
  h.textInput.value = '99100';
  h.paste('\r\n12700\r\n13000');
  assert.deepEqual(h.chips(), ['99100', '12700', '13000']);
});

console.log('\nchipInput paste — the separators that already worked');

test('commas still split', () => {
  h.reset();
  h.paste('12700,13000,13200');
  assert.deepEqual(h.chips(), ['12700', '13000', '13200']);
});

test('tabs (an Excel row rather than a column) still split', () => {
  h.reset();
  h.paste('12700\t13000\t13200');
  assert.deepEqual(h.chips(), ['12700', '13000', '13200']);
});

test('spaces, semicolons, & + | still split', () => {
  h.reset();
  h.paste('12700 13000;13200&13400+13500|13600');
  assert.deepEqual(h.chips(), ['12700', '13000', '13200', '13400', '13500', '13600']);
});

test('mixed delimiters collapse rather than producing blanks', () => {
  h.reset();
  h.paste('  12700,,\r\n\r\n13000\t 13200 ');
  assert.deepEqual(h.chips(), ['12700', '13000', '13200']);
});

test('duplicates in a pasted column collapse to one chip', () => {
  h.reset();
  h.paste('12700\r\n13000\r\n12700');
  assert.deepEqual(h.chips(), ['12700', '13000']);
});

test('a single-token paste is left to the browser default', () => {
  h.reset();
  const ev = pasteEvent('12700');
  h.textInput.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, 'single token should not be intercepted');
  assert.deepEqual(h.chips(), []);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
