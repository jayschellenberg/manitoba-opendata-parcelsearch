/*
 * Workspace resize handle. Drags the horizontal divider between the
 * map and the table to change how much vertical space each pane gets.
 * The split is expressed as a percentage of the workspace height,
 * stored on the workspace element via the `--map-pane-height` custom
 * property; the CSS rules in style.css read that variable for the
 * map's flex-basis/height. Keyboard support: arrow-up/down on a
 * focused handle nudge the split by 4% in each direction.
 *
 * Only activates at md+ (the width threshold matches the CSS media
 * query). Below md the panes stack and the handle hides, so there's
 * nothing to drag.
 *
 * Side effects:
 *   - Toggles `body.workspace-resizing` while dragging so other rules
 *     (text selection, iframe pointer events) can suspend themselves.
 *   - Dispatches a CustomEvent('workspace:resize') on the workspace
 *     after each update so the map module can call `map.resize()` and
 *     refresh its WebGL canvas.
 */

const MIN_PCT = 20; // map can't get below 20% of the workspace
const MAX_PCT = 85; // ...nor above 85% (leave room for at least 1 table row)
const KEY_STEP_PCT = 4;
const MD_BREAKPOINT_PX = 768;

let currentPct = 60;
let workspaceEl = null;
let handleEl = null;
let dragging = false;
let dragOriginY = 0;
let dragOriginPct = 0;

function isSplitActive() {
  return window.matchMedia(`(min-width: ${MD_BREAKPOINT_PX}px)`).matches;
}

function clampPct(pct) {
  if (!Number.isFinite(pct)) return currentPct;
  if (pct < MIN_PCT) return MIN_PCT;
  if (pct > MAX_PCT) return MAX_PCT;
  return pct;
}

function applyPct(pct) {
  currentPct = clampPct(pct);
  if (workspaceEl) {
    workspaceEl.style.setProperty('--map-pane-height', `${currentPct}%`);
    workspaceEl.dispatchEvent(
      new CustomEvent('workspace:resize', { detail: { pct: currentPct } })
    );
  }
}

function onPointerMove(e) {
  if (!dragging || !workspaceEl) return;
  const rect = workspaceEl.getBoundingClientRect();
  if (rect.height <= 0) return;
  const deltaPx = e.clientY - dragOriginY;
  const deltaPct = (deltaPx / rect.height) * 100;
  applyPct(dragOriginPct + deltaPct);
}

function endDrag() {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('workspace-resizing');
  if (handleEl) handleEl.classList.remove('dragging');
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', endDrag);
  window.removeEventListener('pointercancel', endDrag);
}

function startDrag(e) {
  if (!isSplitActive()) return;
  if (e.button != null && e.button !== 0) return; // left button / primary pointer only
  dragging = true;
  dragOriginY = e.clientY;
  dragOriginPct = currentPct;
  document.body.classList.add('workspace-resizing');
  if (handleEl) handleEl.classList.add('dragging');
  e.preventDefault();
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
}

function onKeyDown(e) {
  if (!isSplitActive()) return;
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    applyPct(currentPct - KEY_STEP_PCT);
    e.preventDefault();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    applyPct(currentPct + KEY_STEP_PCT);
    e.preventDefault();
  } else if (e.key === 'Home') {
    applyPct(MIN_PCT);
    e.preventDefault();
  } else if (e.key === 'End') {
    applyPct(MAX_PCT);
    e.preventDefault();
  }
}

/**
 * Wire up the workspace divider. Idempotent; safe to call once at
 * boot. Returns `false` if the expected elements aren't in the DOM.
 */
export function initWorkspaceResize() {
  workspaceEl = document.getElementById('workspace');
  handleEl = document.getElementById('workspace-resize');
  if (!workspaceEl || !handleEl) return false;
  applyPct(currentPct); // ensure the CSS var is initialised
  handleEl.addEventListener('pointerdown', startDrag);
  handleEl.addEventListener('keydown', onKeyDown);
  return true;
}
