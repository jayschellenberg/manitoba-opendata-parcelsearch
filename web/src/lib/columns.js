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
  // MAO's classification of the SALE (FARM BARE LAND, ICI LAND AND BUILDINGS…).
  // Default-visible because it is the field that explains why a sale does or
  // does not appear in a sale-type-narrowed search — the question the grid
  // could not answer before (Jason, 2026-08-19). .sales-only, so Property
  // Search never renders it.
  'saletype',
  // N1 crosswalk ID — default-visible (and ADOPT_ONCE for stored sets):
  // the whole point of the crosswalk is seeing at a glance which comps
  // already live in N1, so a hidden-by-default column would bury it.
  'n1id',
  'grouppriceac',
  // Total acres across the sale. Default-visible beside $/Acre because it is
  // that rate's denominator: on a multi-parcel sale the per-parcel Acres cell
  // is not the land the price bought, and without this the grid showed the
  // rate and both of its inputs EXCEPT the one that differs from what the eye
  // expects (Jason, 2026-08-13).
  'groupacres',
  'acres',
  // Boundary — whether today's polygon is still what sold, from the shard's
  // Parcel Change evidence. Default-visible beside Acres because it is the
  // qualifier on that number: a "Changed" row usually has a blank Acres, and
  // without this the blank looked like missing data rather than a deliberate
  // refusal to substitute today's acreage (Jason, 2026-08-21). .sales-only.
  'boundary',
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
const ADOPT_ONCE = ['streetview', 'rollsize', 'zonecat', 'n1id', 'muniname', 'saletype', 'boundary'];

