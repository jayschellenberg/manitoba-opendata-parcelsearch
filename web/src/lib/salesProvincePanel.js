// salesProvincePanel.js — drives the "Whole province" side of the Sales tab's
// Search form: the class-at-sale picker, its property-type list and the live
// match count. The date range, sale price and sale type it searches by are the
// form's shared controls, read through injected getters (2026-11-23); the mode
// switch and saved searches live in salesSearchForm.js. The search itself (index, matching, row extraction) is pure and lives
// in provinceSearch.js; this file is the DOM and the IndexedDB reads.
//
// Same single contract as salesDbPanel: hand the existing pipeline a
// `{ name, text }` CSV via onLoad, so parsing, roll lookup, enrichment, the
// table, the map and the CSV download are all untouched.
//
// THE INDEX is built the first time a class is chosen in a session — one pass
// over every shard, ~4 s for the full archive — and kept in memory until the
// archive is re-imported (manifest.imported_at changes). After that every
// change to a filter recounts in milliseconds, which is what makes the live
// "N sales match" line and the property-type list possible.

import { getManifest, listShardKeys, getShard } from './salesStore.js';
import {
  CLASS_CODES, UNKNOWN_CLASS, KeyTable, indexShard, runSearch, extractRows,
  describeCriteria,
} from './provinceSearch.js';

const fmt = (n) => Number(n || 0).toLocaleString();

// Beyond this a load is minutes of parcel-geometry fetching (80 rolls per
// request), so ask first. Not a block — the same rule as BIG_LOAD_SALES.
const CONFIRM_ABOVE = 5000;

/**
 * @param {Object} opts
 * @param {(payload:Object) => (void|Promise<void>)} opts.onLoad
 * @param {() => void} [opts.onSearchStart]
 * @param {(msg:string) => void} [opts.setStatus]
 * @param {() => {from:string,to:string}} [opts.getDateWindow] the form's date range
 * @param {() => {min:string,max:string}} [opts.getPriceWindow] the form's Sale Price pair
 * @param {() => string[]} [opts.getTypes] the form's ticked sale types (none = any)
 * @returns {{recount: Function, getCriteria: Function, setCriteria: Function}}
 *   getCriteria / setCriteria carry only this side's own part of a search —
 *   { classes, subcats } — for the form's saved searches.
 */
