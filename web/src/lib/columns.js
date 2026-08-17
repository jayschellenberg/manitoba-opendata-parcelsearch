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
 * `data-col="rollsize"` is doubled the same way and for the same
 * reason — it rides immediately ahead of Acres in both modes so the
 * roll's own figure and the working acreage stay side by side.
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
  // Municipality name (Muni_Name_With_Typ, "HEADINGLEY (RM)").
  // Default-visible (and in every preset): a multi-municipality result
  // set — regions on the Sales tab, an imported list — is unreadable
  // without it. Muni # (the numeric code) stays gear-only; the name is
  // what a reader recognises.
  'muniname',
  'address',
  'saledate',
  'saleprice',
  'grouppriceac',
  // Total acres across the sale. Default-visible beside $/Acre because it is
  // that rate's denominator: on a multi-parcel sale the per-parcel Acres cell
  // is not the land the price bought, and without this the grid showed the
  // rate and both of its inputs EXCEPT the one that differs from what the eye
  // expects (Jason, 2026-08-13).
  'groupacres',
  'acres',
  'zone1',
  // The province's ZONE_CATEGORY rollup. Default-visible beside the code
  // because the code alone is unreadable across municipal lines — every
  // by-law invents its own — and the type is the half that compares.
  'zonecat',
  'legal',
  'title',
  'du',
  // The roll's own frontage/area string. Default-visible because for the ~37%
  // of parcels recording frontage feet it is the ONLY assessor-stated size the
  // grid can show — Acres falls back to a polygon estimate there.
  'rollsize',
  'sf',
  'value',
  'soil',
  'subjdist',
  'clicls',
  'soiltype',
  'slope',
  // Water influence ships as a pre-baked per-muni shard (like Land Cover), so
  // it is NOT mode-gated the way Tile/Irrigation are — it fills in as soon as
  // the shard loads and is useful on residential searches, not just farmland.
  'water',
  // Tile Drainage + Irrigation are mode-gated by .water-only, so they
  // stay invisible until a WALLAS overlay or filter is active. Being in
  // the default set just means the gear isn't independently suppressing
  // them — otherwise switching the overlay on would appear to do nothing
  // to the grid.
  'tile',
  'irrigation',
  // StreetView is a link-out like Walkscore/Flood, but unlike them it is
  // default-visible: it was requested as an always-there orientation tool,
  // and the 🌐 cell costs almost no width.
  'streetview',
]);

// Columns added AFTER a user's stored visible-set may have been written.
// A stored set predating a column cannot contain it, and the stored set
// wins over DEFAULT_VISIBLE — so without this, a new column would stay
// invisible to every existing user until they happened to open the gear.
// Each key here is added to the visible set ONCE (tracked separately in
// ADOPTED_KEY); untick it after that and it stays unticked.
const ADOPTED_KEY = 'mbps_table_columns_adopted';
const ADOPT_ONCE = ['streetview', 'rollsize', 'zonecat', 'muniname'];