// Column presets — `null` value means "everything that the current
// mode would show". The labels match the dropdown options.
export const PRESETS = {
  // Every preset carrying 'acres' also carries 'rollsize'. The roll's own
  // figure is the primary size source, so a preset that shows a derived
  // acreage while hiding the number it was derived from would be presenting
  // the weaker value as the authoritative one — and on the ~37% of parcels
  // stating frontage feet it would hide the only assessor-stated size there is.
  'Sales analysis': new Set([
    'favorite', 'roll', 'muniname', 'address', 'saledate', 'saleprice', 'saletype', 'n1id',
    'grouppriceac', 'grouppricesf', 'grouppricelot', 'rollsize', 'acres', 'boundary',
    'groupacres',
    'zone1', 'zonecat', 'subjdist', 'saletoasmt',
    // Total assessed, added 2026-08-18 beside Sale/Asmt. That column is a
    // RATIO, and a ratio shown without its denominator cannot be read: a 0.6
    // against a $40k assessment and a 0.6 against a $400k one are the same
    // number describing entirely different sales. Every other sales preset
    // already carried the value; this one showed only the quotient.
    'value',
  ]),
  // Commercial comps (Jason's chosen list, 2026-08-17): identity + sale +
  // the structure description + zoning/legal/size + the Assessment and
  // StreetView link-outs.
  //
  // Primary Property (added 2026-08-17) is MAO's description of the main
  // structure — "AVERAGE FRAME WAREHOUSE". On a commercial comp that string
  // is what decides whether the sale is comparable at all, which matters
  // more here than on any other preset because this view carries no unit
  // rate to fall back on. A blank cell is a reading, not a gap: it means no
  // primary structure, i.e. bare land, which is 71% of ICI sales. Note it
  // populates from subscriber sales data only, so a non-subscriber export
  // leaves the column empty throughout.
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
    'saletype', 'primaryprop', 'n1id',
    'zone1', 'legal', 'du', 'rollsize', 'acres', 'boundary', 'value', 'streetview',
  ]),
  // Land comps (Jason's chosen list, 2026-08-17) — the mirror of Commercial
  // Sales: where that view drops every unit rate, this one leads with them,
  // because bare land IS compared on rate per unit. Carries the full group
  // block (Group #, Group Acres) since a land sale is routinely several
  // parcels, and the assessment split so a "vacant" comp that turns out to
  // carry a building is visible rather than inferred from price.
  //
  // Five columns joined on review (Jason, 2026-08-19), each closing a gap the
  // original list left on a bare-land comp:
  //
  //   n1id       — every other sales preset carries it, and the sidebar has an
  //                N1 filter whose result this view could not read. Which land
  //                comps are already in N1 is the crosswalk queue's whole
  //                question.
  //   zonecat    — Land Sales carried the municipal zone CODE but not the
  //                province's rollup, and land searches are routinely
  //                multi-muni, where the code compares across nothing.
  //   subjdist   — distance from the subject is a first-pass screen on any
  //                comp set, and the tab's subject/radius controls had no
  //                column to report into here.
  //   primaryprop— on a LAND view a non-blank descriptor is a red flag: the
  //                "bare land" comp has a building on it. The preset already
  //                carried Bldg $ / Bldg % for that check; this is the direct
  //                signal rather than the inferred one, and it is what
  //                disagrees with Sale Type Group on Macdonald roll 90800.
  //   water      — waterfront and near-water frontage move bare land value
  //                more than they move improved value, and it ships pre-baked
  //                per muni, so it costs no overlay load.
  'Land Sales': new Set([
    'favorite', 'roll', 'n1id', 'muniname', 'saledate', 'saleprice', 'groupsize',
    'address', 'zone1', 'zonecat', 'rollsize', 'acres', 'boundary', 'sf', 'groupacres', 'groupsf',
    'grouppriceac', 'grouppricesf', 'grouppriceff', 'grouppricelot',
    'subjdist', 'saletype', 'primaryprop', 'water',
    'saletoasmt', 'asmtland', 'asmtbldg', 'asmtpct', 'asmtyear',
    'legal', 'value', 'streetview',
  ]),
  // Frontage earns its place here on its own merits: minimum lot frontage is
  // a bulk requirement in most Manitoba zoning by-laws, so on an urban parcel
  // the roll's frontage figure is the number being checked against.
  'Zoning check': new Set([
    'roll', 'muniname', 'address', 'zone1', 'zonecat', 'zone1pct', 'zone2', 'zbl',
    'dev1', 'dpbylaw', 'changes', 'rollsize', 'acres', 'boundary',
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
    'favorite', 'roll', 'muniname', 'address', 'rollsize', 'acres', 'boundary', 'landcover', 'cultpct', 'water',
    'soil', 'clicls', 'soiltype', 'slope', 'riskarea', 'tile', 'irrigation',
    'grouppriceac', 'groupacres', 'saledate', 'saleprice', 'saletype', 'saletoasmt', 'grouppricesf',
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
    'favorite', 'roll', 'muniname', 'address', 'rollsize', 'acres', 'boundary', 'sf', 'du',
    'water',
    'value', 'asmtland', 'asmtbldg', 'asmtpct', 'asmtyear',
    'zone1', 'zbl', 'dev1', 'changes',
    // $/FF earns its place here specifically: frontage is what an urban
    // lot is compared on, and the ~37% of parcels stating a frontage
    // rather than an area are overwhelmingly town and subdivision lots —
    // exactly this preset's subject. Blank on the rest, which is the data
    // saying the roll records no frontage, not a gap.
    'saledate', 'saleprice', 'saletype', 'saletoasmt', 'grouppricelot', 'grouppricesf',
    'grouppriceff',
    // Primary Property — MAO's structure descriptor, added 2026-08-18. 45% of
    // residential sales carry none at all, which IS the reading: bare land.
    // Without it nothing in this preset separates a house sale from a vacant
    // lot except inferring it backwards from Bldg %, and that inference fails
    // on exactly the rolls with no assessment split on file.
    'primaryprop',
    'legal', 'title',
  ]),
  'Full detail': null,
};

/**
 * Per-preset COLUMN ORDER. The presets above decide WHICH columns render;
 * this decides WHERE they render.
 *
 * The table has exactly one physical column order — the thead's own
 * sequence — and for most presets that order is right. Land Sales is the
 * exception. Bare land is compared on rate per unit, so $/Acre is the
 * whole reason that preset exists, and the natural order buries it 13th
 * behind the identity, size and group columns — off-screen without a
 * horizontal scroll (Jason, 2026-08-19). The preset's own comment already
 * claimed it "leads with them"; this is what makes that true.
 *
 * A preset with NO entry here keeps the natural thead order, so nothing
 * changes for Sales analysis, Commercial Sales, Zoning check, Agricultural,
 * Residential or Full detail.
 *
 * Three rules, each load-bearing:
 *
 *   - Unlisted keys keep their natural order and follow the listed ones.
 *     The list is a "bring these forward" statement, not a full manifest,
 *     so a column added to the preset later still renders without having
 *     to be repeated here.
 *   - A key naming TWO physical columns moves both. `acres` and `rollsize`
 *     each appear twice in the thead (a .sales-only twin and a .basic-only
 *     twin); only the mode-appropriate one ever renders, so moving both
 *     lands them adjacent and the user still sees one column — the same
 *     reasoning the visibility set uses for the same pair.
 *   - data-no-gear columns (the map-# column) are pinned at the front and
 *     never move: their position is part of the numbering affordance.
 */
