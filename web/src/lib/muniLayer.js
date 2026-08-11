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

const SRC   = 'mb-munis';
const FILL  = 'mb-munis-fill';
const LINE  = 'mb-munis-line';
const HOVER = 'mb-munis-hover';
const URL   = 'mb-municipalities.geojson';

let loading = null;     // in-flight fetch, so two callers share one request
let featureIds = null;  // Map<muni_no, feature id> for feature-state

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
  fc.features.forEach((f, i) => {
    f.id = i;
    featureIds.set(String(f.properties?.MUNI_NO ?? ''), i);
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
      // Three states, deliberately distinguishable at a glance and in the
      // same blue family so it reads as one control:
      //   selected           — solid enough to find while zoomed out
      //   adjacent (derived) — visibly weaker, "coming along for the ride"
      //   neither            — transparent; the outline alone carries it
      'fill-color': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], '#1d4ed8',
        ['boolean', ['feature-state', 'adjacent'], false], '#60a5fa',
        '#000000',
      ],
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 0.28,
        ['boolean', ['feature-state', 'adjacent'], false], 0.14,
        ['boolean', ['feature-state', 'hover'], false], 0.08,
        0,
      ],
    },
  }, under);
  map.addLayer({
    id: LINE,
    type: 'line',
    source: SRC,
    paint: {
      'line-color': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], '#1d4ed8',
        '#94a3b8',
      ],
      'line-width': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 1.6,
        0.6,
      ],
      'line-opacity': 0.9,
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
 * Click a municipality to toggle it; hover to highlight.
 * `onToggle(muniNo)` returns truthy when the click was accepted, so a click
 * on a municipality the archive does not hold leaves the cursor alone.
 */
export function wireMuniInteractions(map, onToggle) {
  let hovered = null;
  const setHover = (id, on) => {
    if (id == null) return;
    map.setFeatureState({ source: SRC, id }, { hover: on });
  };
  map.on('mousemove', FILL, (e) => {
    const f = e.features?.[0];
    if (!f) return;
    if (hovered !== f.id) { setHover(hovered, false); hovered = f.id; setHover(hovered, true); }
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL, () => {
    setHover(hovered, false); hovered = null;
    map.getCanvas().style.cursor = '';
  });
  map.on('click', FILL, (e) => {
    const no = e.features?.[0]?.properties?.MUNI_NO;
    if (no == null) return;
    onToggle?.(String(no));
  });
}
