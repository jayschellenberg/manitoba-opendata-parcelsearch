// salesProvincePanel.js — drives the "Province-wide search" card on the Sales
// tab. The search itself (index, matching, row extraction) is pure and lives
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
  describeCriteria, listSaved, saveSearch, deleteSaved,
} from './provinceSearch.js';

const fmt = (n) => Number(n || 0).toLocaleString();

// The effective Sale Type Group values the export writes (condos already
// reclassified out of ICI) — the same list as the municipality picker's.
const SALE_TYPES = [
  ['RESIDENTIAL LAND AND BUILDINGS', 'Residential land & buildings'],
  ['RESIDENTIAL BARE LAND', 'Residential bare land'],
  ['RESIDENTIAL CONDOMINIUM UNITS', 'Residential condominium units'],
  ['RESIDENTIAL CONDOMINIUM BARE LAND', 'Residential condominium bare land'],
  ['ICI LAND AND BUILDINGS', 'ICI land & buildings'],
  ['ICI BARE LAND', 'ICI bare land'],
  ['FARM LAND AND BUILDINGS', 'Farm land & buildings'],
  ['FARM BARE LAND', 'Farm bare land'],
  ['UNCATEGORIZED', 'Uncategorized'],
];

// Beyond this a load is minutes of parcel-geometry fetching (80 rolls per
// request), so ask first. Not a block — the same rule as BIG_LOAD_SALES.
const CONFIRM_ABOVE = 5000;

function safeStorage() {
  try { return window.localStorage; } catch { return null; }
}

/**
 * @param {Object} opts
 * @param {(payload:Object) => (void|Promise<void>)} opts.onLoad
 * @param {() => void} [opts.onSearchStart]
 * @param {(msg:string) => void} [opts.setStatus]
 * @param {(w:{from:string,to:string,min:string,max:string}) => void} [opts.applyWindow]
 *   Mirrors the search's date and price window into the sidebar filters, so
 *   a narrower window left over from an earlier job cannot hide the results.
 */
export function initSalesProvincePanel({ onLoad, onSearchStart, setStatus, applyWindow } = {}) {
  const $root = document.getElementById('sales-prov');
  if (!$root) return {};
  const $ = (id) => document.getElementById(id);
  const $class = $('sales-prov-class');
  const $unknown = $('sales-prov-unknown');
  const $from = $('sales-prov-from');
  const $to = $('sales-prov-to');
  const $min = $('sales-prov-min');
  const $max = $('sales-prov-max');
  const $types = $('sales-prov-types');
  const $subs = $('sales-prov-subs');
  const $count = $('sales-prov-count');
  const $search = $('sales-prov-search');
  const $save = $('sales-prov-save');
  const $saved = $('sales-prov-saved');
  const $delete = $('sales-prov-delete');
  const $status = $('sales-prov-status');

  const say = (m) => { if (typeof setStatus === 'function') setStatus(m); };

  for (const [code, label] of CLASS_CODES) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = `${code} — ${label}`;
    $class.appendChild(o);
  }
  for (const [value, label] of SALE_TYPES) {
    const row = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = value;
    cb.addEventListener('change', recount);
    row.append(cb, document.createTextNode(label));
    $types.appendChild(row);
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
    return {
      classes,
      from: $from.value || '',
      to: $to.value || '',
      min: $min.value || '',
      max: $max.value || '',
      types: checked($types),
      subcats: checked($subs),
    };
  }

  function setCriteria(c) {
    $class.value = (c.classes || []).find((v) => v !== UNKNOWN_CLASS) || '';
    $unknown.checked = (c.classes || []).includes(UNKNOWN_CLASS);
    $from.value = c.from || '';
    $to.value = c.to || '';
    $min.value = c.min ?? '';
    $max.value = c.max ?? '';
    const types = new Set(c.types || []);
    for (const b of $types.querySelectorAll('input')) b.checked = types.has(b.value);
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
    $save.disabled = !ready;
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

  for (const el of [$class, $unknown, $from, $to]) el.addEventListener('change', recount);
  for (const el of [$min, $max]) el.addEventListener('input', recount);

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
      applyWindow?.({ from: c.from, to: c.to, min: c.min, max: c.max });
      const manifest = await getManifest();
      const desc = describeCriteria(c);
      await onLoad?.({
        name: `MAO database — Province: ${desc}`,
        text: `${header}\n${bodies.join('\n')}\n`,
        municipalities: [...result.byMuni.keys()],
        generated_at: manifest?.generated_at || null,
        window: null,
        sales: bodies.length,
        salesAvailable: bodies.length,
        scope: 'province',
      });
      if ($status) $status.textContent = desc;
      say(`Loaded ${fmt(bodies.length)} sales province-wide (${desc}).`);
    } catch (err) {
      say(`Could not load sales: ${err.message}`);
    }
  });

  // ---- saved searches ---------------------------------------------------------
  function renderSaved(select = '') {
    const list = listSaved(safeStorage());
    $saved.length = 1;                      // keep the placeholder option
    for (const s of list) {
      const o = document.createElement('option');
      o.value = s.name;
      o.textContent = s.name;
      o.title = describeCriteria(s.criteria);
      $saved.appendChild(o);
    }
    $saved.value = select && list.some((s) => s.name === select) ? select : '';
    $delete.disabled = !$saved.value;
  }

  $saved.addEventListener('change', () => {
    $delete.disabled = !$saved.value;
    const s = listSaved(safeStorage()).find((x) => x.name === $saved.value);
    if (s) setCriteria(s.criteria);
  });

  $save.addEventListener('click', () => {
    const c = criteria();
    const name = window.prompt('Name this search (saved in this browser only):',
      $saved.value || describeCriteria(c));
    if (!name) return;
    const list = saveSearch(safeStorage(), name, c);
    if (!list) { say('Could not save — this browser is blocking site storage.'); return; }
    renderSaved(name.trim());
    say(`Saved search "${name.trim()}".`);
  });

  $delete.addEventListener('click', () => {
    const name = $saved.value;
    if (!name || !window.confirm(`Delete the saved search "${name}"?`)) return;
    deleteSaved(safeStorage(), name);
    renderSaved();
  });

  renderSaved();
  return { recount };
}
