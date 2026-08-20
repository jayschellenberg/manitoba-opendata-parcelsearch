// Unit tests for the click gate on lib/muniLayer.js's municipality picker —
// the Sales-tab backdrop that toggles a municipality and refits the map to it
// at maxZoom 11.
//
// The bug this locks down (Jason, 2026-08-20): the boundary fill blankets the
// province and sits beneath everything, and MapLibre dispatches a click to
// every layer handler under the point independently. So a click aimed at a
// parcel drawn on top ALSO toggled the municipality underneath — and the
// refit yanked the view out from under the user. Measured on the Property-tab
// twin of this picker: zoom 17.5 to 10.69.
//
// The gate has to discriminate BY POINT, not globally: a click on a parcel
// stands down, a click on bare municipality a few pixels away still picks.
// Turning the picker off wholesale whenever parcels exist would break the
// gesture exactly when it is most useful.
//
// wireMuniInteractions needs a map, so this drives a fake one that records the
// handlers it registers and lets the test fire them. That is the only way this
// path can be tested at all — map.js cannot load under node (maplibre, turf,
// mapbox-gl-draw) and the real map needs a compositing canvas.
//
// Run: cd web && node test/muniLayerGate.test.js

import assert from 'node:assert/strict';
import { wireMuniInteractions } from '../src/lib/muniLayer.js';

/** A map that records handlers instead of rendering, plus the calls made. */
function harness({ contentAt } = {}) {
  const handlers = new Map();          // `${event}:${layer}` -> fn
  const calls = { toggled: [], cursor: [], hover: [] };
  const map = {
    on: (event, layer, fn) => handlers.set(`${event}:${layer}`, fn),
    setFeatureState: (target, state) => calls.hover.push([target.id, state.hover]),
    getCanvas: () => ({ style: { set cursor(v) { calls.cursor.push(v); }, get cursor() { return ''; } } }),
  };
  wireMuniInteractions(map, (no) => calls.toggled.push(no), { contentAt });
  const fire = (key, point) =>
    handlers.get(key)?.({ point, features: [{ id: 7, properties: { MUNI_NO: '172' } }] });
  return { calls, fire, handlers };
}

const ON_CONTENT = { x: 20, y: 20 };   // a parcel, zoning polygon, anything
const ON_BARE    = { x: 196, y: 20 };  // bare municipality, nothing drawn over it
/** Stands in for map.js's contentLayerOwnsPoint: true over ON_CONTENT only. */
const contentAt = (p) => p?.x === ON_CONTENT.x && p?.y === ON_CONTENT.y;

// ---- the regression: a parcel click must not toggle ---------------------
{
  const h = harness({ contentAt });
  h.fire('click:mb-munis-fill', ON_CONTENT);
  assert.deepEqual(h.calls.toggled, [], 'a click on a parcel must not toggle the municipality under it');
}

// ---- ...but bare municipality still picks, same session -----------------
{
  const h = harness({ contentAt });
  h.fire('click:mb-munis-fill', ON_BARE);
  assert.deepEqual(h.calls.toggled, ['172'], 'a click on bare municipality still picks');
}

// ---- both, in one session: the gate is per-point, not a global off ------
{
  const h = harness({ contentAt });
  h.fire('click:mb-munis-fill', ON_CONTENT);
  h.fire('click:mb-munis-fill', ON_BARE);
  h.fire('click:mb-munis-fill', ON_CONTENT);
  assert.deepEqual(h.calls.toggled, ['172'],
    'exactly the bare-municipality click gets through; parcels stay inert either side of it');
}

// ---- hover follows the click: no tint, no pointer over a parcel ---------
{
  const h = harness({ contentAt });
  h.fire('mousemove:mb-munis-fill', ON_CONTENT);
  assert.deepEqual(h.calls.hover.filter(([, on]) => on), [],
    'no municipality is tinted while the cursor is over a parcel');
  assert.ok(!h.calls.cursor.includes('pointer'),
    'no pointer cursor over a parcel — it would claim a click this layer will not answer');
}

// ---- hover over bare municipality still paints --------------------------
{
  const h = harness({ contentAt });
  h.fire('mousemove:mb-munis-fill', ON_BARE);
  assert.deepEqual(h.calls.hover.filter(([, on]) => on), [[7, true]], 'bare municipality tints on hover');
  assert.ok(h.calls.cursor.includes('pointer'), 'and offers the pointer cursor');
}

// ---- no contentAt supplied: unchanged behaviour --------------------------
// The injection is optional so the picker still works for any caller that
// does not wire it; without it every click on the fill is answered.
{
  const h = harness({});
  h.fire('click:mb-munis-fill', ON_CONTENT);
  assert.deepEqual(h.calls.toggled, ['172'], 'without contentAt the picker answers as it always did');
}

console.log('muniLayerGate.test.js: all assertions passed');
