// muniLayer.js — municipal boundaries on the map, as a selection surface for
// the MAO Sales Database picker.
//
// Two jobs, both about answering "which areas am I about to load?" without
// reading a list of 186 names:
//
//   * a light outline for every municipality the archive holds, so the
//     province reads as a map rather than a dropdown;
//   * a tinted fill for the ones selected, and a lighter tint for the ones
//     pulled in by the adjacent option — the same distinction the checkbox
//     list draws, so the two views never disagree.
//
// Clicking a municipality toggles it, which is the reverse direction: the map
// drives the panel's selection through the callback it was given.
//
// Boundaries come from public/mb-municipalities.geojson (Manitoba's own
// municipal boundary file, 522 KB, keyed by MUNI_NO — the same key the sales
// export and the picker use). Fetched once, lazily, the first time the layer
// is asked for: the Property Search tab never needs it.

import { isMeasuring } from './measuring.js';

const SRC   = 'mb-munis';
const FILL  = 'mb-munis-fill';
const LINE  = 'mb-munis-line';
const HOVER = 'mb-munis-hover';
const URL   = 'mb-municipalities.geojson';

let loading = null;     // in-flight fetch, so two callers share one request
let featureIds = null;  // Map<muni_no, feature id> for feature-state
let featureBbox = null; // Map<muni_no, [w,s,e,n]> so the map can frame a selection

/** [w,s,e,n] of any GeoJSON geometry, without pulling in a geometry library. */
function bboxOf(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
      return;
    }
    for (const part of c) walk(part);
  };
  if (geom?.coordinates) walk(geom.coordinates);
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/**
 * addSource/addLayer throw "Style is not done loading" if called too early,
 * and the app's mapReady resolves before that point — every other layer in
 * the app is added from inside the map's own load handler, so nothing hit
 * this until now. Wait for the style rather than racing it.
 */
function whenStyleReady(map) {
  if (map.isStyleLoaded()) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (!map.isStyleLoaded()) return;
      map.off('styledata', check);
      resolve();
    };
    map.on('styledata', check);
    check();
  });
}

/** Fetch + add the source/layers once. Safe to call repeatedly. */
async function ensureLayer(map) {
  if (map.getSource(SRC)) return true;
  await whenStyleReady(map);
  if (map.getSource(SRC)) return true;
  if (!loading) {
    loading = fetch(URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .catch((err) => { loading = null; throw err; });
  }
  const fc = await loading;
  if (map.getSource(SRC)) return true;   // another caller won the race

  // Stable ids so feature-state survives re-renders; MUNI_NO is the natural
  // key but is not guaranteed numeric-safe as an id, so index positionally
  // and keep a lookup.
  featureIds = new Map();
  featureBbox = new Map();
  fc.features.forEach((f, i) => {
    f.id = i;
    const no = String(f.properties?.MUNI_NO ?? '');
    featureIds.set(no, i);
    const bb = bboxOf(f.geometry);
    if (bb) featureBbox.set(no, bb);
  });

  map.addSource(SRC, { type: 'geojson', data: fc, promoteId: undefined });

  // Fill first so the outline draws over it. Both sit UNDER the parcel
  // layers — this is context, not the subject, and must never obscure a
  // parcel the user is actually looking at.
  const under = map.getLayer('parcel-fill') ? 'parcel-fill' : undefined;
  map.addLayer({
    id: FILL,
    type: 'fill',
    source: SRC,
    paint: {
      // Selection is carried by the OUTLINE, not a fill (Jason,
      // 2026-08-11): a tinted municipality washes over the parcels and
      // sales dots inside it, which are the things actually being read.
      // The fill is kept only as a hover cue — a whisper, so the cursor
      // has something to land on without hiding anything.
      'fill-color': '#1d4ed8',
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false], 0.06,
        0,
      ],
    },
  }, under);
  map.addLayer({
    id: LINE,
    type: 'line',
    source: SRC,
    paint: {
      // Three states read by line weight and colour alone:
      //   selected           — strong blue, findable zoomed out
      //   adjacent (derived) — same hue, thinner and paler
      //   neither            — hairline grey, just context
      'line-color': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], '#1d4ed8',
        ['boolean', ['feature-state', 'adjacent'], false], '#60a5fa',
        '#94a3b8',
      ],
      'line-width': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 2.4,
        ['boolean', ['feature-state', 'adjacent'], false], 1.6,
        0.6,
      ],
      'line-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 1,
        ['boolean', ['feature-state', 'adjacent'], false], 0.9,
        0.55,
      ],
    },
  }, under);
  return true;
}

