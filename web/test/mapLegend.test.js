// Unit tests for lib/mapLegend.js — capturing the on-screen legends into
// the Generate Map image.
//
// The layout step carries the judgement: legends stack upward from above
// the credit pill, and a tall one has to give up rows rather than cover the
// map it exists to explain. Pure, so node can pin every branch.
//
// Run: cd web && node test/mapLegend.test.js

import assert from 'node:assert/strict';
import {
  readMapLegends,
  layoutMapLegends,
  paintMapLegends,
  LEGEND_MAX_HEIGHT_RATIO,
  LEGEND_MAX_WIDTH_RATIO,
} from '../src/lib/mapLegend.js';

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

// ---- DOM stand-ins -------------------------------------------------
// Just enough of the shape readMapLegends walks: querySelector(All),
// hidden, offsetParent, textContent.

function el({ tag = 'div', cls = '', text = '', children = [], hidden = false, visible = true }) {
  const node = {
    tag, cls, hidden,
    offsetParent: visible ? {} : null,
    children,
    get textContent() {
      return text || children.map((c) => c.textContent).join('');
    },
    querySelector(sel) { return node.querySelectorAll(sel)[0] ?? null; },
    querySelectorAll(sel) {
      const want = sel.replace(/^[.]/, '');
      const byClass = sel.startsWith('.');
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (byClass ? c.cls.split(/\s+/).includes(want) : c.tag === want) out.push(c);
          walk(c);
        }
      };
      walk(node);
      return out;
    },
  };
  return node;
}

const swatch = (color) => el({ tag: 'span', cls: 'swatch', text: '', children: [] , });
const item = (color, label) => el({ tag: 'li', children: [swatch(color), el({ tag: 'span', text: label })] });
const legendEl = (title, items, opts = {}) => el({
  cls: 'map-legend',
  children: [el({ tag: 'strong', text: title }), el({ tag: 'ul', children: items })],
  ...opts,
});

const fakeComputed = (colors) => {
  let i = 0;
  return () => ({ backgroundColor: colors[i++ % colors.length] });
};

// ---------- readMapLegends ----------

console.log('readMapLegends');

test('reads title, swatch colour and label from a legend', () => {
  const root = el({ children: [legendEl('MASC soil rating', [item('#fff8c8', 'A — best'), item('#9c27b0', 'J — worst')])] });
  const out = readMapLegends(root, { getComputedStyle: fakeComputed(['rgb(255, 248, 200)', 'rgb(156, 39, 176)']) });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'MASC soil rating');
  assert.deepEqual(out[0].items.map((i) => i.label), ['A — best', 'J — worst']);
  assert.equal(out[0].items[0].color, 'rgb(255, 248, 200)');
});

test('hidden legends are skipped', () => {
  const root = el({ children: [
    legendEl('Zoning category', [item('#fff', 'Agricultural')], { hidden: true }),
    legendEl('MASC soil rating', [item('#fff', 'A')]),
  ] });
  const out = readMapLegends(root, { getComputedStyle: fakeComputed(['rgb(0, 0, 0)']) });
  assert.deepEqual(out.map((l) => l.title), ['MASC soil rating']);
});

test('a legend with no offsetParent (display:none ancestor) is skipped', () => {
  const root = el({ children: [legendEl('Flow', [item('#fff', '< 500')], { visible: false })] });
  assert.deepEqual(readMapLegends(root, { getComputedStyle: fakeComputed(['rgb(0,0,0)']) }), []);
});

test('a legend with no list items is dropped, not drawn empty', () => {
  const root = el({ children: [legendEl('CLI', [])] });
  assert.deepEqual(readMapLegends(root, { getComputedStyle: fakeComputed(['rgb(0,0,0)']) }), []);
});

test('several visible legends come back in document order', () => {
  const root = el({ children: [
    legendEl('Zoning category', [item('#a', 'Agricultural')]),
    legendEl('Dominant land cover (2020)', [item('#b', 'Cultivated')]),
  ] });
  const out = readMapLegends(root, { getComputedStyle: fakeComputed(['rgb(1,1,1)']) });
  assert.deepEqual(out.map((l) => l.title), ['Zoning category', 'Dominant land cover (2020)']);
});

test('a missing root or no legends yields []', () => {
  assert.deepEqual(readMapLegends(null), []);
  assert.deepEqual(readMapLegends(el({ children: [] })), []);
});

// ---------- layoutMapLegends ----------

console.log('\nlayoutMapLegends');

// Fixed-width measure so the maths is predictable: 7 px per character.
const measure = (text) => text.length * 7;
const opts = (over = {}) => ({ width: 1000, height: 800, bottomY: 760, font: 12, measure, ...over });
const legend = (title, n) => ({
  title,
  items: Array.from({ length: n }, (_, i) => ({ color: `rgb(${i},0,0)`, label: `row ${i + 1}` })),
});

test('a single legend sits at the bottom-right, above the credit pill', () => {
  const [box] = layoutMapLegends([legend('MASC', 4)], opts());
  assert.equal(box.x + box.w, 1000 - 6, 'right-aligned with a 6 px margin');
  assert.equal(box.y + box.h, 760, 'its bottom edge is the supplied bottomY');
  assert.equal(box.overflow, 0);
  assert.equal(box.items.length, 4);
});

test('legends stack upward, first one lowest', () => {
  const boxes = layoutMapLegends([legend('One', 3), legend('Two', 3)], opts());
  assert.equal(boxes.length, 2);
  assert.ok(boxes[1].y + boxes[1].h < boxes[0].y, 'the second sits entirely above the first');
});

