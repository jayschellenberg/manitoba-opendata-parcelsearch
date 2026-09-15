/*
 * When a themed overlay paints a result parcel, the yellow selection
 * highlight underneath gets out of its way.
 *
 * THE BUG THIS FIXES (Jason, 2026-09-15). Each multi-family overlay puts the
 * rolls it paints into the results, and result parcels wear the yellow
 * selection kit: a 40% #ffea00 fill and a dashed black/yellow outline. Over
 * the DARK end of a ramp that is invisible. Over the PALE end it is not: a
 * 2016-17 parcel (#fee5d9 at 70%) sitting on 40% yellow renders apricot, and
 * next to a 2024-25 parcel rendering true dark red, the same layer looks like
 * two different things — one a layer member, the other "just a search result".
 * The oldest bands were the ones that looked wrong, every time.
 *
 * So the parcel wears ONE highlight, the most specific one: while an overlay
 * is painting it, the overlay's colour is the highlight and the selection kit
 * yields. Suppressing the ramp instead would be the wrong way round — the
 * ramp is the reason the parcel is on screen at all.
 *
 * STARRED PARCELS ARE THE EXCEPTION. A favourite's dark-red marker is the
 * user's own annotation, not a by-product of what is switched on, and it has
 * to survive every overlay. It is the one thing that outranks the ramp.
 *
 * KEYED ON THE OVERLAYS THAT ARE ON, not on the stamps alone. `_mfnbColor`
 * and friends stay on the features after their overlay is switched off (so a
 * re-toggle is a repaint, not a refetch), so an expression that only asked
 * `has _mfnbColor` would keep suppressing the selection highlight long after
 * the layer went away.
 */

/** Overlay key → the property it stamps on a parcel it is painting. */
export const OVERLAY_HIGHLIGHT_PROPS = Object.freeze({
  mfinv: '_mfInvColor',
  mfnb: '_mfnbColor',
  condo: '_condoColor',
});

/**
 * A MapLibre expression: is this feature painted by one of the overlays that
 * currently own the highlight? Returns the literal `false` when none do, so
 * callers can skip wrapping entirely.
 */
export function ownedByOverlay(keys) {
  const props = [...new Set(
    (keys || []).map((k) => OVERLAY_HIGHLIGHT_PROPS[k]).filter(Boolean),
  )];
  if (props.length === 0) return false;
  if (props.length === 1) return ['has', props[0]];
  return ['any', ...props.map((p) => ['has', p])];
}

/**
 * Wrap a selection-highlight paint value (a fill or line opacity) so a parcel
 * an overlay is painting drops it to 0.
 *
 * @param {*} base   the paint value the selection would use on its own — may
 *                   itself be an expression (the starred / groupHover cases).
 * @param {string[]} keys  overlay keys currently painting, e.g. ['mfnb'].
 */
export function yieldToOverlay(base, keys) {
  const owned = ownedByOverlay(keys);
  if (owned === false) return base;
  return [
    'case',
    // A favourite keeps its marker whatever else is on.
    ['boolean', ['feature-state', 'starred'], false], base,
    owned, 0,
    base,
  ];
}
