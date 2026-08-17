// salesDbPanel.js — drives the "MAO sales database" panel on the Sales tab.
//
// Kept out of main.js deliberately: main.js is already ~520 KB and this is a
// self-contained feature whose only contract with the rest of the app is a
// single injected callback, onLoad({ name, text }). That is the exact shape
// handleSalesUpload() already accepts from the Recent-uploads picker, so the
// database is simply another way to hand the existing pipeline a CSV — parsing,
// roll lookup, enrichment and charting are untouched.
//
// Privacy: every byte stays on the user's device. See salesStore.js.

import {
  describeImport, getManifest, listShardKeys, buildCsvFor,
  pickSalesDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates,
  clearSales, requestPersistence, fsAccessSupported, salesDbAvailable,
} from './salesStore.js';
import {
  coverageRows, coverageSummary, statusLabel, nextFullScrape, refreshNote,
} from './salesCoverage.js';
import { dateLabel } from './dataStatus.js';

const fmt = (n) => Number(n || 0).toLocaleString();

/**
 * @param {Object} opts
 * @param {(payload:{name:string,text:string}) => (void|Promise<void>)} opts.onLoad
 *   Called with the merged CSV for the selected municipalities. Same shape
 *   handleSalesUpload() already accepts from the Recent-uploads picker.
 * @param {(msg:string) => void} [opts.setStatus] surface progress/errors in the
 *   app's own count line rather than inventing a second status channel.
 * @param {Function} [opts.getDateWindow] returns {from, to} ISO strings (either
 *   may be empty) limiting which sales are read out of the archive. Supplied by
 *   main.js from the sidebar's date range so the panel does not reach into the
 *   filter DOM itself. Absent (or empty) means load the full history.
 * @param {Function} [opts.onSelectionChange] called with (effective, picked)
 *   Sets of muni_no whenever the selection changes, so the map can shade the
 *   chosen municipalities. Fires for adjacency changes too, since those change
 *   what a load would cover.
 * @returns {{refresh: Function, toggleMuni: Function}} toggleMuni(no, on?) lets
 *   the map drive the same selection the checkboxes do.
 */
