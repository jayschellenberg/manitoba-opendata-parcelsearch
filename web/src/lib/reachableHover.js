/*
 * Reachable hover popup — a MapLibre hover popup the pointer can get to.
 *
 * A hover popup that follows the cursor and is rebuilt on every mousemove
 * can be read but never clicked: any move toward it either drags it along
 * or swaps it for the parcel the pointer crosses on the way. This wraps
 * one popup so that (ported from the Winnipeg app's map.js, 2026-11-05):
 *
 *   - within `reachPx` of the popup it holds still and keeps its content
 *     for as long as the pointer stays that close
 *   - anywhere in the funnel between where it was placed and the popup
 *     (lib/hoverReach.js) it holds for `lingerMs`, so a wobbly or
 *     diagonal path still arrives
 *   - outside both it behaves as before (follows, swaps instantly), so
 *     scanning across parcels stays immediate
 *   - leaving every parcel, or the map, keeps it `lingerMs`
 *   - with the pointer on it, it stays until the pointer leaves
 *
 * A target is { key, html, lngLat, fit?, wire? }. `key` says "same
 * parcel" (same key, new html = the content refreshed in place, e.g. a
 * soil composition landing). `wire(popup)` attaches the link handlers
 * (Copy Roll, GPS, ...) and runs after every setHTML, because setHTML
 * replaces the DOM the listeners were on. `fit` picks the corner anchor
 * and height cap so a tall popup scrolls inside the map instead of
 * running past its edge with the links out of reach.
 */
import { reachZone } from './hoverReach.js';

export const HOVER_LINGER_MS = 1000;
export const HOVER_REACH_PX = 32;

export function createReachableHover(map, popup, {
  lingerMs = HOVER_LINGER_MS,
  reachPx = HOVER_REACH_PX,
} = {}) {
  let shown = null;        // the target the popup is showing now
  let overPopup = false;
  let lingerTimer = null;
  let pending = null;      // latest target seen while held
  let origin = null;       // canvas point the popup was last placed at

  /** The popup's box in map-canvas pixels, or null when closed. */
  const popupRect = () => {
    const el = popup.isOpen() ? popup.getElement() : null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const c = map.getCanvas().getBoundingClientRect();
    return { left: r.left - c.left, top: r.top - c.top, right: r.right - c.left, bottom: r.bottom - c.top };
  };
  const clearLinger = () => {
    if (lingerTimer) clearTimeout(lingerTimer);
    lingerTimer = null;
  };
  // Fit inside the map: MapLibre's auto-anchor puts the popup below the
  // point whenever it fits neither way, so the side is picked here
  // (whichever of above/below has more room) and the height capped to
  // that room. Popup has no setAnchor; options.anchor is what its update
  // reads, and setLngLat re-runs it. A target without `fit` goes back to
  // MapLibre's own anchoring.
  const position = (target) => {
    const content = popup.getElement()?.querySelector('.maplibregl-popup-content');
    if (!target.fit || !content) {
      popup.options.anchor = undefined;
      if (content) content.style.maxHeight = '';
      popup.setLngLat(target.lngLat);
      return;
    }
    const pos = map.project(target.lngLat);
    const H = map.getCanvas().clientHeight;
    const W = map.getCanvas().clientWidth;
    const below = H - pos.y;
    content.style.maxHeight = `${Math.max(120, Math.max(below, pos.y) - 16)}px`;
    popup.options.anchor = `${below >= pos.y ? 'top' : 'bottom'}-${pos.x < W / 2 ? 'left' : 'right'}`;
    popup.setLngLat(target.lngLat);
  };
  const setContent = (target) => {
    popup.setHTML(target.html);
    target.wire?.(popup);
  };
  const place = (target, pt) => {
    shown = target;
    origin = pt;
    popup.setLngLat(target.lngLat).setHTML(target.html).addTo(map);
    popup.addClassName?.('reachable-hover');   // style.css: scrolls when capped
    position(target);
    const el = popup.getElement();
    // remove() discards the container, so a re-added popup has a fresh
    // element; the flag keeps one listener pair per element.
    if (el && !el.dataset.hoverWired) {
      el.dataset.hoverWired = '1';
      el.addEventListener('mouseenter', () => { overPopup = true; clearLinger(); });
      el.addEventListener('mouseleave', () => { overPopup = false; pending = null; startLinger(); });
    }
    target.wire?.(popup);
  };
  const close = () => {
    shown = null;
    popup.remove();
  };
  function startLinger() {
    if (lingerTimer) return;
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      if (overPopup) return;
      const next = pending;
      pending = null;
      if (next) place(next, map.project(next.lngLat));
      else close();
    }, lingerMs);
  }

  return {
    /** Route one mousemove: `next` is the target under the pointer, or
     *  null for nothing; `pt` is the pointer in canvas pixels. */
    hoverTo(next, pt) {
      if (overPopup) return;
      if (!popup.isOpen()) {
        clearLinger();
        pending = null;
        shown = null;
        if (next) place(next, pt);
        return;
      }
      const zone = reachZone(pt, popupRect(), origin, reachPx);
      if (next && shown && next.key === shown.key) {
        // Same parcel: refresh content if it changed, and follow the
        // cursor unless it is on its way over.
        clearLinger();
        pending = null;
        if (next.html !== shown.html) { shown = next; setContent(next); }
        if (zone === 'out') { shown = next; position(next); origin = pt; }
        return;
      }
      if (zone === 'out') {
        pending = null;
        if (next) {
          clearLinger();
          place(next, pt);
        } else {
          startLinger();   // off every parcel: linger, then close
        }
        return;
      }
      // On its way to the popup across another parcel (or bare map):
      // hold what is shown. Right beside it, hold for as long as the
      // pointer stays; further out in the funnel, for the linger time.
      pending = next;
      if (zone === 'near') clearLinger();
      else startLinger();
    },
    /** Replace the content of the parcel being shown (an async result
     *  landing), only if `key` is still the one on screen. */
    refresh(key, html) {
      if (!popup.isOpen() || !shown || shown.key !== key || shown.html === html) return;
      shown = { ...shown, html };
      setContent(shown);
    },
    /** The pointer left the map canvas. Moving onto the popup itself is
     *  not leaving: its mouseenter takes over. Anything else lingers. */
    leave(relatedTarget) {
      if (relatedTarget && popup.getElement()?.contains(relatedTarget)) return;
      pending = null;
      if (popup.isOpen()) startLinger();
    },
    /** Close at once (a click popup opening, a tool taking the pointer). */
    hide() {
      clearLinger();
      pending = null;
      overPopup = false;
      close();
    },
    /** Is the popup open and the pointer on it or on its way to it? */
    holds(pt) {
      if (!popup.isOpen()) return false;
      if (overPopup) return true;
      return reachZone(pt, popupRect(), origin, reachPx) !== 'out';
    },
    /** The target on screen, or null. */
    current() {
      return popup.isOpen() ? shown : null;
    },
  };
}