// Column presets — `null` value means "everything that the current
// mode would show". The labels match the dropdown options.
export const PRESETS = {
  // Every preset carrying 'acres' also carries 'rollsize'. The roll's own
  // figure is the primary size source, so a preset that shows a derived
  // acreage while hiding the number it was derived from would be presenting
  // the weaker value as the authoritative one — and on the ~37% of parcels
  // stating frontage feet it would hide the only assessor-stated size there is.
  'Sales analysis': new Set([
    'favorite', 'roll', 'muniname', 'address', 'saledate', 'saleprice',
    'grouppriceac', 'grouppricesf', 'grouppricelot', 'rollsize', 'acres',
    'groupacres',
    'zone1', 'zonecat', 'subjdist', 'saletoasmt',
  ]),
  // Commercial comps (Jason's chosen list, 2026-08-17): identity + sale +
  // zoning/legal/size + the Assessment and StreetView link-outs.
  //
  // Carries NO unit-rate column at all — not $/Acre, $/SF, $/FF or $/Lot.
  // That is the deliberate difference from Sales analysis: a commercial
  // sale is read on its total price against the improvement, and a rate
  // per acre invites comparing two properties whose value is mostly
  // building. Also excludes SF, and the whole agricultural group (soil,
  // riskarea, clicls, soiltype, slope, landcover, cultpct, tile,
  // irrigation), which is empty width on a commercial search.
  //
  // ★ stays so comp starring/export keeps working; rollsize rides with
  // acres per the invariant at the top of PRESETS.
  'Commercial Sales': new Set([
    'favorite', 'roll', 'muniname', 'address', 'saledate', 'saleprice',
    'zone1', 'legal', 'du', 'rollsize', 'acres', 'value', 'streetview',
  ]),
  // Land comps (Jason's chosen list, 2026-08-17) — the mirror of Commercial
  // Sales: where that view drops every unit rate, this one leads with them,
  // because bare land IS compared on rate per unit. Carries the full group
  // block (Group #, Group Acres) since a land sale is routinely several
  // parcels, and the assessment split so a "vacant" comp that turns out to
  // carry a building is visible rather than inferred from price.
  //
  // NOTE: there is no Group SF column in the table — the group block is
  // Group # and Group Acres only. $/SF already divides by the group's total
  // square footage, so the figure is present as a rate but not as its own
  // column; adding one means a new <th>, cell, sort key and export field.
  'Land Sales': new Set([
    'favorite', 'roll', 'muniname', 'saledate', 'saleprice', 'groupsize',
    'address', 'zone1', 'rollsize', 'acres', 'sf', 'groupacres',
    'grouppriceac', 'grouppricesf', 'grouppriceff', 'grouppricelot',
    'saletoasmt', 'asmtland', 'asmtbldg', 'asmtpct', 'asmtyear',
    'legal', 'value', 'streetview',
  ]),
  // Frontage earns its place here on its own merits: minimum lot frontage is
  // a bulk requirement in most Manitoba zoning by-laws, so on an urban parcel
  // the roll's frontage figure is the number being checked against.
  'Zoning check': new Set([
    'roll', 'muniname', 'address', 'zone1', 'zonecat', 'zone1pct', 'zone2', 'zbl',
    'dev1', 'dpbylaw', 'changes', 'rollsize', 'acres',
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
    'favorite', 'roll', 'muniname', 'address', 'rollsize', 'acres', 'landcover', 'cultpct', 'water',
    'soil', 'clicls', 'soiltype', 'slope', 'riskarea', 'tile', 'irrigation',
    'grouppriceac', 'groupacres', 'saledate', 'saleprice', 'saletoasmt', 'grouppricesf',
    'zone1', 'dev1', 'legal', 'title',
  ]),
  // Residential-oriented view — the mirror of Agricultural. Deliberately
  // excludes EVERY farmland field: soil, riskarea, clicls, soiltype, slope,
  // landcover, cultpct, tile, irrigation. On a town or subdivision search
  // those columns are permanently empty (MASC and land cover are farmland-only
  // by construction, and the land-cover shards skip anything under 10 acres),
  // so they cost horizontal space to say nothing.
  //
  // What replaces them is what actually moves residential value: the
  // assessment split (land vs building, and the building share), dwelling
  // units, lot size in both acres and SF, zoning, and Water — waterfront and
  // retention-pond frontage are residential concerns first, which is why the
  // water column earns a place here and the ag columns don't.
  //
  // Unlike Agricultural this triggers NO soil-survey load (see onPresetApply):
  // there is nothing here that needs it, so picking it stays instant.
  //
  // The assessment split and the sale-price fields are `.sales-only`, so in
  // plain Property Search they stay hidden and fill in once Sales Analysis is
  // active — the same mode-gating the Agricultural preset relies on. Being in
  // the set only means the gear isn't independently suppressing them.
  'Residential': new Set([
    'favorite', 'roll', 'muniname', 'address', 'rollsize', 'acres', 'sf', 'du',
    'water',
    'value', 'asmtland', 'asmtbldg', 'asmtpct', 'asmtyear',
    'zone1', 'zbl', 'dev1', 'changes',
    // $/FF earns its place here specifically: frontage is what an urban
    // lot is compared on, and the ~37% of parcels stating a frontage
    // rather than an area are overwhelmingly town and subdivision lots —
    // exactly this preset's subject. Blank on the rest, which is the data
    // saying the roll records no frontage, not a gap.
    'saledate', 'saleprice', 'saletoasmt', 'grouppricelot', 'grouppricesf',
    'grouppriceff',
    'legal', 'title',
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
  // Leaving "Full detail" (null = everything). Seed the Set from every
  // known column, NOT from empty: unticking one box in full-detail mode
  // used to build an empty Set and blank the entire table.
  if (visible == null) visible = new Set(listAllColumns().map((c) => c.key));
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
  // "Full detail" (visible === null) means every column the data could
  // fill, so it also lifts the OVERLAY gating — Dev-Plan and Tile /
  // Irrigation otherwise stay hidden until their layer is switched on,
  // which made the preset look like it was still holding columns back.
  // See the .all-columns rule in style.css for what it does and does not
  // reveal.
  document.getElementById('results')?.classList.toggle('all-columns', visible == null);
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
  // One-time adoption of post-v2 columns — see ADOPT_ONCE above.
  try {
    const adopted = new Set(JSON.parse(localStorage.getItem(ADOPTED_KEY) || '[]'));
    let changed = false;
    for (const key of ADOPT_ONCE) {
      if (adopted.has(key)) continue;
      adopted.add(key);
      if (visible != null) visible.add(key);
      changed = true;
    }
    if (changed) {
      localStorage.setItem(ADOPTED_KEY, JSON.stringify([...adopted]));
      writeStored();
    }
  } catch { /* storage unavailable — column stays gear-only */ }
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
