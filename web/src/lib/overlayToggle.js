// Canonical state machine for overlay toggle buttons.
//
// The full "this overlay is now ON / OFF / in its tri-state secondary
// mode" mutation always touches two things together: the `active` CSS
// class (drives the pressed-look styling) and the `aria-pressed` ARIA
// attribute (screen readers + the URL-state writer in main.js).
// Centralising the dance ensures the two never drift, and gives a
// single source of truth for "what does 'pressed' mean here":
//
//   true     → ON                 → .active,  aria-pressed="true"
//   false    → OFF                → no class, aria-pressed="false"
//   'mixed'  → tri-state SECONDARY → .active,  aria-pressed="mixed"
//
// Tri-state buttons (grid section/quarter, landcover Dominant/Detailed,
// cli AGCAP/SOILNAME) use 'mixed' for their second active mode. The
// URL-state writer only round-trips aria-pressed="true" overlays — see
// lib/urlState.js SCHEMA.overlays.
//
// NOTE — this helper deliberately does NOT cover the defensive-reset
// sites in main.js that set aria-pressed='false' alone after a failed
// fetch (because those buttons never received the `active` class in
// the first place). Converting those incrementally is safe and a
// follow-up.

/**
 * Set an overlay button's pressed state — keeps `active` class and
 * `aria-pressed` attribute in lock-step.
 *
 * @param {HTMLElement|null} btn  toggle button; no-op when null
 * @param {boolean | 'mixed'} pressed  desired state
 */
export function setOverlayPressed(btn, pressed) {
  if (!btn) return;
  const value = pressed === 'mixed' ? 'mixed' : String(!!pressed);
  btn.classList.toggle('active', value !== 'false');
  btn.setAttribute('aria-pressed', value);
}

/**
 * Is a Map-layers group (`<details class="overlay-group" data-group="…">`)
 * currently expanded?
 *
 * Used by the parcel popups to decide whether to render the farmland
 * sections: with the Agricultural group collapsed, MASC and soil
 * composition are noise on a residential search, and MASC in particular
 * is stamped by ordinary enrichment so it turns up whether or not the
 * user ever asked for farmland data.
 *
 * Fails OPEN — a missing group reads as expanded. Getting this backwards
 * would mean a markup rename silently strips real data out of every
 * popup with nothing to show that it happened; erring the other way just
 * restores today's behaviour.
 *
 * @param {string} group   the data-group value, e.g. 'agricultural'
 * @param {Document} [doc] injectable for tests
 */
export function overlayGroupExpanded(group, doc = globalThis.document) {
  const el = doc?.querySelector?.(`.overlay-group[data-group="${group}"]`);
  if (!el) return true;
  return el.open === true;
}

/**
 * Next state for an overlay toggle click.
 *
 * Zoning cycles through three states, because the whole-municipality
 * fabric buries the parcels being analysed:
 *
 *   off -> ALL (whole muni) -> SELECTED ONLY (zones under the loaded
 *   parcels) -> off
 *
 * SELECTED ONLY needs both a loaded selection AND zoning joined to it.
 * When either is missing the cycle must degrade to off -> ALL -> off,
 * and that has to be decided HERE, before the click is acted on.
 *
 * Deciding it afterwards is what broke: the old code entered the
 * selected-only branch, discovered it had nothing to clip to, and reset
 * the button to ALL. The next click recomputed the same inputs, hit the
 * same fallback, and reset to ALL again — so with no search loaded, the
 * state the app opens in, zoning was a one-way switch that could not be
 * turned off at all.
 *
 * @param {object} o
 * @param {boolean} o.triState        does this overlay have a middle state (zoning only)
 * @param {boolean} o.wasActive       button currently carries `.active`
 * @param {boolean} o.wasSelectedOnly button currently reads aria-pressed="mixed"
 * @param {boolean} o.canSelectOnly   a selection exists AND zoning is joined to it
 * @returns {{visible: boolean, selectedOnly: boolean, skippedSelection: boolean,
 *            pressed: boolean|'mixed'}}
 */
export function nextOverlayToggleState({ triState, wasActive, wasSelectedOnly, canSelectOnly }) {
  const selectedOnly = !!(triState && canSelectOnly && wasActive && !wasSelectedOnly);
  const visible = triState ? (!wasActive || selectedOnly) : !wasActive;
  // The click WOULD have gone to SELECTED ONLY but cannot, so the caller
  // can explain why the middle state was skipped rather than leaving it
  // looking like the tri-state is broken.
  const skippedSelection = !!(triState && wasActive && !wasSelectedOnly && !canSelectOnly);
  return {
    visible,
    selectedOnly,
    skippedSelection,
    pressed: visible ? (selectedOnly ? 'mixed' : true) : false,
  };
}