export const PRESET_ORDER = {
  // Identity and the sale first — enough to know WHICH comp this is —
  // then the rates, which is what the view is for.
  //
  // Every rate is followed immediately by its own denominator. That is the
  // invariant the natural order already gropes towards and this makes
  // literal: on a multi-parcel sale a rate shown without the figure it was
  // divided by cannot be read, because the per-parcel Acres cell is not the
  // land the price bought (Jason, 2026-08-13). So $/Acre → Group Acres,
  // $/SF → Group SF, $/Lot → Group #.
  //
  // $/FF is the exception to that pairing: its denominator is the frontage
  // inside Roll Frontage/Area, and that column is ALSO the primary size
  // source that has to ride immediately ahead of Acres (see the invariant
  // at the top of PRESETS). It cannot sit in both places, so it stays with
  // Acres and $/FF is left beside the other rates.
  'Land Sales': [
    // N1 ID rides with the identity block: it is a short cell answering "is
    // this comp already in the database", which is the first thing to know
    // about a comp and the last thing worth scrolling for. $/Acre still
    // follows Address immediately, which is the placement that matters.
    'favorite', 'roll', 'n1id', 'muniname', 'saledate', 'saleprice', 'address',
    'grouppriceac', 'groupacres', 'grouppricesf', 'groupsf',
    'grouppriceff', 'grouppricelot', 'groupsize',
    // Per-parcel size AFTER the group figures: on a land comp the sale is
    // the transaction and the parcel is a component of it.
    'rollsize', 'acres', 'boundary', 'sf',
    // Distance screens the comp set before any of its detail matters.
    'subjdist',
    'zone1', 'zonecat', 'water',
    // The "is it really bare land?" block, read together: MAO's category for
    // the sale, its structure descriptor, then the assessment split that
    // either corroborates them or contradicts both.
    'saletype', 'primaryprop',
    // Sale/Asmt is a ratio and Assessment is its denominator, so the same
    // pairing rule puts them together ahead of the assessment split.
    'saletoasmt', 'value', 'asmtland', 'asmtbldg', 'asmtpct', 'asmtyear',
    'legal', 'streetview',
  ],
};

/**
 * Resolve a preset's key list into a permutation of natural column indices.
 *
 * Pure — no DOM — so the ordering rules above can be tested directly.
 *
 * @param {Array<{key: string, pinned?: boolean}>} natural
 *   Every physical column in thead order. `pinned` marks data-no-gear
 *   columns, which never move.
 * @param {string[]|null} order Preset key list, or null for natural order.
 * @returns {number[]} Natural indices in the order they should render.
 */
export function columnPermutation(natural, order) {
  const all = natural.map((c, i) => i);
  if (!order || !order.length) return all;
  // Key -> every natural index carrying it, in natural order. Duplicated
  // keys (the Acres / Roll Frontage-Area twins) therefore move as a pair.
  const byKey = new Map();
  const pinned = [];
  for (let i = 0; i < natural.length; i++) {
    if (natural[i].pinned) { pinned.push(i); continue; }
    const key = natural[i].key;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(i);
  }
  const out = [...pinned];
  const taken = new Set(pinned);
  for (const key of order) {
    for (const i of byKey.get(key) || []) {
      if (taken.has(i)) continue;   // key listed twice: first mention wins
      taken.add(i);
      out.push(i);
    }
  }
  // Everything the list didn't mention keeps its natural order behind.
  for (const i of all) if (!taken.has(i)) out.push(i);
  return out;
}

