// provinceSearch.js — the province-wide class search over the imported MAO
// sales archive. Pure: no DOM, no IndexedDB, so it runs under node.
//
// WHAT IT IS FOR. The municipality picker answers "sales near the subject".
// This answers "every Class 60 sale in Manitoba over $250k since 2015" —
// Jason, 2026-09-24. The filter order is his: assessment class AT THE SALE
// first, then the primary property types found in that class, with sale
// date, sale type group and a whole-sale price window at the same step.
//
// WHY AN INDEX. The archive is ~170 MB of CSV across 186 shards. Scanning it
// for every change to a filter would mean tokenizing 680k rows each time.
// Instead each shard is walked ONCE into a small columnar index — class
// bits, date, price, sale type, property-type keys, one entry per sale —
// and every filter, count and property-type list afterwards runs over that
// in milliseconds. Only on Search are the matching rows pulled back out of
// the raw shards, by their row number, so the existing pipeline receives
// exactly the CSV a municipality load would have given it.
//
// CLASS AT SALE comes from the export's "Class At Sale" column
// (mao-scrape/scripts/class_at_sale_lib.R): MAO's code for the class with
// the highest assessed value, one stacked line per roll. A multi-roll sale
// matches if ANY roll carries the class (Jason's rule). A sale with no class
// on any roll is UNKNOWN — before 1996 that is every sale, because neither
// the sales PDFs nor the tax history reach back that far.

import { forEachCsvRow, tokenizeRows } from './delimitedRows.js';
import { familyOf, subcategoryOf, optionKey, FAMILY_ORDER, NO_STRUCTURE, OTHER_SUBCATEGORY }
  from './primaryProperty.js';

/** MAO class codes, in the order the picker lists them: by number (Jason, 2026-09-24). */
export const CLASS_CODES = [
  ['11', 'Residential 1 — single family'],
  ['12', 'Residential 1 — with farm use'],
  ['20', 'Residential 2 — multi-family'],
  ['30', 'Farm'],
  ['40', 'Institutional'],
  ['41', 'Designated higher education'],
  ['51', 'Pipeline'],
  ['52', 'Railway'],
  ['60', 'Other (commercial / industrial)'],
  ['70', 'Designated recreational'],
  ['80', 'Residential 3 — condos & co-ops'],
];

/** The picker value for "no class recorded at the sale". */
export const UNKNOWN_CLASS = 'unknown';

// One bit per code, so a multi-roll sale's classes are a single integer and
// "any roll matches" is one AND. Bit 0 is UNKNOWN; a code MAO adds later
// that is not in CLASS_CODES gets the OTHER bit rather than vanishing.
const CLASS_BIT = new Map(CLASS_CODES.map(([code], i) => [code, 1 << (i + 1)]));
const UNKNOWN_BIT = 1;
const OTHER_BIT = 1 << (CLASS_CODES.length + 1);

/** Bitmask for a set of picker values ('60', 'unknown', ...). */
export function classMask(values) {
  let m = 0;
  for (const v of values || []) {
    if (v === UNKNOWN_CLASS) m |= UNKNOWN_BIT;
    else m |= CLASS_BIT.get(String(v)) ?? OTHER_BIT;
  }
  return m;
}

/** Class bits of one stacked "Class At Sale" cell. */
export function classBitsOf(cell) {
  let m = 0;
  for (const line of String(cell ?? '').split(/\r\n|\r|\n/)) {
    const code = line.trim();
    if (code) m |= CLASS_BIT.get(code) ?? OTHER_BIT;
  }
  return m || UNKNOWN_BIT;
}

// The export's column names — what shards actually carry. Exact match after
// trim, like salesStore's DATE_COL / TYPE_COL.
const COL = {
  date: 'sale_date_parsed',
  price: 'consideration_num',
  type: 'Sale Type Group',
  primary: 'Primary Property',
  cls: 'Class At Sale',
};

const firstLine = (cell) => String(cell ?? '').split(/\r\n|\r|\n/)[0].trim();

/**
 * The window the class search opens with (Jason, 2026-09-24): Jan 1 five
 * years back, through the newest sale in the database. The end is the
 * archive's newest sale, not today — MAO posts sales ~3 weeks late, so
 * "today" would promise a stretch no archive holds. Blank when the manifest
 * has no usable newest_sale.
 *
 * @param {Date} today
 * @param {string} [newestSale] manifest.newest_sale, ISO
 */
export function defaultDateWindow(today, newestSale) {
  const from = `${today.getFullYear() - 5}-01-01`;
  const to = /^\d{4}-\d{2}-\d{2}/.test(String(newestSale || '')) ? String(newestSale).slice(0, 10) : '';
  return { from, to };
}

/** ISO date -> yyyymmdd integer (0 when unreadable), so ranges are int compares. */
export function dateKey(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '').trim());
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
}

/**
 * Index one shard's CSV text.
 *
 * Returns null when the shard predates the class column: an index built
 * without it would file every sale as UNKNOWN and a Class 60 search would
 * silently find nothing, which is worse than refusing.
 *
 * `subs` holds each sale's property-type option keys as indexes into the
 * shared `keys` list, because the same few dozen strings repeat 680k times.
 */
