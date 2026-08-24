/*
 * The click-a-municipality picker's state machine, separated from MapLibre.
 *
 * Property Search lets you point at a municipality on the map instead of
 * finding it in a list of ~180. The gesture is only armed BEFORE a search
 * has run: once results are on the map, the boundaries sit under parcels,
 * popups and overlays, and MapLibre fires every layer's click handler
 * independently, so a click meant for a parcel would silently re-scope the
 * search. Disarmed, the layer must be completely inert — no tint, no
 * pointer cursor, no click. Looking clickable when you aren't is worse
 * than not being clickable.
 *
 * Extracted here because that gating is the part that can be wrong, and it
 * could not be tested where it lived: map.js imports maplibre-gl, turf and
 * mapbox-gl-draw, so node cannot load it, and the map itself needs a
 * compositing canvas to initialise at all. This module touches no DOM and
 * no map — the caller supplies setHover/setCursor — so the whole state
 * machine runs under node.
 */

/** Is `inner` [w,s,e,n] entirely inside `outer` [w,s,e,n]? */
export function bboxWithin(inner, outer) {
  if (!inner || !outer) return false;
  return inner[0] >= outer[0] && inner[1] >= outer[1]
      && inner[2] <= outer[2] && inner[3] <= outer[3];
}

/**
 * Is the whole municipality backdrop inert right now?
 *
 * The state, not the feature (Jason, 2026-08-24 — third report, Altona and
 * Rhineland). Once a municipality is loaded and you have zoomed in past its
 * extent, you are working inside it: reading parcels, not choosing an area.
 * Nothing on this backdrop tints or takes a click until you zoom back out
 * far enough to see the whole loaded municipality.
 *
 * It has to be every municipality, not just the loaded one, because at any
 * working zoom the neighbours are on screen too — and for a town they are
 * most of the screen. Altona is 2.4 km across inside the RM of Rhineland,
 * so a cursor a few hundred pixels off the parcels is over Rhineland, which
 * is not loaded and so kept lighting up: the "RM highlighting" of the
 * original report. Silencing only the loaded municipality left that
 * untouched, which is why Brandon looked fixed and Altona did not — Brandon
 * fills its own screen, so its neighbour is rarely under the cursor.
 *
 * Zoomed out to the whole loaded municipality the picker is live again, and
 * that is the state the gesture was for: several municipalities on screen,
 * point at one to switch to it.
 *
 * @param {object} q
 * @param {number|string|null} q.loadedId   the loaded muni's feature id, or
 *   null when the dropdown is on "Any municipality" — then nothing is inert
 * @param {number[]|null}      q.loadedBbox [w,s,e,n] of the loaded muni
 * @param {number[]|null}      q.viewBbox   [w,s,e,n] of the current view
 */
export function muniBackdropInert({ loadedId, loadedBbox, viewBbox } = {}) {
  if (loadedId == null) return false;
  // Extent unknown (boundaries not loaded yet, or a muni missing from the
  // FC): stay inert rather than flashing on a guess.
  return !bboxWithin(loadedBbox, viewBbox);
}

/**
 * Does something drawn over the boundaries stand this hover down?
 *
 * Yes for every municipality but one. The backdrop is the lowest vector
 * layer on the map, so normally it answers only where it is the only thing
 * there — otherwise it would tint while you were pointing at a parcel.
 *
 * The loaded municipality is the exception, and this is the half of the fix
 * that matters (Jason, 2026-08-24, second report — Brandon). Deferring to
 * the fabric is WHY it flashed: the parcel layer has a gap at every public
 * road, so the tint switched off and on again with each one. Nothing is
 * being disambiguated by deferring, either — the municipality under the
 * cursor is the one already loaded, so there is no second candidate for the
 * gesture. Left to the cursor being inside it and nothing else, the tint is
 * steady at any zoom.
 *
 * The CLICK still defers, always: clicking a parcel must not clear the
 * municipality out from under it.
 */
export function hoverDefersToContent({ featureId, loadedId } = {}) {
  if (featureId == null || loadedId == null) return true;
  return featureId !== loadedId;
}

/**
 * @param {object}   io
 * @param {Function} io.isEnabled  consulted on EVERY event, so the caller
 *   can gate on live state (active tab, whether a search has run) without
 *   the handlers being attached and detached.
 * @param {Function} io.isInert    (featureId) => boolean — this feature must
 *   not answer a hover right now. Used for the loaded municipality while it
 *   is only partly on screen; see muniBackdropInert() and the comment on
 *   mouseMove.
 * @param {Function} io.setHover   (featureId, on) => void
 * @param {Function} io.setCursor  (cssCursor) => void — '' resets
 * @param {Function} io.onPick     (muniName) => void
 */
export function createMuniPicker({ isEnabled, isInert, setHover, setCursor, onPick } = {}) {
  const live = () => (typeof isEnabled === 'function' ? !!isEnabled() : true);
  const inert = (id) => (typeof isInert === 'function' ? !!isInert(id) : false);
  let hovered = null;

  /** Drop any tint and the pointer cursor. Safe to call when already clear. */
  function clearHover() {
    if (hovered != null) setHover?.(hovered, false);
    hovered = null;
    setCursor?.('');
  }

  return {
    /** @param {number|string|null} featureId the hovered feature's id */
    mouseMove(featureId) {
      // Disarmed: never paint, and drop anything left over from before the
      // gate closed. Returning without touching the cursor would leave a
      // pointer sitting over a layer that no longer responds.
      if (!live()) { clearHover(); return; }
      if (featureId == null) return;
      // Inert right now — the loaded municipality zoomed in past its own
      // extent; see muniBackdropInert(). Cleared rather than ignored so
      // a tint painted before the rule flipped does not sit there.
      if (inert(featureId)) { clearHover(); return; }
      if (hovered !== featureId) {
        if (hovered != null) setHover?.(hovered, false);
        hovered = featureId;
        setHover?.(hovered, true);
      }
      setCursor?.('pointer');
    },

    mouseLeave() {
      clearHover();
    },

    /**
     * @param {string|null} muniName MUNI_LIST_NAME_WITH_TYPE of the click
     * @param {number|string|null} featureId the clicked feature's id, so an
     *   inert municipality can refuse the click as well as the hover. A
     *   layer that doesn't tint must not act on a click either — and the
     *   click here is destructive: it clears the loaded muni back to "Any
     *   municipality", which zoomed into a parcel would land on a road with
     *   nothing to say it was about to happen. Omitted, the click is
     *   accepted, as it was before the inert rule existed.
     */
    click(muniName, featureId) {
      if (!live()) return;
      if (!muniName) return;
      if (featureId != null && inert(featureId)) return;
      onPick?.(String(muniName));
    },

    /**
     * Re-assert the gate without waiting for a mouse event.
     *
     * The hover handlers only fire on movement, so a search started from
     * the keyboard — Enter in the Roll # field with the cursor parked over
     * a municipality — would otherwise leave that municipality tinted and
     * pointer-cursored until the mouse next moved. Same for picking a muni
     * from the dropdown with the cursor parked over it: it becomes the
     * loaded one, and must drop its tint on the spot. Same when a zoom
     * takes the loaded muni past its own extent under a parked cursor.
     * Call this whenever what isEnabled() or isInert() reads changes.
     */
    refresh() {
      if (!live() || (hovered != null && inert(hovered))) clearHover();
    },

    /** Test seam: which feature currently carries the hover state. */
    get hoveredId() { return hovered; },
  };
}
