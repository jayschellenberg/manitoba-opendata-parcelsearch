// Phone mode — the one switch every narrow-viewport behaviour hangs off.
//
// Below PHONE_QUERY the page becomes map-first: the map fills the
// viewport, the sidebar becomes a bottom sheet (the `body.phone` rules at
// the end of style.css), and the results pane moves INTO the sheet so a
// search and its results share one scrollable surface. This module owns
// the class toggle, the DOM relocation, the sheet snap state and the
// top-bar menu; main.js calls initPhoneMode() once and reacts to onChange
// (the map container changes size, so MapLibre needs a resize()).
//
// Relocation rather than duplication: #results-wrap keeps its identity,
// so every $tbody / paginator / toolbar handle main.js captured at boot
// still points at a live element. Widening the window moves it back to
// exactly where it stood in the workspace.
//
// Sheet states (phase 1: tap the handle to cycle; a drag gesture with
// real snap points is the next step):
//   peek  — just the handle and the tab strip, the map owns the screen
//   half  — the search form, map still visible above (default)
//   full  — the whole sidebar, for long result lists and the layer groups

export const PHONE_QUERY = '(max-width: 767px)';
export const SHEET_STATES = ['peek', 'half', 'full'];
const DEFAULT_SHEET = 'half';

let mql = null;
// Where #results-wrap sat in the workspace before the first move. A text
// node is fine: insertBefore only needs it to still be a workspace child.
let desktopAnchor = null;

export function isPhone() {
  return typeof document !== 'undefined'
    && document.body.classList.contains('phone');
}

function relocateResults(phone) {
  const results = document.getElementById('results-wrap');
  const slot = document.getElementById('phone-results-slot');
  const workspace = document.getElementById('workspace');
  if (!results || !slot || !workspace) return;
  if (phone) {
    if (results.parentElement === slot) return;
    desktopAnchor = results.nextSibling;
    slot.appendChild(results);
  } else if (results.parentElement === slot) {
    const anchor = desktopAnchor && desktopAnchor.parentNode === workspace
      ? desktopAnchor
      : null;
    workspace.insertBefore(results, anchor);
  }
}

function sidebarEl() {
  return document.querySelector('.sidebar');
}

export function getSheetState() {
  const s = sidebarEl();
  if (!s) return null;
  return SHEET_STATES.find((name) => s.classList.contains(`sheet-${name}`)) || null;
}

export function setSheetState(state) {
  if (!SHEET_STATES.includes(state)) return;
  const s = sidebarEl();
  if (!s) return;
  for (const name of SHEET_STATES) s.classList.toggle(`sheet-${name}`, name === state);
  s.dataset.sheet = state;
  const handle = document.getElementById('sheet-handle');
  if (handle) {
    const next = SHEET_STATES[(SHEET_STATES.indexOf(state) + 1) % SHEET_STATES.length];
    handle.setAttribute('aria-label', `Search panel: ${state}. Tap to make it ${next}.`);
  }
  // Snapping to peek leaves the sheet's scroll position wherever it was;
  // pull it back to the top so the next expand shows the tab strip and
  // search fields, not the middle of the layer list.
  if (state === 'peek') s.scrollTop = 0;
}

export function cycleSheetState() {
  const cur = getSheetState() || DEFAULT_SHEET;
  const next = SHEET_STATES[(SHEET_STATES.indexOf(cur) + 1) % SHEET_STATES.length];
  setSheetState(next);
}

/** Bring the sheet up to at least `half` — used when results land while
 *  the user has it peeked down to look at the map. */
export function ensureSheetVisible() {
  if (!isPhone()) return;
  if (getSheetState() === 'peek') setSheetState(DEFAULT_SHEET);
}

function initTopbarMenu() {
  const topbar = document.querySelector('.topbar');
  const btn = document.getElementById('topbar-menu-btn');
  const nav = document.getElementById('topbar-nav');
  if (!topbar || !btn || !nav) return;
  const setOpen = (open) => {
    topbar.classList.toggle('menu-open', open);
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', () => setOpen(!topbar.classList.contains('menu-open')));
  // Choosing a link or button inside the menu closes it, so the map is
  // not left under the menu after "Property Data Status" opens its
  // dialog. The Data Sources <summary> is neither, so it can expand in
  // place.
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) setOpen(false);
  });
}

/**
 * Wire phone mode. `onChange(phone)` fires once at boot and again on
 * every crossing of the breakpoint (rotation, split view, desktop
 * resize). Returns a function reporting the current match.
 */
export function initPhoneMode({ onChange } = {}) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => false;
  }
  mql = window.matchMedia(PHONE_QUERY);
  initTopbarMenu();
  document.getElementById('sheet-handle')?.addEventListener('click', cycleSheetState);
  // The tab strip is visible in the peek state; picking a tab there means
  // "show me that tab", so bring the sheet up with it.
  document.querySelector('.sidebar-tabs')?.addEventListener('click', ensureSheetVisible);
  const apply = () => {
    const phone = mql.matches;
    document.body.classList.toggle('phone', phone);
    relocateResults(phone);
    if (phone && !getSheetState()) setSheetState(DEFAULT_SHEET);
    if (typeof onChange === 'function') onChange(phone);
  };
  apply();
  mql.addEventListener('change', apply);
  return () => mql.matches;
}