export function initSalesDbPanel({ onLoad, setStatus, getDateWindow, onSelectionChange } = {}) {
  const $root    = document.getElementById('sales-db');
  if (!$root) return { refresh: () => {} };

  const $status  = document.getElementById('sales-db-status');
  const $empty   = document.getElementById('sales-db-empty');
  const $ready   = document.getElementById('sales-db-ready');
  const $import  = document.getElementById('sales-db-import');
  const $folder  = document.getElementById('sales-db-folder-input');
  const $munis   = document.getElementById('sales-db-munis');
  const $load    = document.getElementById('sales-db-load');
  const $refresh = document.getElementById('sales-db-refresh');
  const $forget  = document.getElementById('sales-db-forget');
  const $update  = document.getElementById('sales-db-update');

  const say = (m) => { if (typeof setStatus === 'function') setStatus(m); };

  if (!salesDbAvailable()) {
    if ($status) $status.textContent = 'Unavailable in this browser';
    if ($empty) $empty.hidden = true;
    return { refresh: () => {} };
  }

  // The manual upload / paste / recent block. Once the MAO database is
  // imported those become the fallback path, so the block collapses to give
  // the sidebar back to the filters (Jason, 2026-08-11). Only ever set as a
  // DEFAULT: once the user opens it by hand we stop touching it, or a render()
  // triggered by an unrelated refresh would shut it while they were reaching
  // for the dropzone.
  const $manual   = document.getElementById('sales-manual');
  const $manualOr = document.getElementById('sales-manual-or');
  let manualTouched = false;
  $manual?.addEventListener('toggle', () => { manualTouched = true; });
  function setManualCollapsed(collapsed) {
    if (!$manual || manualTouched) return;
    $manual.open = !collapsed;
    if ($manualOr) $manualOr.hidden = collapsed;
  }

  // The database block itself folds to its title. Markup ships it CLOSED, so a
  // first visit shows a heading rather than a card for a one-time folder pick;
  // once an archive exists this is the main way in, so it opens on load. Same
  // "default, not a lockout" rule as the manual block: once the user works the
  // disclosure by hand we stop steering it.
  let dbTouched = false;
  $root.addEventListener('toggle', () => { dbTouched = true; });
  function setDbOpen(open) {
    if (dbTouched) return;
    $root.open = open;
  }

  // ---- rendering ----------------------------------------------------------
  async function render() {
    const info = await describeImport();
    if (!info.present) {
      $status.textContent = 'Not imported';
      $empty.hidden = false;
      $ready.hidden = true;
      setDbOpen(false);            // zero state: title only
      setManualCollapsed(false);   // no database yet: upload IS the main path
      return info;
    }
    const gen = info.generated_at ? String(info.generated_at).slice(0, 10) : null;
    $status.textContent =
      `${fmt(info.municipalities)} municipalities · ${fmt(info.sales)} sales` +
      (info.newest_sale ? ` · newest ${info.newest_sale}` : '') +
      (gen ? ` · exported ${gen}` : '');
    $empty.hidden = true;
    $ready.hidden = false;
    setDbOpen(true);               // an archive exists: this is the main path
    setManualCollapsed(true);
    await populateMunis();
    return info;
  }

  // South to north, the order an appraiser reading the province expects.
  // Anything the manifest reports that isn't listed here sorts to the end
  // under its own name rather than vanishing.
  const REGION_ORDER = ['Winnipeg', 'Southeast', 'South-Central / Central Plains',
                        'West & Parkland', 'Interlake', 'North'];
  const UNGROUPED = 'Other';

  // Two sets, not one. `picked` is what the user actually chose; the adjacent
  // option DERIVES a wider set from it rather than mutating it, so unticking
  // the option gives the original picks back instead of leaving the
  // neighbours stranded in the selection.
  const picked = new Set();        // muni_no strings, explicitly chosen
  // Adjacency-derived entries the user has explicitly waved off. Without
  // this, unticking a derived row did nothing visible — the neighbour rule
  // put it straight back on the next redraw, so the checkbox looked broken.
  // Wanting Steinbach and Hanover but not La Broquerie is a normal ask.
  const excluded = new Set();
  let muniIndex = [];              // [{ no, label, sales, region, adjacent[] }]
  let neighbours = new Map();      // muni_no -> [muni_no], shared boundaries only

  const $search   = document.getElementById('sales-db-muni-search');
  const $adjacent = document.getElementById('sales-db-adjacent');
  const $selcount = document.getElementById('sales-db-selcount');
  const $type     = document.getElementById('sales-db-type');

  /**
   * A manifest's `adjacent` field as a list of muni_no strings, whatever
   * shape it arrived in: an array, a bare scalar (jsonlite unboxes a
   * single-element list), an empty object (it renders a zero-length vector
   * as {}), or absent. One malformed entry used to abort the entire import.
   */
  function normalizeAdjacent(v) {
    if (Array.isArray(v)) return v.map(String);
    if (v == null) return [];
    if (typeof v === 'object') return Object.values(v).map(String);   // {} -> []
    return [String(v)];
  }

  /** Municipality rows from the manifest, name-first and region-tagged. */
  async function loadMuniIndex() {
    const manifest = await getManifest();
    const keys = (await listShardKeys()).map(String);
    const byNo = new Map((manifest?.munis || []).map((m) => [String(m.muni_no), m]));
    muniIndex = keys.map((no) => {
      const m = byNo.get(no) || {};
      return {
        no,
        // list_name is the province's own "ALTONA (TOWN)" form, so an
        // alphabetical sort groups by PLACE. Older exports predate it —
        // fall back to the "TOWN OF ALTONA" name, which still sorts, just
        // by prefix.
        label: m.list_name || m.municipality || `Muni ${no}`,
        sales: m.sales,
        region: m.region || UNGROUPED,
        // Normalise, don't trust. An export written before 2026-08-11
        // unboxed a single neighbour to a bare string ("175") and emitted
        // {} for a municipality with none, either of which threw here and
        // failed the whole import. A folder in that state must still load.
        adjacent: normalizeAdjacent(m.adjacent),
      };
    }).sort((a, b) => a.label.localeCompare(b.label));

    // Neighbours are published for the whole province, so drop the ones we
    // hold no shard for — offering to select a municipality that isn't in
    // the archive would just fail at load time.
    const have = new Set(muniIndex.map((m) => m.no));
    neighbours = new Map(muniIndex.map((m) => [m.no, m.adjacent.filter((n) => have.has(n))]));
  }

  /**
   * The municipalities a load would actually cover: the explicit picks, plus
   * everything sharing a boundary with them when the adjacent option is on.
   *
   * Adjacency is per MUNICIPALITY, not per region (Jason, 2026-08-11):
   * picking Steinbach should offer Hanover and La Broquerie — the two that
   * touch it — not the whole southeast. One hop only; neighbours-of-
   * neighbours would sprawl across the province in three or four clicks.
   */
  function effectiveSelection() {
    if (!$adjacent?.checked) return new Set(picked);
    const out = new Set(picked);
    for (const no of picked) {
      for (const nb of (neighbours.get(no) || [])) {
        if (!excluded.has(nb) && !picked.has(nb)) out.add(nb);
      }
    }
    return out;
  }

  // Above this many sales BEFORE the date/type filters, a load is worth a
  // word of warning. Each sale becomes a parcel-geometry lookup at 80 rolls
  // per request, so a whole region with no window is minutes of fetching,
  // not seconds. Not a block — an appraiser may genuinely want it.
  const BIG_LOAD_SALES = 25000;

  function updateSelCount() {
    if (!$selcount) return;
    const eff = effectiveSelection();
    const extra = eff.size - picked.size;
    const sales = muniIndex.reduce((s, m) => s + (eff.has(m.no) ? (m.sales || 0) : 0), 0);
    $selcount.textContent = eff.size
      ? `${picked.size} selected${extra ? ` + ${extra} adjacent` : ''} · ${fmt(sales)} sales before filtering`
      : 'None selected';
    // The warning names the two filters that actually shrink the load, since
    // "this is big" without a remedy is just nagging.
    const { from, to } = dateWindow();
    const wide = sales >= BIG_LOAD_SALES && !$type?.value && !(from || to);
    $selcount.classList.toggle('is-warning', wide);
    if (wide) {
      $selcount.textContent += ' — large load; set a date range or sale type to speed it up';
    }
    onSelectionChange?.(eff, picked);
    updateLoadEnabled();
    updateStaleness();
  }

  // What the table currently holds, so we can tell the user when the controls
  // have moved away from it. Set only by a successful load.
  let loadedState = null;

  const stateKey = () => {
    const { from, to } = dateWindow();
    return { munis: [...effectiveSelection()].sort().join(','), from, to, type: $type?.value || '' };
  };

  /**
   * Warn when the loaded data no longer matches the controls.
   *
   * Changing the municipalities, the sale type, or WIDENING the dates leaves
   * the table showing something other than what the panel now describes —
   * and nothing re-reads the archive until Load runs again. Narrowing the
   * dates is deliberately NOT stale: the sidebar filter still applies to
   * what is in memory, so a shorter window is honest without a reload.
   */
  function updateStaleness() {
    if (!$update) return;
    if (!loadedState) { $update.hidden = true; $update.classList.remove('is-stale'); return; }
    const now = stateKey();
    const widened = (loadedState.from && (!now.from || now.from < loadedState.from))
                 || (loadedState.to && (!now.to || now.to > loadedState.to));
    const stale = now.munis !== loadedState.munis || now.type !== loadedState.type || widened;
    $update.hidden = !stale;
    $update.classList.toggle('is-stale', stale);
    if (stale) {
      $update.textContent = now.munis !== loadedState.munis
        ? 'Selected municipalities changed — hit Load sales to refresh the data.'
        : 'Date range or sale type changed — hit Load sales to refresh the data.';
    }
  }

  // A date range is REQUIRED before loading. It is the load window, not a
  // display filter: without it the load reads every sale a municipality
  // holds back to 1987, parses them all and fetches parcel geometry for
  // each — the slow part the window exists to avoid. Discovering the date
  // control afterwards is too late, so the button stays disabled and says
  // why (Jason, 2026-08-11).
  function dateWindow() {
    const w = getDateWindow?.() || {};
    return { from: (w.from || '').trim(), to: (w.to || '').trim() };
  }
  function updateLoadEnabled() {
    if (!$load) return;
    const { from, to } = dateWindow();
    const hasWindow = Boolean(from || to);
    const hasMunis = effectiveSelection().size > 0;
    $load.disabled = !hasWindow || !hasMunis;
    $load.title = !hasMunis ? 'Pick at least one municipality'
      : !hasWindow ? 'Set a date range first — it decides how much of the archive is read'
      : 'Load the selected municipalities for the chosen date range';
  }
  // The date inputs live in the sidebar filters, so watch them rather than
  // polling; both the presets and hand-typed dates fire 'input'.
  for (const id of ['sale-date-from', 'sale-date-to']) {
    document.getElementById(id)?.addEventListener('input', updateLoadEnabled);
  }

  /** Rebuild the region groups. Cheap enough to redraw wholesale — 186 rows. */
  function renderMuniList() {
    if (!$munis) return;
    const q = ($search?.value || '').trim().toLowerCase();
    const match = (m) => !q || m.label.toLowerCase().includes(q);
    const eff = effectiveSelection();

    const byRegion = new Map();
    for (const m of muniIndex) {
      if (!match(m)) continue;
      if (!byRegion.has(m.region)) byRegion.set(m.region, []);
      byRegion.get(m.region).push(m);
    }
    const order = [...byRegion.keys()].sort((a, b) => {
      const ia = REGION_ORDER.indexOf(a), ib = REGION_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });

    $munis.textContent = '';
    for (const region of order) {
      const rows = byRegion.get(region);
      const wrap = document.createElement('details');
      wrap.className = 'sales-db-region';
      // A search narrows to what matched, so opening those groups saves the
      // user a second click; without a search everything starts collapsed.
      wrap.open = Boolean(q) || rows.some((m) => eff.has(m.no));

      const sum = document.createElement('summary');
      const box = document.createElement('input');
      box.type = 'checkbox';
      const n = rows.filter((m) => picked.has(m.no)).length;
      box.checked = n === rows.length && rows.length > 0;
      box.indeterminate = n > 0 && n < rows.length;
      box.addEventListener('click', (e) => e.stopPropagation());   // don't toggle the disclosure
      box.addEventListener('change', () => {
        for (const m of rows) {
          if (box.checked) { picked.add(m.no); excluded.delete(m.no); }
          else picked.delete(m.no);
        }
        renderMuniList();
        updateSelCount();
      });
      const name = document.createElement('span');
      name.className = 'sales-db-region-name';
      name.textContent = `${region} (${rows.length})`;
      sum.append(box, name);
      wrap.appendChild(sum);

      for (const m of rows) {
        const row = document.createElement('label');
        row.className = 'sales-db-muni';
        // Pulled in by the adjacent option rather than chosen: shown ticked
        // (it WILL load) but marked, so "I picked this" stays distinct from
        // "this came along for the ride".
        const viaAdjacency = !picked.has(m.no) && eff.has(m.no);
        if (viaAdjacency) row.classList.add('is-adjacent');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = m.no;
        cb.checked = eff.has(m.no);
        cb.addEventListener('change', () => {
          if (cb.checked) {
            picked.add(m.no);
            excluded.delete(m.no);        // re-ticking clears any waive-off
          } else if (viaAdjacency) {
            excluded.add(m.no);           // waive off a derived neighbour
          } else {
            picked.delete(m.no);
          }
          renderMuniList();     // refresh the parent's tri-state
          updateSelCount();
        });
        const txt = document.createElement('span');
        txt.textContent = m.sales ? `${m.label} (${fmt(m.sales)})` : m.label;
        if (viaAdjacency) txt.title = 'Included because it borders a selected municipality';
        row.append(cb, txt);
        wrap.appendChild(row);
      }
      $munis.appendChild(wrap);
    }
    if (!order.length) {
      const p = document.createElement('p');
      p.className = 'sales-db-hint';
      p.textContent = 'No municipality matches that filter.';
      $munis.appendChild(p);
    }
  }

  $search?.addEventListener('input', renderMuniList);
  $type?.addEventListener('change', () => { updateSelCount(); });
  // Purely derived, so toggling just redraws — the explicit picks are
  // untouched and unticking gives exactly them back. Turning the option OFF
  // also forgets any waived-off neighbours, so switching it back on starts
  // from the plain rule rather than from invisible leftovers.
  $adjacent?.addEventListener('change', () => {
    if (!$adjacent.checked) excluded.clear();
    renderMuniList();
    updateSelCount();
  });

  /** Select/deselect from outside the panel (the map's municipality layer). */
  function toggleMuni(no, on) {
    const key = String(no);
    if (!muniIndex.some((m) => m.no === key)) return false;   // not in the archive
    const want = on ?? !picked.has(key);
    if (want) picked.add(key); else picked.delete(key);
    renderMuniList();
    updateSelCount();
    return true;
  }

  async function populateMunis() {
    await loadMuniIndex();
    // Drop selections for municipalities that are no longer in the archive.
    const live = new Set(muniIndex.map((m) => m.no));
    for (const no of [...picked]) if (!live.has(no)) picked.delete(no);
    renderMuniList();
    updateSelCount();
  }

  // ---- import -------------------------------------------------------------
  async function runImport(dirHandle, { force = false } = {}) {
    const t0 = Date.now();
    const summary = await importFromDirectory(dirHandle, {
      force,
      onProgress: ({ done, total, label }) => {
        if (done < total) say(`Importing sales… ${done}/${total} — ${label}`);
      },
    });
    // Ask for durable storage only after a successful import: by then the user
    // has clearly engaged with the feature, which is when browsers grant it.
    const p = await requestPersistence();
    await render();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    say(`Sales database ready — ${fmt(summary.rows)} sales across ` +
        `${fmt(summary.municipalities)} municipalities in ${secs}s` +
        (summary.skipped ? ` (${summary.skipped} unchanged)` : '') +
        (p.supported && !p.persisted ? '. Browser may evict this under low disk.' : ''));
    return summary;
  }

  async function onChooseFolder() {
    try {
      if (fsAccessSupported()) {
        const handle = await pickSalesDirectory();     // needs the user gesture
        await runImport(handle);
      } else {
        $folder.click();                                // fallback picker
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;           // user cancelled
      say(`Import failed: ${err.message}`);
    }
  }

  $folder?.addEventListener('change', async () => {
    if (!$folder.files?.length) return;
    try {
      await importFromFileList($folder.files, {
        onProgress: ({ done, total, label }) => {
          if (done < total) say(`Importing sales… ${done}/${total} — ${label}`);
        },
      });
      await requestPersistence();
      await render();
      say('Sales database ready. This browser cannot auto-refresh — re-import after an update.');
    } catch (err) {
      say(`Import failed: ${err.message}`);
    } finally { $folder.value = ''; }
  });

  // ---- load into the existing pipeline ------------------------------------
  $load?.addEventListener('click', async () => {
    // Load what the checkboxes SHOW, i.e. picks plus any adjacency additions.
    const chosen = [...effectiveSelection()];
    if (!chosen.length) { say('Pick at least one municipality.'); return; }
    try {
      const manifest = await getManifest();
      // Load only the sales inside the sidebar's date range. Everything
      // skipped here is a row the app would otherwise parse AND fetch
      // parcel geometry for (80 rolls per ArcGIS request), so on a
      // 12-month window this is ~87% less work — the difference between a
      // region being practical to select and not. No range set means the
      // whole archive, exactly as before.
      const { from, to } = getDateWindow?.() || {};
      const payload = await buildCsvFor(chosen, { manifest, from, to, type: $type?.value || null });
      if (!payload) {
        say(from || to
          ? 'No sales in that date range for the selection. Widen the date range and load again.'
          : 'No sales found for that selection.');
        return;
      }
      await onLoad?.(payload);
      // Remember exactly what the table now holds, so a later change to the
      // municipalities, sale type or date range can flag the data as stale.
      loadedState = stateKey();
      updateStaleness();
      // Say what was actually loaded. A window that quietly returned a
      // slice would look identical to a municipality with few sales, and
      // widening the date range afterwards only re-filters what is
      // already in memory — more history needs another Load.
      if (payload.window) {
        const span = [payload.window.from || 'earliest', payload.window.to || 'today'].join(' → ');
        say(`Loaded ${fmt(payload.sales)} of ${fmt(payload.salesAvailable)} sales (${span}). `
          + 'Change the date range and load again for more history.');
      } else {
        say(`Loaded ${fmt(payload.sales)} sales (full history).`);
      }
    } catch (err) {
      say(`Could not load sales: ${err.message}`);
    }
  });

  // ---- scrape coverage ----------------------------------------------------
  // Per-municipality last-scraped dates from the export's coverage table.
  // Subscriber-derived, so it renders only here — never on the public Data
  // Status tab (SPEC-DATA-STATUS-TAB.md).
  const $covBtn     = document.getElementById('sales-db-coverage');
  const $covModal   = document.getElementById('sales-coverage-modal');
  const $covClose   = document.getElementById('sales-coverage-close');
  const $covSummary = document.getElementById('sales-coverage-summary');
  const $covSearch  = document.getElementById('sales-coverage-search');
  const $covRows    = document.getElementById('sales-coverage-rows');

  let covCache = null;   // last coverageRows() result while the dialog is open

  function renderCoverageTable() {
    if (!$covRows) return;
    $covRows.textContent = '';
    if (!covCache) return;
    const q = ($covSearch?.value || '').trim().toLowerCase();
    for (const r of covCache.rows) {
      if (q && !r.label.toLowerCase().includes(q)
            && !(r.region || '').toLowerCase().includes(q)) continue;
      const tr = document.createElement('tr');
      if (r.status === 'never') tr.classList.add('is-pending');
      const cells = [
        r.label,
        r.region || '',
        r.status === 'done' ? (dateLabel(r.lastScraped) || 'yes') : statusLabel(r),
        r.sales != null ? fmt(r.sales) : '',
        dateLabel(r.newestSale) || '',
        nextFullScrape(r) || '',
        refreshNote(r) || '',
      ];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      // A truncated slice means the deep history is still being backfilled —
      // worth a marker, not a column of mostly zeroes.
      if (r.cappedRows > 0) {
        tr.classList.add('is-capped');
        tr.title = `${fmt(r.cappedRows)} rows in slices still capped at MAO's search limit — backfill pending`;
      }
      $covRows.appendChild(tr);
    }
  }

  $covBtn?.addEventListener('click', async () => {
    covCache = coverageRows(await getManifest());
    if ($covSummary) {
      const sum = coverageSummary(covCache);
      $covSummary.textContent = !sum
        ? 'This export has no coverage information yet — hit Refresh after the next publish.'
        : sum.total != null
          ? `${fmt(sum.scraped)} of ${fmt(sum.total)} municipalities scraped for sales`
            + (sum.latest ? ` · most recent scrape ${dateLabel(sum.latest)}` : '')
          : `${fmt(sum.scraped)} municipalities in the archive`
            + (sum.latest ? ` · most recent scrape ${dateLabel(sum.latest)}` : '')
            + ' — re-export to also list not-yet-scraped municipalities';
    }
    if ($covSearch) $covSearch.value = '';
    renderCoverageTable();
    $covModal?.showModal();
  });
  $covClose?.addEventListener('click', () => $covModal?.close());
  $covSearch?.addEventListener('input', renderCoverageTable);

  // ---- refresh / forget ---------------------------------------------------
  $refresh?.addEventListener('click', async () => {
    try {
      const handle = await getSavedDirectory();
      if (!handle) { say('No folder remembered — choose the export folder again.'); await onChooseFolder(); return; }
      // Re-granting is one click and does NOT re-pick the folder.
      const perm = await directoryPermission(handle, { request: true });
      if (perm !== 'granted') { say('Folder access was not granted.'); return; }
      await runImport(handle, { force: true });
      if ($update) $update.hidden = true;
    } catch (err) { say(`Refresh failed: ${err.message}`); }
  });

  $forget?.addEventListener('click', async () => {
    await clearSales();
    await render();
    say('Sales database removed from this browser.');
  });

  $import?.addEventListener('click', onChooseFolder);

  // ---- auto-refresh notice ------------------------------------------------
  // On load, if we still hold a granted handle, quietly check whether the
  // export moved on. Deliberately NOT automatic: re-importing without asking
  // could swap the data mid-analysis. We offer, the user decides.
  async function checkQuietly() {
    try {
      const handle = await getSavedDirectory();
      if (!handle) return;
      const upd = await checkForUpdates(handle);      // null when not granted
      if (!upd || !upd.count) return;
      if ($update) {
        $update.hidden = false;
        $update.textContent =
          `${upd.count} municipalit${upd.count === 1 ? 'y has' : 'ies have'} newer data — click Refresh.`;
      }
    } catch { /* never block the tab on this */ }
  }

  render().then((info) => { if (info?.present) checkQuietly(); });

  return { refresh: render, toggleMuni };
}
