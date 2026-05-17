/*
 * Sidebar tab switcher. Wires the three tab buttons to their
 * matching tab panels, persists the last-active tab to
 * localStorage so a page refresh keeps the user in place, and
 * focuses the active tab's primary input on switch (so a
 * keyboard user can start typing immediately).
 *
 * Tabs are identified by their `data-tab` attribute. Panels
 * carry a matching `data-tab` and the `role="tabpanel"` ARIA
 * pairing for screen readers.
 *
 * Arrow-key support: ← / → cycle through the tab buttons when
 * focus is on one of them. Home / End jump to the first / last.
 */

const STORAGE_KEY = 'mbps_sidebar_tab_v1';
const DEFAULT_TAB = 'property';

// Each tab's primary input is what gets focused on activation —
// the field the user is most likely to want to type into first.
const PRIMARY_INPUT_BY_TAB = {
  property: '#municipality',
  sales: '#sales-dropzone',
  layers: '#muni-parcels-toggle',
};

let activeTab = DEFAULT_TAB;
const listeners = new Set();

function readStored() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && document.querySelector(`.sidebar-tab[data-tab="${stored}"]`)) {
      return stored;
    }
  } catch {}
  return null;
}

function writeStored(name) {
  try { localStorage.setItem(STORAGE_KEY, name); } catch {}
}

function tabButtons() {
  return Array.from(document.querySelectorAll('.sidebar-tab'));
}

function tabPanels() {
  return Array.from(document.querySelectorAll('.sidebar-tab-panel'));
}

function focusPrimary(name, { skipFocus = false } = {}) {
  if (skipFocus) return;
  const sel = PRIMARY_INPUT_BY_TAB[name];
  if (!sel) return;
  const el = document.querySelector(sel);
  if (!el || el.disabled) return;
  // Defer one frame so the panel has time to unhide before focus.
  requestAnimationFrame(() => {
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  });
}

/**
 * Activate the named tab. Idempotent — re-activating the current
 * tab still re-applies the ARIA + focus state, which is useful
 * when callers want to re-focus the primary input.
 */
export function setActiveTab(name, { skipFocus = false, skipStore = false } = {}) {
  const btns = tabButtons();
  const panels = tabPanels();
  if (!btns.length || !panels.length) return;
  if (!btns.some((b) => b.dataset.tab === name)) name = DEFAULT_TAB;
  activeTab = name;
  for (const btn of btns) {
    const isActive = btn.dataset.tab === name;
    btn.setAttribute('aria-selected', String(isActive));
    btn.tabIndex = isActive ? 0 : -1;
  }
  for (const panel of panels) {
    panel.hidden = panel.dataset.tab !== name;
  }
  if (!skipStore) writeStored(name);
  focusPrimary(name, { skipFocus });
  for (const fn of listeners) {
    try { fn(name); } catch (err) { console.warn('tab listener failed', err); }
  }
}

/** Read the currently-active tab name. */
export function getActiveTab() {
  return activeTab;
}

/** Register a callback for tab changes. Returns an unsubscribe fn. */
export function onTabChange(fn) {
  if (typeof fn === 'function') listeners.add(fn);
  return () => listeners.delete(fn);
}

function onTabKeyDown(e) {
  const btns = tabButtons();
  const idx = btns.indexOf(document.activeElement);
  if (idx < 0) return;
  let target = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    target = btns[(idx + 1) % btns.length];
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    target = btns[(idx - 1 + btns.length) % btns.length];
  } else if (e.key === 'Home') {
    target = btns[0];
  } else if (e.key === 'End') {
    target = btns[btns.length - 1];
  }
  if (target) {
    target.focus();
    setActiveTab(target.dataset.tab);
    e.preventDefault();
  }
}

/**
 * Wire up the sidebar tabs. Returns false if the markup isn't
 * present (so callers can no-op without crashing on stripped-down
 * embeds or test pages).
 */
export function initSidebarTabs() {
  const btns = tabButtons();
  if (!btns.length) return false;
  for (const btn of btns) {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
    btn.addEventListener('keydown', onTabKeyDown);
  }
  // Restore prior selection if any, otherwise default.
  setActiveTab(readStored() || DEFAULT_TAB, { skipFocus: true });
  return true;
}
