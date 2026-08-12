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

/**
 * @param {object}   io
 * @param {Function} io.isEnabled  consulted on EVERY event, so the caller
 *   can gate on live state (active tab, whether a search has run) without
 *   the handlers being attached and detached.
 * @param {Function} io.setHover   (featureId, on) => void
 * @param {Function} io.setCursor  (cssCursor) => void — '' resets
 * @param {Function} io.onPick     (muniName) => void
 */
export function createMuniPicker({ isEnabled, setHover, setCursor, onPick } = {}) {
  const live = () => (typeof isEnabled === 'function' ? !!isEnabled() : true);
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

    /** @param {string|null} muniName MUNI_LIST_NAME_WITH_TYPE of the click */
    click(muniName) {
      if (!live()) return;
      if (!muniName) return;
      onPick?.(String(muniName));
    },

    /**
     * Re-assert the gate without waiting for a mouse event.
     *
     * The hover handlers only fire on movement, so a search started from
     * the keyboard — Enter in the Roll # field with the cursor parked over
     * a municipality — would otherwise leave that municipality tinted and
     * pointer-cursored until the mouse next moved. Call this whenever the
     * thing isEnabled() reads changes.
     */
    refresh() {
      if (!live()) clearHover();
    },

    /** Test seam: which feature currently carries the hover state. */
    get hoveredId() { return hovered; },
  };
}