export function indexShard(csv, keys = new KeyTable()) {
  let cols = null;
  const out = { rows: [], dates: [], prices: [], classes: [], types: [], subs: [] };
  let ok = true;
  forEachCsvRow(csv, (text, i) => {
    const cells = tokenizeRows(text, ',')[0] || [];
    if (i === 0) {
      const at = (name) => cells.findIndex((c) => String(c).trim() === name);
      cols = Object.fromEntries(Object.entries(COL).map(([k, name]) => [k, at(name)]));
      if (cols.cls < 0) { ok = false; return false; }
      return true;
    }
    const type = firstLine(cells[cols.type]);
    // Property type is per ROLL: a two-roll sale can be a warehouse on one
    // roll and bare land on the other, and it matches either being ticked.
    const family = familyOf(type, firstLine(cells[cols.primary]));
    const descs = String(cells[cols.primary] ?? '').split(/\r\n|\r|\n/);
    const subKeys = new Set();
    for (const d of descs.length ? descs : ['']) {
      subKeys.add(keys.id(optionKey(family, subcategoryOf(family, d))));
    }
    const price = Number(String(cells[cols.price] ?? '').replace(/[$,\s]/g, ''));
    out.rows.push(i);                                   // data-row index, header = 0
    out.dates.push(dateKey(firstLine(cells[cols.date])));
    out.prices.push(Number.isFinite(price) && String(cells[cols.price] ?? '').trim() !== '' ? price : NaN);
    out.classes.push(classBitsOf(cells[cols.cls]));
    out.types.push(keys.id(type.toUpperCase()));
    out.subs.push(subKeys.size === 1 ? [...subKeys][0] : [...subKeys]);
    return true;
  });
  return ok ? out : null;
}

/** Interns repeated strings (sale types, property-type keys) as small ints. */
export class KeyTable {
  constructor(list = []) { this.list = [...list]; this.map = new Map(this.list.map((k, i) => [k, i])); }
  id(k) {
    let i = this.map.get(k);
    if (i === undefined) { i = this.list.length; this.list.push(k); this.map.set(k, i); }
    return i;
  }
  has(k) { return this.map.has(k); }
}

/**
 * Normalise the panel's inputs into what the matcher tests.
 *
 * @param {Object} c
 * @param {string[]} c.classes   picker values, e.g. ['60'] or ['60','unknown']
 * @param {string}   [c.from]    ISO date, inclusive
 * @param {string}   [c.to]      ISO date, inclusive
 * @param {string[]} [c.types]   Sale Type Group values; empty = any
 * @param {number|string} [c.min] whole-sale price floor
 * @param {number|string} [c.max] whole-sale price ceiling
 * @param {string[]} [c.subcats] property-type option keys; empty = any
 */
export function compileCriteria(c = {}, keys) {
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const typeIds = new Set((c.types || []).map((t) => String(t).toUpperCase())
    .filter((t) => keys.has(t)).map((t) => keys.id(t)));
  const subIds = new Set((c.subcats || []).filter((k) => keys.has(k)).map((k) => keys.id(k)));
  return {
    mask: classMask(c.classes),
    from: dateKey(c.from),
    to: dateKey(c.to),
    anyType: !(c.types || []).length,
    typeIds,
    min: num(c.min),
    max: num(c.max),
    anySub: !(c.subcats || []).length,
    subIds,
  };
}

/**
 * Does sale `j` of a shard index pass everything EXCEPT the property-type
 * filter? Split out so the property-type list can be counted over the set
 * it filters, without the list shrinking as boxes are ticked.
 *
 * An undated sale fails a date window, and an unpriced sale fails a price
 * bound: this search builds a comp set from scratch, so a row that cannot
 * be shown to be inside the window does not belong in it. (The municipality
 * load keeps undated rows because there the user already chose the place.)
 */
function passesBase(ix, j, k) {
  if (!(ix.classes[j] & k.mask)) return false;
  if (k.from || k.to) {
    const d = ix.dates[j];
    if (!d || (k.from && d < k.from) || (k.to && d > k.to)) return false;
  }
  if (!k.anyType && !k.typeIds.has(ix.types[j])) return false;
  if (k.min !== null || k.max !== null) {
    const p = ix.prices[j];
    if (Number.isNaN(p) || (k.min !== null && p < k.min) || (k.max !== null && p > k.max)) return false;
  }
  return true;
}

function passesSubs(ix, j, k) {
  if (k.anySub) return true;
  const s = ix.subs[j];
  return Array.isArray(s) ? s.some((id) => k.subIds.has(id)) : k.subIds.has(s);
}

/**
 * Run the search over every shard index.
 *
 * @param {Map<string, Object>} indexes muni_no -> indexShard() result
 * @returns {{ total: number, byMuni: Map<string, number[]>, tree: Array }}
 *   byMuni holds the matching data-row indexes per shard; tree is the
 *   property-type list for the base filter, counted in SALES.
 */
