// Screen-space placement for the comparable-sales map's callout boxes
// ("Sale #3 – $12,108/ac"), Jason 2026-10-20.
//
// The report maps he builds by hand put each label beside its pin, and where
// pins crowd together the label moves out to clear space with a line back to
// its pin. MapLibre's own collision only HIDES a label that does not fit, so a
// cluster of five comps would print two numbers. This solver keeps every
// label: each takes the first clear spot beside its pin and, failing that,
// walks outward ring by ring until it finds room, and the map draws a leader
// line for any label that left its pin.
//
// Rectangles, not the parcel callouts' discs (lib/calloutPlacement.js) — a
// "Sale #12 – $40,441/ac" box is six times wider than it is tall, and
// treating it as a circle would space a cluster out far too much. The
// hysteresis rule and the no-crossing leaders are borrowed from that solver.
//
// Pure: it takes projected pixel positions and returns pixel offsets, so it
// unit-tests without a map (test/compLabelLayout.test.js).

/** The pin as drawn by chartMap.js: 26 x 38 CSS px, tip at the point. */
export const PIN_W = 26;
export const PIN_H = 38;
/** The pin head's centre, measured up from the tip — where a leader starts. */
export const PIN_HEAD_UP = 25;

/** Gap between a label and its own pin when it sits beside it. */
const GAP = 3;
/** Clearance needed to move INTO a slot, and to keep one already held. */
const PAD_TAKE = 4;
const PAD_KEEP = 1;
/** Leader rings: first radius from the pin head, step, and how many. */
const RING_START = 34;
const RING_STEP = 20;
const RING_COUNT = 13;
const SLOT_ARC = 26;
/** Nearby pins (within this many px) push a label's preferred direction away from them. */
const CROWD_PX = 160;

/** Rectangle of a pin standing on (x, y), with `pad` added round it. */
export function pinBox(x, y, pad = 0) {
  return { x0: x - PIN_W / 2 - pad, y0: y - PIN_H - pad, x1: x + PIN_W / 2 + pad, y1: y + pad };
}

/**
 * The slots beside a pin, centre offsets from the pin TIP, best first:
 * right, left, above, below, then the four corners. A label here touches
 * its pin and needs no leader.
 */
function besideSlots(w, h) {
  const right = PIN_W / 2 + GAP + w / 2;
  const headY = -PIN_HEAD_UP;
  const above = -(PIN_H + GAP + h / 2);
  const below = GAP + h / 2;
  return [
    [right, headY], [-right, headY], [0, above], [0, below],
    [right, above + h / 2], [-right, above + h / 2], [right, below - h / 2], [-right, below - h / 2],
  ];
}

/**
 * Leader slots: rings round the pin head, each slot a box whose near edge
 * is `r` px out in its direction. Ordered by ring, and within a ring by how
 * far the direction swings off `baseAngle` (nearest first).
 */
function ringSlots(w, h, baseAngle) {
  const out = [];
  for (let ring = 0; ring < RING_COUNT; ring++) {
    const r = RING_START + ring * RING_STEP;
    const count = Math.max(8, Math.round((2 * Math.PI * r) / SLOT_ARC));
    const step = (2 * Math.PI) / count;
    for (let k = 0; k < count; k++) {
      const a = baseAngle + (k % 2 === 1 ? -1 : 1) * Math.ceil(k / 2) * step;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      out.push([ux * (r + w / 2), -PIN_HEAD_UP + uy * (r + h / 2)]);
    }
  }
  return out;
}

const overlaps = (a, b, pad) => a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.y0 < b.y1 + pad && a.y1 > b.y0 - pad;
const overlapArea = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** The point on box `b` nearest (x, y) — where a leader meets its label. */
export function nearestOnBox(b, x, y) {
  return [Math.min(Math.max(x, b.x0), b.x1), Math.min(Math.max(y, b.y0), b.y1)];
}

