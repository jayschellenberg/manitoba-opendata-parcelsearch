/*
 * Results-table column visibility. Walks the thead's data-col
 * attributes to enumerate every column, then maintains a Set of
 * visible keys persisted to localStorage. Applies visibility by
 * stamping `.col-hidden` on both the matching th(s) AND every td
 * in those columns (positionally matched, since the tds don't
 * carry their own data-col attribute).
 *
 * The mode classes (.sales-only, .basic-only, .devplan-only,
 * .masc-only, .subj-col) keep doing their job — they hide
 * columns that aren't relevant to the current mode. .col-hidden
 * stacks on top: a column needs both to clear (mode-class OR
 * the column not being mode-suppressed) AND to be in the user's
 * visible set to render.
 *
 * Two columns share `data-col="acres"` (one .sales-only at the
 * sales-mode position, one .basic-only at the non-sales position).
 * Toggling "acres" affects both physical columns; that's the right
 * thing because the user conceptually only knows of one Acres column.
 *
 * Default-visible set follows the Phase 5 spec (Phase 5 item 12).
 * "Full detail" preset clears every column-hide so everything that
 * the mode allows renders.
 */

const STORAGE_KEY = 'mbps_table_columns_v1';

// Phase 5 default-visible set: ★, Roll #, Address, Sale Date,
// Sale Price, $/Acre, Acres, Zoning, Distance (when subject set).
// The favourite (★) column is in here so sales-mode keeps its
// star column without the user having to toggle it on.
export const DEFAULT_VISIBLE = new Set([
  'favorite',
  'roll',
  'address',
  'saledate',
  'saleprice',
  'grouppriceac',
  'acres',
  'zone1',
  'subjdist',
]);

// Column presets — `null` value means "everything that the current
// mode would show". The labels match the dropdown options.
export const PRESETS = {
  'Sales analysis': new Set([
    'favorite', 'roll', 'address', 'saledate', 'saleprice',
    'grouppriceac', 'grouppricesf', 'grouppricelot', 'acres',
    'zone1', 'subjdist', 'saletoasmt',
  ]),
  'Zoning check': new Set([
    'roll', 'address', 'zone1', 'zone1pct', 'zone2', 'zbl',
    'dev1', 'dpbylaw', 'changes', 'acres',
  ]),
  'Full detail': null,
};

let visible = new Set(DEFAULT_VISIBLE);
const listeners = new Set();

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return new Set(arr);
  } catch { return null; }
}

function writeStored() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...visible]));
  } catch {}
}

function emit() {
  for (const fn of listeners) {
    try { fn(visible); } catch (err) { console.warn('columns listener failed', err); }
  }
}

/**
 * Enumerate every column key from the thead. Multiple ths can
 * share the same data-col (the dual Acres case); deduped here.
 */
export function listAllColumns() {
  const seen = new Map();
  for (const th of document.querySelectorAll('#results thead th[data-col]')) {
    const key = th.dataset.col;
    if (!seen.has(key)) {
      seen.set(key, {
        key,
        label: th.textContent.replace(/[⇅▲▼]/g, '').trim() || key,
      });
    }
  }
  return [...seen.values()];
}

export function isColumnVisible(key) {
  // `null` preset = full-detail mode; treat as everything visible.
  return visible == null ? true : visible.has(key);
}

export function setColumnVisible(key, on) {
  if (visible == null) visible = new Set();
  if (on) visible.add(key);
  else visible.delete(key);
  writeStored();
  applyVisibility();
  emit();
}

export function applyPreset(name) {
  const preset = PRESETS[name];
  if (preset === undefined) return; // unknown
  visible = preset == null ? null : new Set(preset);
  writeStored();
  applyVisibility();
  emit();
}

/**
 * Apply the current visible-set to the live DOM. Idempotent;
 * safe to call after each table render so newly-built rows pick
 * up the hidden state.
 */
export function applyVisibility() {
  const heads = Array.from(document.querySelectorAll('#results thead th'));
  if (!heads.length) return;
  // Compute per-column-index hidden flag from the th's data-col.
  const hiddenAt = heads.map((th) => {
    const key = th.dataset.col;
    if (!key) return false; // no data-col -> never hidden
    return !isColumnVisible(key);
  });
  // Apply to thead.
  heads.forEach((th, i) => {
    th.classList.toggle('col-hidden', hiddenAt[i]);
  });
  // Apply to every tbody row in lockstep.
  for (const row of document.querySelectorAll('#results tbody tr')) {
    const cells = row.children;
    for (let i = 0; i < cells.length && i < hiddenAt.length; i++) {
      cells[i].classList.toggle('col-hidden', hiddenAt[i]);
    }
  }
}

export function onColumnsChange(fn) {
  if (typeof fn === 'function') listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Wire up the column-visibility gear popover + presets dropdown.
 * Reads stored visibility from localStorage; falls back to the
 * Phase 5 default-visible set on first load. Returns false if the
 * toolbar markup isn't present.
 */
export function initColumns() {
  const stored = readStored();
  if (stored) visible = stored;
  const gear = document.getElementById('columns-gear');
  const popover = document.getElementById('columns-popover');
  const presetSelect = document.getElementById('columns-preset');
  if (!gear || !popover) return false;

  // Build the checklist once. listAllColumns() snapshots the thead;
  // if columns ever change at runtime, call initColumns again.
  function buildChecklist() {
    popover.innerHTML = '';
    for (const { key, label } of listAllColumns()) {
      const wrap = document.createElement('label');
      wrap.className = 'columns-popover-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isColumnVisible(key);
      cb.dataset.colKey = key;
      cb.addEventListener('change', () => setColumnVisible(key, cb.checked));
      const span = document.createElement('span');
      span.textContent = label;
      wrap.appendChild(cb);
      wrap.appendChild(span);
      popover.appendChild(wrap);
    }
  }
  buildChecklist();

  // Toggle the popover on gear click. Click-away or Escape closes.
  gear.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = popover.classList.toggle('open');
    gear.setAttribute('aria-expanded', String(open));
    if (open) buildChecklist();
  });
  document.addEventListener('click', (e) => {
    if (!popover.classList.contains('open')) return;
    if (popover.contains(e.target) || gear.contains(e.target)) return;
    popover.classList.remove('open');
    gear.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popover.classList.contains('open')) {
      popover.classList.remove('open');
      gear.setAttribute('aria-expanded', 'false');
    }
  });

  // Preset dropdown.
  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      const name = presetSelect.value;
      if (!name) return;
      applyPreset(name);
      buildChecklist();
      // Reset to the blank label so the user can pick the same preset
      // again to "re-apply" after manual tweaks.
      presetSelect.value = '';
    });
  }

  // Initial apply.
  applyVisibility();
  return true;
}