export function runSearch(indexes, criteria, keys) {
  const k = compileCriteria(criteria, keys);
  const byMuni = new Map();
  const subCounts = new Map();   // key id -> sales
  let total = 0;
  if (!k.mask) return { total, byMuni, tree: [] };
  for (const [muni, ix] of indexes) {
    const hits = [];
    for (let j = 0; j < ix.rows.length; j++) {
      if (!passesBase(ix, j, k)) continue;
      const s = ix.subs[j];
      for (const id of (Array.isArray(s) ? s : [s])) subCounts.set(id, (subCounts.get(id) || 0) + 1);
      if (!passesSubs(ix, j, k)) continue;
      hits.push(ix.rows[j]);
    }
    if (hits.length) { byMuni.set(muni, hits); total += hits.length; }
  }
  return { total, byMuni, tree: subTree(subCounts, keys) };
}

// Same ordering primaryPropertyTree uses, so the two lists read alike.
function subRank(name) {
  if (name === NO_STRUCTURE) return 2;
  if (name === OTHER_SUBCATEGORY) return 1;
  return 0;
}

function subTree(counts, keys) {
  const byFamily = new Map();
  for (const [id, count] of counts) {
    const key = keys.list[id];
    const cut = key.indexOf('|');
    const family = key.slice(0, cut), label = key.slice(cut + 1);
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push({ value: key, label, count });
  }
  const order = (f) => { const i = FAMILY_ORDER.indexOf(f); return i < 0 ? 99 : i; };
  return [...byFamily.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((family) => {
      const options = byFamily.get(family)
        .sort((a, b) => subRank(a.label) - subRank(b.label) || a.label.localeCompare(b.label));
      return { family, count: options.reduce((s, o) => s + o.count, 0), options };
    });
}

/**
 * The header plus the given data rows of one shard, as raw CSV text.
 * Rows come back verbatim — never re-serialised — so the parser sees
 * exactly what a municipality load would have handed it.
 */
export function extractRows(csv, rowIndexes) {
  const want = new Set(rowIndexes);
  let last = 0;
  for (const r of want) if (r > last) last = r;
  let header = null;
  const rows = [];
  forEachCsvRow(csv, (text, i) => {
    if (i === 0) { header = text.replace(/\r$/, ''); return true; }
    if (want.has(i)) rows.push(text);
    return i < last;                     // stop once the last wanted row is out
  });
  return { header, rows };
}

/** One-line description of a search, for status lines and saved-search names. */
export function describeCriteria(c = {}) {
  const label = new Map(CLASS_CODES);
  const cls = (c.classes || []).filter((v) => v !== UNKNOWN_CLASS)
    .map((v) => `Class ${v}${label.has(v) ? ` ${label.get(v).split(' — ')[0]}` : ''}`);
  if ((c.classes || []).includes(UNKNOWN_CLASS)) cls.push('unknown class');
  const money = (v) => `$${Number(v).toLocaleString()}`;
  const price = c.min && c.max ? `${money(c.min)}–${money(c.max)}`
    : c.min ? `≥ ${money(c.min)}` : c.max ? `≤ ${money(c.max)}` : '';
  const dates = c.from || c.to ? `${c.from || 'earliest'} → ${c.to || 'today'}` : '';
  const types = (c.types || []).length ? `${c.types.length} sale type${c.types.length > 1 ? 's' : ''}` : '';
  const subs = (c.subcats || []).length
    ? `${c.subcats.length} property type${c.subcats.length > 1 ? 's' : ''}` : '';
  return [cls.join(' + '), price, dates, types, subs].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// Saved searches — this browser only (Jason, 2026-09-24). Only the SETTINGS
// are stored, never sales, so nothing subscriber-derived ever sits outside
// the sales database. Storage is injected so node can test it; every access
// is guarded because a private window or blocked site data makes
// localStorage throw, and a saved-search failure must never break a search.
// ---------------------------------------------------------------------------
export const SAVED_KEY = 'mb-parcel-sales.provinceSearches';

export function listSaved(storage) {
  try {
    const v = JSON.parse(storage?.getItem(SAVED_KEY) || '[]');
    return Array.isArray(v) ? v.filter((s) => s && typeof s.name === 'string' && s.criteria) : [];
  } catch { return []; }
}

/** Save (or overwrite, by name) a search. Returns the new list, or null on failure. */
export function saveSearch(storage, name, criteria) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const list = listSaved(storage).filter((s) => s.name !== clean);
  list.push({ name: clean, criteria, saved_at: new Date().toISOString() });
  list.sort((a, b) => a.name.localeCompare(b.name));
  try { storage.setItem(SAVED_KEY, JSON.stringify(list)); return list; } catch { return null; }
}

export function deleteSaved(storage, name) {
  const list = listSaved(storage).filter((s) => s.name !== name);
  try { storage.setItem(SAVED_KEY, JSON.stringify(list)); return list; } catch { return null; }
}
