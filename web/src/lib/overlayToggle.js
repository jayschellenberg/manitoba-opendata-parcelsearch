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
