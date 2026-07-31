/*
 * Results-table column visibility. Walks the thead's data-col
 * attributes to enumerate every column, then maintains a Set of
 * visible keys persisted to localStorage. Applies visibility by
 * stamping `.col-hidden` on both the matching th(s) AND every td
 * in those columns (positionally matched, since the tds don't
 * carry their own data-col attribute).
 *
 * The mode classes (.sales-only, .basic-only, .devplan-only,
 * .water-only, .subj-col) keep doing their job — they hide
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
 * One visible-set serves both tabs — the mode classes, not this set,
 * decide which of its columns a given tab can render. See the notes on
 * DEFAULT_VISIBLE below. "Full detail" preset clears every column-hide
 * so everything that the mode allows renders.
 */

// Bumped to v2 when the parcel-identity columns below joined the default.
// A stored set always wins over DEFAULT_VISIBLE, so anyone who had already
// used the app would never have seen the new default without a new key.
const STORAGE_KEY = 'mbps_table_columns_v2';

// Default-visible set, in two groups.
//
// Sales context — ★, Sale Date, Sale Price, $/Acre, Distance. All carry
// .sales-only (Distance also .subj-col), so they render on the Sales
// Analysis tab and stay hidden in Property Search regardless of this set.
// The favourite (★) column is in here so sales-mode keeps its star column
// without the user having to toggle it on.
//
// Parcel context — Roll #, Address, Zoning, Legal, Title, DU, Acres, SF,
// Assess-2027, plus the soil group (MASC Rating, CLI, Soil Type, Slope).
// These are unclassed, so they show on BOTH tabs; the identity/size/legal
// half is what a Property Search is usually for, and having to re-tick
// Legal, Title, DU, SF and the assessment total on every visit was busywork.
// CLI / Soil Type / Slope stay in the set even though they render as
// em-dashes until the soil-survey join runs — same reasoning as Tile and
// Irrigation below: being in the set means the gear isn't independently
// suppressing them, so loading the data fills columns that are already
// there instead of appearing to do nothing.
export const DEFAULT_VISIBLE = new Set([
  'favorite',
  'roll',
  'address',
  'saledate',
  'saleprice',
  'grouppriceac',
  'acres',
  'zone1',
  'legal',
  'title',
  'du',
  'sf',
  'value',
  'soil',
  'subjdist',
  'clicls',
  'soiltype',
  'slope',
  // Tile Drainage + Irrigation are mode-gated by .water-only, so they
  // stay invisible until a WALLAS overlay or filter is active. Being in
  // the default set just means the gear isn't independently suppressing
  // them — otherwise switching the overlay on would appear to do nothing
  // to the grid.
  'tile',
  'irrigation',
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
  // Farmland-oriented view. Core identity + the land-cover pair, then
  // soil/capability, sales comps, and zoning/legal context (Jason's
  // chosen groups). Mode-gated columns (sales-only, devplan-only,
  // water-only) still only render once their mode/overlay is active —
  // same as the Sales analysis preset — so this set is the superset of
  // what an ag appraiser reaches for, surfaced as each context turns on.
  //
  // Picking this preset also LOADS the soil-survey join that fills CLI +
  // Soil Type — see onPresetApply below and ensureAgriculturalGridData in
  // main.js. MASC Rating, Risk Area and Land Cover need no such trigger:
  // they're stamped during every search/import enrichment.
  'Agricultural': new Set([
    'favorite', 'roll', 'address', 'acres', 'landcover', 'cultpct',
    'soil', 'clicls', 'soiltype', 'slope', 'riskarea', 'tile', 'irrigation',
    'grouppriceac', 'saledate', 'saleprice', 'saletoasmt', 'grouppricesf',
    'zone1', 'dev1', 'legal', 'title',
  ]),
  'Full detail': null,
};

let visible = new Set(DEFAULT_VISIBLE);
const listeners = new Set();
const presetListeners = new Set();

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

function emitPreset(name) {
  for (const fn of presetListeners) {
    try { fn(name); } catch (err) { console.warn('preset listener failed', err); }
  }
}

/**
 * Enumerate every column key from the thead. Multiple ths can
 * share the same data-col (the dual Acres case); deduped here.
 */
export function listAllColumns() {
  const seen = new Map();
  for (const th of document.querySelectorAll('#results thead th[data-col]')) {
    // Columns tagged data-no-gear (e.g. the parcel-numbering "#" column)
    // manage their own visibility via a mode class and must not appear
    // in the gear checklist or be swept by presets.
    if (th.hasAttribute('data-no-gear')) continue;
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

/**
 * Imported parcel lists arrive with a pre-baked MASC rating on each matched
 * parcel. Surface that rating in the normal grid without making the user turn
 * on the MASC map overlay, and trade out ZBL to keep the default width stable.
 * Full detail (`visible === null`) remains untouched because it intentionally
 * shows every available column.
 */
export function applyParcelImportDefaults() {
  if (visible == null) return;
  visible.add('soil');
  visible.delete('zbl');
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
  emitPreset(name);
}

/**
 * Subscribe to preset application. Fires with the preset's name AFTER the
 * visible-set has been swapped and applied to the DOM.
 *
 * Exists because a preset is a statement of intent, not just a display
 * choice: "Agricultural" means the user wants the ag data, and some of
 * those columns (CLI, Soil Type) only populate once the soil-survey join
 * has run. main.js hangs that load off this hook so picking the preset
 * fills the columns instead of revealing empty ones. Kept as a listener
 * rather than an import so this module stays free of app/network deps.
 */
export function onPresetApply(fn) {
  if (typeof fn === 'function') presetListeners.add(fn);
  return () => presetListeners.delete(fn);
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
    // data-no-gear columns (parcel-numbering "#") are governed by their
    // own mode class, never by the gear's visible-set.
    if (th.hasAttribute('data-no-gear')) return false;
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
