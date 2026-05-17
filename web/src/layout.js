/*
 * Workspace resize handle. Drags the horizontal divider between the
 * map and the table to change how much vertical space each pane gets.
 * The split is expressed in pixels via the `--map-pane-height` custom
 * property on the workspace element; the CSS rules in style.css read
 * that variable for the map's height. Keyboard support: arrow-up/down
 * nudge the split by ~4% of the workspace height in each direction.
 *
 * Default state writes nothing — the CSS keeps `--map-pane-height:
 * auto` and the map's `aspect-ratio: 16/9` rule sets the natural
 * height from the workspace width. As soon as the user drags (or
 * presses arrows on a focused handle), the JS writes a px value
 * that takes over from aspect-ratio.
 *
 * Only activates at md+ (768 px breakpoint). Below md the panes
 * stack and the handle hides.
 *
 * Side effects:
 *   - Toggles `body.workspace-resizing` while dragging.
 *   - Dispatches a CustomEvent('workspace:resize') on the workspace
 *     after each update so the map module can call `map.resize()`
 *     and refresh its WebGL canvas.
 */

const MD_BREAKPOINT_PX = 768;
const MIN_MAP_PX = 200;     // map can't go below this
const MIN_TABLE_PX = 120;   // ...nor leave the table below this
const KEY_STEP_RATIO = 0.04; // arrow keys nudge by ~4% of workspace height

let workspaceEl = null;
let handleEl = null;
let dragging = false;
let dragOriginY = 0;
let dragOriginHeightPx = 0;

function isSplitActive() {
  return window.matchMedia(`(min-width: ${MD_BREAKPOINT_PX}px)`).matches;
}

function workspaceHeight() {
  return workspaceEl ? workspaceEl.getBoundingClientRect().height : 0;
}

function currentMapHeightPx() {
  // Read the actual rendered height of the map pane — that's the
  // source of truth whether the CSS default (aspect-ratio) or a
  // previously-applied --map-pane-height is in effect.
  const mapEl = document.getElementById('map');
  return mapEl ? mapEl.getBoundingClientRect().height : 0;
}

function clampPx(px) {
  const total = workspaceHeight();
  if (!Number.isFinite(px) || total <= 0) return px;
  const maxPx = total - MIN_TABLE_PX;
  return Math.max(MIN_MAP_PX, Math.min(maxPx, px));
}

function applyPx(px) {
  if (!workspaceEl) return;
  const clamped = clampPx(px);
  workspaceEl.style.setProperty('--map-pane-height', `${Math.round(clamped)}px`);
  workspaceEl.dispatchEvent(
    new CustomEvent('workspace:resize', { detail: { px: clamped } })
  );
}

function onPointerMove(e) {
  if (!dragging) return;
  const deltaPx = e.clientY - dragOriginY;
  applyPx(dragOriginHeightPx + deltaPx);
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
  if (e.button != null && e.button !== 0) return;
  dragging = true;
  dragOriginY = e.clientY;
  // Capture the height that's actually rendering right now (could
  // be the aspect-ratio default or a previously dragged px value).
  dragOriginHeightPx = currentMapHeightPx();
  document.body.classList.add('workspace-resizing');
  if (handleEl) handleEl.classList.add('dragging');
  e.preventDefault();
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
}

function onKeyDown(e) {
  if (!isSplitActive()) return;
  const step = Math.max(20, Math.round(workspaceHeight() * KEY_STEP_RATIO));
  const here = currentMapHeightPx();
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    applyPx(here - step);
    e.preventDefault();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    applyPx(here + step);
    e.preventDefault();
  } else if (e.key === 'Home') {
    applyPx(MIN_MAP_PX);
    e.preventDefault();
  } else if (e.key === 'End') {
    applyPx(workspaceHeight() - MIN_TABLE_PX);
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
  // Don't write --map-pane-height up front — let CSS aspect-ratio
  // govern the initial size. The handle starts pulling in pixels
  // only on first user interaction.
  handleEl.addEventListener('pointerdown', startDrag);
  handleEl.addEventListener('keydown', onKeyDown);
  return true;
}
