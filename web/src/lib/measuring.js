/*
 * "A measurement is in progress" as one shared predicate.
 *
 * MeasureControl (map.js) stamps `measuring` on <body> while its panel is
 * open; the CSS hides the bottom-right map legends off the same class. The
 * flag matters far beyond the legends though: for as long as it is set the
 * measurement owns the pointer. Every click is placing a vertex, not asking
 * a question of the map, so each interaction handler — hover tooltips,
 * popups, the click-a-municipality pickers — has to stand down or it
 * answers a click that was never meant for it.
 *
 * That is not a cosmetic concern. The Property Search muni picker is armed
 * until a search has run, so before this gate existed the first vertex
 * click silently re-scoped the search to whatever municipality sat under it
 * and the second flew the map to that municipality's full extent — the user
 * saw the map zoom itself out from a rooftop to a whole town, mid-measure.
 *
 * Lives in lib/ rather than map.js so modules that wire their own map
 * handlers (muniLayer.js) can read it without importing map.js, which pulls
 * in maplibre, turf and mapbox-gl-draw and cannot load under node.
 */

/** The <body> class MeasureControl toggles. Also matched in style.css. */
export const MEASURING_CLASS = 'measuring';

/** Open/close the flag. Call from both ends of the panel's lifecycle —
 *  a stuck `true` leaves the whole map inert to clicks. */
export function setMeasuring(on) {
  if (typeof document === 'undefined') return;
  document.body?.classList.toggle(MEASURING_CLASS, Boolean(on));
}

/** True while the measurement panel is open. */
export function isMeasuring() {
  if (typeof document === 'undefined') return false;
  return Boolean(document.body?.classList.contains(MEASURING_CLASS));
}