let visible = new Set(DEFAULT_VISIBLE);
// Which preset's column ORDER is in force, or null for the natural thead
// order. Persisted beside the visible-set (own key, so an older stored
// visibility set is untouched): a reload that restored Land Sales'
// COLUMNS but not its ORDER would put $/Acre back at position 13 —
// half the preset, which is worse than neither half.
const ORDER_KEY = 'mbps_table_order';
let orderName = null;
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
  // A preset with no PRESET_ORDER entry restores the natural thead order
  // rather than inheriting the last preset's — switching from Land Sales
  // to Agricultural must not leave the ag view leading with $/Acre.
  orderName = PRESET_ORDER[name] ? name : null;
  try {
    if (orderName) localStorage.setItem(ORDER_KEY, orderName);
    else localStorage.removeItem(ORDER_KEY);
  } catch { /* storage unavailable — order just doesn't survive a reload */ }
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
/**
 * Stamp each thead cell with its NATURAL index, once.
 *
 * Every reorder is expressed as a permutation of these indices rather than
 * of current DOM positions, so switching from one preset's order straight
 * to another's always starts from the same baseline instead of compounding
 * on whatever the last one left behind.
 */
function stampNaturalOrder(heads) {
  if (heads[0]?.dataset.nat !== undefined) return;
  heads.forEach((th, i) => { th.dataset.nat = String(i); });
}

/** Re-append a row's children in `perm` (an array of natural indices). */
function reorderChildren(rowEl, perm) {
  const cells = Array.from(rowEl.children);
  // A freshly-rendered tbody row is built in natural order and its cells
  // carry no data-col of their own, so position IS natural index on first
  // sight. Stamping it here is what lets a LATER order change find its way
  // back to the baseline.
  cells.forEach((c, i) => { if (c.dataset.nat === undefined) c.dataset.nat = String(i); });
  const byNat = new Map(cells.map((c) => [Number(c.dataset.nat), c]));
  const frag = document.createDocumentFragment();
  for (const n of perm) {
    const cell = byNat.get(n);
    if (cell) frag.appendChild(cell);
  }
  rowEl.appendChild(frag);
}

/**
 * Put the thead and every rendered row into the active preset's order.
 *
 * Idempotent and cheap to re-run: each row carries the signature of the
 * order it is already in, so a re-render (sort, page, filter) only pays
 * for the rows it actually rebuilt. Runs BEFORE the visibility pass
 * because that pass matches tds to ths positionally — reordering one
 * without the other would hide the wrong columns.
 */
function applyOrder(heads) {
  const headRow = heads[0]?.parentElement;
  if (!headRow) return;
  const order = orderName ? PRESET_ORDER[orderName] : null;
  const sig = order ? orderName : 'natural';
  // Read the column list back in NATURAL order via the data-nat stamps, NOT
  // in current DOM order. Once the thead has been reordered it no longer
  // reads left-to-right as the baseline, and feeding it back in computes a
  // permutation OF the permutation — identity, whenever the same preset is
  // re-applied. The thead survives that (its signature makes it a no-op) but
  // freshly rendered rows do not: they would be left in natural order under a
  // reordered header, putting every cell in the wrong column.
  const natural = heads
    .slice()
    .sort((a, b) => Number(a.dataset.nat) - Number(b.dataset.nat))
    .map((th) => ({ key: th.dataset.col, pinned: th.hasAttribute('data-no-gear') }));
  const perm = columnPermutation(natural, order || null);
  if (headRow.dataset.orderSig !== sig) {
    reorderChildren(headRow, perm);
    headRow.dataset.orderSig = sig;
  }
  for (const row of document.querySelectorAll('#results tbody tr')) {
    if (row.dataset.orderSig === sig) continue;
    reorderChildren(row, perm);
    row.dataset.orderSig = sig;
  }
}

export function applyVisibility() {
  let heads = Array.from(document.querySelectorAll('#results thead th'));
  if (!heads.length) return;
  // Column ORDER first, then visibility — see applyOrder. Re-read the
  // thead afterwards: the elements are the same but their DOM order (and
  // so their positional pairing with each row's tds) has just changed.
  stampNaturalOrder(heads);
  applyOrder(heads);
  heads = Array.from(document.querySelectorAll('#results thead th'));
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
  // Restore the column order alongside the visible-set. Guarded against a
  // stale key naming a preset that no longer declares an order.
  try {
    const savedOrder = localStorage.getItem(ORDER_KEY);
    if (savedOrder && PRESET_ORDER[savedOrder]) orderName = savedOrder;
  } catch { /* storage unavailable — natural order */ }
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