function segmentsCross([ax, ay, bx, by], [cx, cy, dx, dy]) {
  const o = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(cx, cy, dx, dy, ax, ay);
  const d2 = o(cx, cy, dx, dy, bx, by);
  const d3 = o(ax, ay, bx, by, cx, cy);
  const d4 = o(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when segment a-b passes through box `r` (Liang–Barsky clip). */
function segmentHitsBox([ax, ay, bx, by], r) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  for (const [p, q] of [[-dx, ax - r.x0], [dx, r.x1 - ax], [-dy, ay - r.y0], [dy, r.y1 - ay]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t1 - t0 > 0.02;
}

/**
 * Place every label.
 *
 * `items`: [{key, x, y, w, h}] — x, y the pin TIP in screen px, w, h the
 * label box — in priority order (comp 1 first). `view`: {width, height}.
 * `prev`: the Map this returned last time; a label keeps a slot it already
 * holds while that slot still works, so labels do not hop as the map pans.
 * `extraObstacles`: boxes nothing may cover (another legend, say).
 *
 * Returns Map key -> {dx, dy, leader, slot}: the label CENTRE as an offset
 * from the pin tip, and whether it left its pin (and so needs a leader).
 */
export function solveCompLabels(items, view, prev = null, extraObstacles = []) {
  const out = new Map();
  const pins = items.map((it) => ({ key: it.key, box: pinBox(it.x, it.y) }));
  const placed = [];       // label boxes already down
  const leaders = [];      // [x1, y1, x2, y2] already drawn
  const inView = (b) => !view || (b.x0 >= 2 && b.y0 >= 2 && b.x1 <= view.width - 2 && b.y1 <= view.height - 2);
  const offscreen = (it) => view && (it.x < -300 || it.y < -300 || it.x > view.width + 300 || it.y > view.height + 300);

  for (const it of items) {
    if (offscreen(it)) { out.set(it.key, { dx: PIN_W / 2 + GAP + it.w / 2, dy: -PIN_HEAD_UP, leader: false, slot: 0 }); continue; }
    // Lean away from the neighbours: the preferred leader direction points
    // from the crowd's middle through this pin (up and right when alone).
    let mx = 0; let my = 0; let n = 0;
    for (const o of items) {
      if (o === it) continue;
      const d = Math.hypot(o.x - it.x, o.y - it.y);
      if (d < CROWD_PX) { mx += o.x; my += o.y; n += 1; }
    }
    const base = n && (mx / n !== it.x || my / n !== it.y)
      ? Math.atan2(it.y - my / n, it.x - mx / n)
      : -Math.PI / 4;
    const beside = besideSlots(it.w, it.h);
    const slots = [...beside, ...ringSlots(it.w, it.h, base)];
    const headX = it.x;
    const headY = it.y - PIN_HEAD_UP;

    const boxAt = ([dx, dy]) => ({
      x0: it.x + dx - it.w / 2, y0: it.y + dy - it.h / 2, x1: it.x + dx + it.w / 2, y1: it.y + dy + it.h / 2,
    });
    const leaderTo = (b) => { const [lx, ly] = nearestOnBox(b, headX, headY); return [headX, headY, lx, ly]; };
    const check = (s, pad, strict) => {
      const b = boxAt(slots[s]);
      if (!inView(b)) return false;
      for (const p of pins) if (overlaps(b, p.box, p.key === it.key ? 0 : pad)) return false;
      for (const q of placed) if (overlaps(b, q, pad)) return false;
      for (const q of extraObstacles) if (overlaps(b, q, pad)) return false;
      if (s >= beside.length && strict) {
        const seg = leaderTo(b);
        if (leaders.some((l) => segmentsCross(seg, l))) return false;
        for (const p of pins) if (p.key !== it.key && segmentHitsBox(seg, p.box)) return false;
        for (const q of placed) if (segmentHitsBox(seg, q)) return false;
      }
      return true;
    };

    const held = prev?.get(it.key)?.slot;
    let chosen = -1;
    for (const strict of [true, false]) {
      // A free beside-slot always wins, so a cluster that opens up as you
      // zoom in pulls its labels back to their pins.
      for (let s = 0; s < beside.length && chosen < 0; s++) if (check(s, PAD_TAKE, strict)) chosen = s;
      if (chosen < 0 && Number.isInteger(held) && held < slots.length && check(held, PAD_KEEP, strict)) chosen = held;
      for (let s = beside.length; s < slots.length && chosen < 0; s++) if (check(s, PAD_TAKE, strict)) chosen = s;
      if (chosen >= 0) break;
    }
    if (chosen < 0) {
      // Nowhere clear (a very dense cluster in a small map): the slot that
      // covers least, so every comp still has its label.
      let best = Infinity;
      for (let s = 0; s < slots.length; s++) {
        const b = boxAt(slots[s]);
        let cost = inView(b) ? 0 : 1e6;
        for (const p of pins) cost += overlapArea(b, p.box);
        for (const q of placed) cost += 2 * overlapArea(b, q);
        if (cost < best) { best = cost; chosen = s; }
      }
    }
    const [dx, dy] = slots[chosen];
    const b = boxAt(slots[chosen]);
    placed.push(b);
    const leader = chosen >= beside.length;
    if (leader) leaders.push(leaderTo(b));
    out.set(it.key, { dx, dy, leader, slot: chosen });
  }
  return out;
}