test('a tall legend gives up rows rather than cover the map', () => {
  // 40 rows cannot fit in 62% of an 800 px image.
  const [box] = layoutMapLegends([legend('Zoning category', 40)], opts());
  assert.ok(box.overflow > 0, 'it reports what it dropped');
  assert.equal(box.items.length + box.overflow, 40, 'every row is accounted for');
  const ceiling = Math.round(800 * (1 - LEGEND_MAX_HEIGHT_RATIO));
  assert.ok(box.y >= ceiling, 'and it stays below the ceiling');
});

test('the height ceiling is respected across the whole stack', () => {
  const boxes = layoutMapLegends(
    [legend('One', 10), legend('Two', 10), legend('Three', 10), legend('Four', 10)],
    opts(),
  );
  const ceiling = Math.round(800 * (1 - LEGEND_MAX_HEIGHT_RATIO));
  for (const b of boxes) assert.ok(b.y >= ceiling, `box top ${b.y} must stay below ${ceiling}`);
});

test('a legend that cannot show two rows is dropped entirely', () => {
  // Squeeze bottomY down to just above the ceiling: better nothing than a
  // stub box that names the legend and shows none of it.
  const ceiling = Math.round(800 * (1 - LEGEND_MAX_HEIGHT_RATIO));
  const bottomY = ceiling + 26;                       // ~1 row of headroom
  assert.ok(bottomY - ceiling < Math.round(12 * 1.45) * 2, 'precondition: under two rows of room');
  assert.deepEqual(layoutMapLegends([legend('MASC', 10)], opts({ bottomY })), []);
});

test('a short legend still fits where a tall one was dropped', () => {
  // The drop is about available room, not about the legend being long. A
  // titled 2-row legend needs padY*2 + title + 2 rows = 65 px at font 12.
  const ceiling = Math.round(800 * (1 - LEGEND_MAX_HEIGHT_RATIO));
  const boxes = layoutMapLegends([legend('MASC', 2)], opts({ bottomY: ceiling + 80 }));
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].overflow, 0);
  assert.equal(boxes[0].items.length, 2);
});

test('box width follows the widest row and is capped', () => {
  const short = layoutMapLegends([legend('T', 2)], opts())[0];
  const long = layoutMapLegends([{
    title: 'T',
    items: [{ color: 'rgb(0,0,0)', label: 'a'.repeat(400) }],
  }], opts())[0];
  assert.ok(long.w > short.w, 'a longer label widens the box');
  assert.ok(long.w <= Math.ceil(1000 * LEGEND_MAX_WIDTH_RATIO), 'but not past the width cap');
});

test('the title is included in the width calculation', () => {
  const narrowTitle = layoutMapLegends([{ title: 'T', items: [{ color: null, label: 'x' }] }], opts())[0];
  const wideTitle = layoutMapLegends([{ title: 'A very long legend title indeed', items: [{ color: null, label: 'x' }] }], opts())[0];
  assert.ok(wideTitle.w > narrowTitle.w);
});

test('empty and malformed input is ignored', () => {
  assert.deepEqual(layoutMapLegends([], opts()), []);
  assert.deepEqual(layoutMapLegends(null, opts()), []);
  assert.deepEqual(layoutMapLegends([{ title: 'x', items: [] }, null], opts()), []);
});

// ---------- paintMapLegends ----------

console.log('\npaintMapLegends');

function fakeCtx() {
  const calls = [];
  return {
    calls,
    set font(v) { calls.push(['font', v]); },
    set fillStyle(v) { calls.push(['fillStyle', v]); },
    set strokeStyle(v) { calls.push(['strokeStyle', v]); },
    set lineWidth(v) {},
    set textBaseline(v) {},
    fillRect(...a) { calls.push(['fillRect', ...a]); },
    strokeRect(...a) { calls.push(['strokeRect', ...a]); },
    fillText(...a) { calls.push(['fillText', ...a]); },
  };
}

test('paints a panel, its title, and a swatch + label per row', () => {
  const boxes = layoutMapLegends([legend('MASC', 3)], opts());
  const ctx = fakeCtx();
  paintMapLegends(ctx, boxes, { font: 12, bodyFont: '12px x', titleFont: '600 13px x' });
  const texts = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.deepEqual(texts, ['MASC', 'row 1', 'row 2', 'row 3']);
  const swatches = ctx.calls.filter((c) => c[0] === 'fillRect');
  assert.equal(swatches.length, 4, 'one panel background + three swatches');
});

test('an overflowing legend paints the "+N more" line', () => {
  const boxes = layoutMapLegends([legend('Zoning category', 40)], opts());
  const ctx = fakeCtx();
  paintMapLegends(ctx, boxes, { font: 12, bodyFont: '12px x', titleFont: '600 13px x' });
  const texts = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.ok(texts[texts.length - 1].startsWith('+'), `expected a +N more line, got ${texts[texts.length - 1]}`);
  assert.equal(texts[texts.length - 1], `+${boxes[0].overflow} more`);
});

test('a row with no colour paints its label but no swatch', () => {
  const boxes = layoutMapLegends([{ title: '', items: [{ color: null, label: 'no swatch' }] }], opts());
  const ctx = fakeCtx();
  paintMapLegends(ctx, boxes, { font: 12, bodyFont: '12px x', titleFont: '600 13px x' });
  assert.equal(ctx.calls.filter((c) => c[0] === 'fillRect').length, 1, 'panel background only');
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]), ['no swatch']);
});

test('nothing to paint is a no-op', () => {
  const ctx = fakeCtx();
  paintMapLegends(ctx, [], {});
  assert.equal(ctx.calls.length, 0);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