export function initSalesProvincePanel({
  onLoad, onSearchStart, setStatus, getDateWindow, getPriceWindow, getTypes,
} = {}) {
  const $ = (id) => document.getElementById(id);
  const $class = $('sales-prov-class');
  if (!$class) return {};
  const $unknown = $('sales-prov-unknown');
  const $subs = $('sales-prov-subs');
  const $count = $('sales-prov-count');
  const $search = $('sales-prov-search');

  const say = (m) => { if (typeof setStatus === 'function') setStatus(m); };

  for (const [code, label] of CLASS_CODES) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = `${code} — ${label}`;
    $class.appendChild(o);
  }
  // ---- index ----------------------------------------------------------------
  let index = null;          // { stamp, keys, shards: Map<muni, ix>, header }
  let building = null;       // in-flight build promise, so two changes share one pass

  async function ensureIndex() {
    const manifest = await getManifest();
    const stamp = manifest?.imported_at || null;
    if (index && index.stamp === stamp) return index;
    if (building) return building;
    building = (async () => {
      const keys = new KeyTable();
      const shards = new Map();
      const muniKeys = (await listShardKeys()).map(String);
      let stale = 0;
      for (let i = 0; i < muniKeys.length; i++) {
        if (i % 10 === 0) {
          $count.textContent = `Indexing the archive… ${i}/${muniKeys.length} municipalities`;
          await new Promise((r) => setTimeout(r, 0));   // let the line paint
        }
        const rec = await getShard(muniKeys[i]);
        if (!rec?.csv) continue;
        const ix = indexShard(rec.csv, keys);
        if (!ix) { stale++; continue; }
        shards.set(muniKeys[i], ix);
      }
      // A shard without the class column means the folder predates the
      // export that added it. Searching the rest would silently undercount,
      // so say so instead.
      if (stale) {
        throw new Error(`${stale} of ${muniKeys.length} municipalities were exported before `
          + 'class at sale was added. Hit Reload once the next export has run.');
      }
      return { stamp, keys, shards };
    })();
    try {
      index = await building;
      return index;
    } finally { building = null; }
  }

  // ---- reading the controls -------------------------------------------------
  const checked = (root) => [...root.querySelectorAll('input[type=checkbox]:checked')].map((b) => b.value);

  function criteria() {
    const classes = [];
    if ($class.value) classes.push($class.value);
    if ($unknown.checked) classes.push(UNKNOWN_CLASS);
    const d = getDateWindow?.() || {};
    const p = getPriceWindow?.() || {};
    return {
      classes,
      from: (d.from || '').trim(),
      to: (d.to || '').trim(),
      min: (p.min || '').trim(),
      max: (p.max || '').trim(),
      types: [...(getTypes?.() || [])],
      subcats: checked($subs),
    };
  }

  /** This side's own part of a search, for the form's saved searches. */
  function getCriteria() {
    const c = criteria();
    return { classes: c.classes, subcats: c.subcats };
  }

  function setCriteria(c) {
    $class.value = (c.classes || []).find((v) => v !== UNKNOWN_CLASS) || '';
    $unknown.checked = (c.classes || []).includes(UNKNOWN_CLASS);
    // Property types render from the index, so park the wanted ticks until
    // the list is rebuilt by recount().
    pendingSubs = new Set(c.subcats || []);
    recount();
  }

  // ---- property-type list + live count ---------------------------------------
  let pendingSubs = null;
  let lastResult = null;

  function renderSubs(tree, keep) {
    $subs.textContent = '';
    if (!tree.length) {
      const p = document.createElement('p');
      p.className = 'sales-db-hint';
      p.textContent = 'No sales match — widen the dates, price or sale types.';
      $subs.appendChild(p);
      return;
    }
    for (const fam of tree) {
      const head = document.createElement('div');
      head.className = 'sales-prov-family';
      head.textContent = `${fam.family} (${fmt(fam.count)})`;
      $subs.appendChild(head);
      for (const o of fam.options) {
        const row = document.createElement('label');
        row.className = 'is-sub';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = o.value;
        cb.checked = keep.has(o.value);
        cb.addEventListener('change', recount);
        row.append(cb, document.createTextNode(`${o.label} (${fmt(o.count)})`));
        $subs.appendChild(row);
      }
    }
  }

  let seq = 0;
  async function recount() {
    const my = ++seq;
    const c = criteria();
    const ready = c.classes.length > 0;
    if (!ready) {
      $search.disabled = true;
      $count.textContent = '';
      $subs.innerHTML = '<p class="sales-db-hint">Choose a class to list its property types.</p>';
      lastResult = null;
      return;
    }
    let ix;
    try { ix = await ensureIndex(); } catch (err) {
      if (my === seq) { $count.textContent = err.message; $search.disabled = true; }
      return;
    }
    if (my !== seq) return;                 // a newer change is already counting
    // Ticks survive a recount: what is on screen, plus any a saved search
    // asked for before the list existed.
    const keep = new Set([...c.subcats, ...(pendingSubs || [])]);
    pendingSubs = null;
    const result = runSearch(ix.shards, { ...c, subcats: [...keep] }, ix.keys);
    renderSubs(result.tree, keep);
    lastResult = { criteria: { ...c, subcats: [...keep] }, result };
    $search.disabled = result.total === 0;
    $count.classList.toggle('is-warning', result.total > CONFIRM_ABOVE);
    $count.textContent = `${fmt(result.total)} sale${result.total === 1 ? '' : 's'} match across `
      + `${fmt(result.byMuni.size)} municipalit${result.byMuni.size === 1 ? 'y' : 'ies'}`
      + (result.total > CONFIRM_ABOVE ? ' — large; narrow the price, dates or types to speed the load' : '');
  }

  for (const el of [$class, $unknown]) el.addEventListener('change', recount);
  // The shared date, price and sale-type controls belong to the form; watch
  // them by id, as salesDbPanel does. Presets and typed dates both fire
  // 'input'; the sale-type picker dispatches a bubbling 'change' from its root.
  for (const id of ['sale-date-from', 'sale-date-to', 'sales-price-low', 'sales-price-high']) {
    $(id)?.addEventListener('input', recount);
  }
  $('sales-db-type')?.addEventListener('change', recount);

  // ---- search -----------------------------------------------------------------
  $search.addEventListener('click', async () => {
    await recount();
    if (!lastResult?.result.total) return;
    const { criteria: c, result } = lastResult;
    if (result.total > CONFIRM_ABOVE && !window.confirm(
      `${fmt(result.total)} sales match. Loading that many takes a while (every sale is `
      + 'looked up on the map). Continue?')) return;
    onSearchStart?.();
    try {
      let header = null;
      const bodies = [];
      for (const [muni, rows] of result.byMuni) {
        const rec = await getShard(muni);
        if (!rec?.csv) continue;
        const got = extractRows(rec.csv, rows);
        if (header === null) header = got.header;
        else if (got.header !== header) {
          throw new Error(`Sales shards have different columns (municipality ${muni} differs). `
            + 'Hit Reload so every shard is the same version.');
        }
        bodies.push(...got.rows);
      }
      if (!header || !bodies.length) { say('No sales found for that search.'); return; }
      const manifest = await getManifest();
      const desc = describeCriteria(c);
      const loaded = await onLoad?.({
        name: `MAO database — Province: ${desc}`,
        text: `${header}\n${bodies.join('\n')}\n`,
        municipalities: [...result.byMuni.keys()],
        generated_at: manifest?.generated_at || null,
        window: null,
        sales: bodies.length,
        salesAvailable: bodies.length,
        scope: 'province',
      });
      // A failed parcel lookup leads the line: left to the "Loaded" text alone,
      // every sale came back "(not mapped)" with nothing saying why.
      const warn = loaded?.warning ? `⚠ ${loaded.warning.replace(/^⚠ /, '')} · ` : '';
      say(`${warn}Loaded ${fmt(bodies.length)} sales province-wide (${desc}).`);
    } catch (err) {
      say(`Could not load sales: ${err.message}`);
    }
  });

  return { recount, getCriteria, setCriteria };
}
