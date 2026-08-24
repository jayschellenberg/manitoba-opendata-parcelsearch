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
 * Should the hover tint be withheld from this feature?
 *
 * One rule, two halves (Jason, 2026-08-24):
 *
 *   * The municipality already loaded in Property Search does not tint
 *     while you are working inside it. Zoomed in, its fill shows through
 *     only where the parcel fabric has gaps — public roads, road
 *     allowances, water — so tracking across it flashed the whole RM on
 *     and off with every road crossed. Nothing is being pointed at: the
 *     one under the cursor is the one already loaded, and the blue
 *     selected outline says so.
 *   * ...unless the WHOLE municipality is on screen. Zoomed out that far
 *     the tint is a shape, not a flash — it says which of the municipalities
 *     in view is the loaded one, and that it can be clicked off — and the
 *     fabric gaps are far below a pixel, so there is nothing to flicker.
 *
 * Every other municipality hovers as it always did; that is how you point
 * at a neighbour to switch to it.
 *
 * @param {object} q
 * @param {number|string|null} q.featureId  the feature under the cursor
 * @param {number|string|null} q.loadedId   the loaded muni's feature id
 * @param {number[]|null}      q.featureBbox [w,s,e,n] of the loaded muni
 * @param {number[]|null}      q.viewBbox    [w,s,e,n] of the current view
 */
export function hoverInertLoadedMuni({ featureId, loadedId, featureBbox, viewBbox } = {}) {
  if (loadedId == null || featureId == null) return false;
  if (featureId !== loadedId) return false;
  // Extent unknown (boundaries not loaded yet, or a muni missing from the
  // FC): fall back to the plain rule rather than flashing on a guess.
  return !bboxWithin(featureBbox, viewBbox);
}

/**
 * @param {object}   io
 * @param {Function} io.isEnabled  consulted on EVERY event, so the caller
 *   can gate on live state (active tab, whether a search has run) without
 *   the handlers being attached and detached.
 * @param {Function} io.isInert    (featureId) => boolean — this feature must
 *   not answer a hover right now. Used for the loaded municipality while it
 *   is only partly on screen; see hoverInertLoadedMuni() and the comment on
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
      // extent; see hoverInertLoadedMuni(). Cleared rather than ignored so
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
