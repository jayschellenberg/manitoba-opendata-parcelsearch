// Unit tests for lib/compLabelLayout.js — the callout placement on the
// comparable-sales map. Every label must stay on screen, clear of every
// other label and every pin; a lone pin keeps its label beside it with no
// leader; a cluster spreads out with leaders that do not cross; and a
// label holds its slot while the camera pans.
//
// Run: cd web && node test/compLabelLayout.test.js

import assert from 'node:assert/strict';
import { solveCompLabels, pinBox, PIN_HEAD_UP, nearestOnBox } from '../src/lib/compLabelLayout.js';

const VIEW = { width: 760, height: 290 };
const labelW = (text) => Math.round(text.length * 7.2 + 12);
const item = (key, x, y, text = `Sale #${key} – $12,345/ac`) => ({ key: String(key), x, y, w: labelW(text), h: 21 });

function boxOf(it, p) {
  const cx = it.x + p.dx;
  const cy = it.y + p.dy;
  return { x0: cx - it.w / 2, y0: cy - it.h / 2, x1: cx + it.w / 2, y1: cy + it.h / 2 };
}
const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

function assertClean(items, res, view = VIEW) {
  const boxes = items.map((it) => boxOf(it, res.get(it.key)));
  boxes.forEach((b, i) => {
    assert.ok(b.x0 >= 0 && b.y0 >= 0 && b.x1 <= view.width && b.y1 <= view.height, `label ${items[i].key} off screen`);
    for (let j = i + 1; j < boxes.length; j++) assert.ok(!hit(b, boxes[j]), `labels ${items[i].key} and ${items[j].key} overlap`);
    for (const o of items) assert.ok(!hit(b, pinBox(o.x, o.y)), `label ${items[i].key} covers pin ${o.key}`);
  });
}

// ---- a lone pin: label beside it, no leader ---------------------------
{
  const items = [item(1, 300, 150)];
  const res = solveCompLabels(items, VIEW);
  assert.equal(res.get('1').leader, false);
  assert.equal(res.get('1').slot, 0, 'first choice is to the right of the pin');
  assertClean(items, res);
}

// ---- a pin at the right edge: the label goes left, still no leader -----
{
  const items = [item(1, 740, 150)];
  const res = solveCompLabels(items, VIEW);
  assert.equal(res.get('1').leader, false);
  assert.ok(res.get('1').dx < 0, 'label flips to the left of the pin');
  assertClean(items, res);
}

// ---- a tight cluster (West St. Paul, Sales #1/#5/#6/#7/#10) ------------
{
  const items = [
    item(1, 400, 160), item(5, 408, 168), item(6, 415, 158), item(7, 402, 150), item(10, 411, 152),
    item(8, 395, 185), item('S', 430, 90, 'Subject Property'),
  ];
  const res = solveCompLabels(items, VIEW);
  assertClean(items, res);
  assert.ok([...res.values()].some((p) => p.leader), 'a crowded label leaves its pin');
  // Leaders from the pin heads must not cross.
  const segs = items.filter((it) => res.get(it.key).leader).map((it) => {
    const b = boxOf(it, res.get(it.key));
    const [lx, ly] = nearestOnBox(b, it.x, it.y - PIN_HEAD_UP);
    return [it.x, it.y - PIN_HEAD_UP, lx, ly];
  });
  const cross = ([ax, ay, bx, by], [cx, cy, dx, dy]) => {
    const o = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
    return o(cx, cy, dx, dy, ax, ay) * o(cx, cy, dx, dy, bx, by) < 0 && o(ax, ay, bx, by, cx, cy) * o(ax, ay, bx, by, dx, dy) < 0;
  };
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) assert.ok(!cross(segs[i], segs[j]), 'leaders cross');
}

// ---- 12 comps spread across a map with two crowded pairs ---------------
{
  const items = [
    item(24, 180, 240), item(27, 182, 228), item(29, 420, 150), item(30, 432, 152), item(26, 470, 138),
    item(28, 300, 160), item(31, 400, 80), item(32, 90, 70), item(25, 520, 80), item(33, 600, 30),
    item(34, 640, 25), item('S', 560, 130, 'Subject Property'),
  ];
  assertClean(items, solveCompLabels(items, VIEW));
}

// ---- hysteresis: a 3 px pan keeps every slot ---------------------------
{
  const items = [item(1, 400, 160), item(2, 410, 166), item(3, 404, 150), item(4, 395, 172)];
  const first = solveCompLabels(items, VIEW);
  const moved = items.map((it) => ({ ...it, x: it.x + 3, y: it.y - 2 }));
  const second = solveCompLabels(moved, VIEW, first);
  for (const it of items) assert.equal(second.get(it.key).slot, first.get(it.key).slot, `label ${it.key} hopped on a small pan`);
}

// ---- once the cluster opens up (zoomed in) labels return to their pins --
{
  const items = [item(1, 150, 150), item(2, 450, 150)];
  const crowded = solveCompLabels([item(1, 300, 150), item(2, 306, 152)], VIEW);
  const res = solveCompLabels(items, VIEW, crowded);
  assert.equal(res.get('1').leader, false);
  assert.equal(res.get('2').leader, false);
}

console.log('compLabelLayout: all tests passed');