/** Which municipalities exist in the archive — everything else is hidden. */
export async function showMuniLayer(map, presentMuniNos) {
  await ensureLayer(map);
  const list = [...(presentMuniNos || [])].map(String);
  // An empty archive would filter to nothing; show all rather than a blank
  // map, since the layer is also the "where am I" backdrop.
  const filter = list.length
    ? ['in', ['to-string', ['get', 'MUNI_NO']], ['literal', list]]
    : null;
  for (const id of [FILL, LINE]) {
    if (!map.getLayer(id)) continue;
    map.setFilter(id, filter);
    map.setLayoutProperty(id, 'visibility', 'visible');
  }
}

export function hideMuniLayer(map) {
  for (const id of [FILL, LINE]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  }
}

/**
 * Paint the current selection.
 * @param {Set<string>} effective every municipality a load would cover
 * @param {Set<string>} picked    the subset the user chose explicitly
 */
export function paintMuniSelection(map, effective, picked) {
  if (!map.getSource(SRC) || !featureIds) return;
  for (const [no, id] of featureIds) {
    const isPicked = picked?.has(no);
    const isEff    = effective?.has(no);
    map.setFeatureState({ source: SRC, id }, {
      selected: Boolean(isPicked),
      adjacent: Boolean(isEff && !isPicked),
    });
  }
}

/**
 * Frame the selected municipalities.
 *
 * Called on every selection change so the map follows what is ticked —
 * picking Gimli from a province-wide view is otherwise a highlight you
 * cannot see. Does nothing when the selection is empty (there is nothing
 * to frame, and snapping back to the whole province on the last untick is
 * disorienting) or while the user is mid-gesture, so it never yanks the
 * view out from under a pan or zoom.
 *
 * @param {Set<string>} muniNos the municipalities to bring into view
 */
export function fitToSelection(map, muniNos, { duration = 600 } = {}) {
  if (!featureBbox || !muniNos?.size) return;
  if (map.isMoving?.() || map.isZooming?.()) return;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const no of muniNos) {
    const bb = featureBbox.get(String(no));
    if (!bb) continue;
    if (bb[0] < w) w = bb[0];
    if (bb[1] < s) s = bb[1];
    if (bb[2] > e) e = bb[2];
    if (bb[3] > n) n = bb[3];
  }
  if (!Number.isFinite(w)) return;
  // maxZoom so a single small town does not slam to street level — the
  // point is to see the municipality and its surroundings, not a rooftop.
  map.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: 11, duration });
}

/**
 * Click a municipality to toggle it; hover to highlight.
 * `onToggle(muniNo)` returns truthy when the click was accepted, so a click
 * on a municipality the archive does not hold leaves the cursor alone.
 *
 * `contentAt(point)` reports whether ANY layer above this backdrop is drawn
 * at that point, so the picker can defer to it. Injected rather than
 * imported because the answer needs map.js's layer ids, and this module has
 * to stay loadable under node — map.js pulls in maplibre, turf and
 * mapbox-gl-draw. Omitted, the picker answers every click on the fill, as
 * it always did.
 */
export function wireMuniInteractions(map, onToggle, { contentAt } = {}) {
  let hovered = null;
  const setHover = (id, on) => {
    if (id == null) return;
    map.setFeatureState({ source: SRC, id }, { hover: on });
  };
  const dropHover = () => {
    setHover(hovered, false); hovered = null;
    map.getCanvas().style.cursor = '';
  };
  // Two ways this backdrop stands down, both because a toggle here refits
  // the map to the municipality (maxZoom 11) — a big move to make off a
  // click the user aimed at something else.
  //
  //   - A measurement owns the pointer: every click is placing a vertex,
  //     and this layer blankets the province, so it would otherwise toggle
  //     a municipality under every vertex.
  //   - ANYTHING is drawn over it at that point: a sale, zoning, the
  //     Assessment Parcels fabric. These boundaries are the lowest vector
  //     layer on the map and MapLibre fires every layer's handler under the
  //     point, so this one answers only where it is the only thing there.
  //
  // The tint and pointer cursor go with the click in both cases; the cursor
  // is written here directly, so left alone it would overwrite the draw
  // tool's crosshair.
  const standDown = (point) => isMeasuring() || (point ? Boolean(contentAt?.(point)) : false);
  map.on('mousemove', FILL, (e) => {
    if (standDown(e.point)) { dropHover(); return; }
    const f = e.features?.[0];
    if (!f) return;
    if (hovered !== f.id) { setHover(hovered, false); hovered = f.id; setHover(hovered, true); }
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL, dropHover);
  map.on('click', FILL, (e) => {
    if (standDown(e.point)) return;
    const no = e.features?.[0]?.properties?.MUNI_NO;
    if (no == null) return;
    onToggle?.(String(no));
  });
}
