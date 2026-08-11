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

const fmt = (n) => Number(n || 0).toLocaleString();

/**
 * @param {Object} opts
 * @param {(payload:{name:string,text:string}) => (void|Promise<void>)} opts.onLoad
 *   Called with the merged CSV for the selected municipalities.
 * @param {(msg:string) => void} [opts.setStatus] surface progress/errors in the
 *   app's own count line rather than inventing a second status channel.
 */
/**
 * @param {object}   opts
 * @param {Function} opts.onLoad        receives the built CSV payload
 * @param {Function} opts.setStatus     status line writer
 * @param {Function} [opts.getDateWindow] returns {from, to} ISO strings (either
 *   may be empty) limiting which sales are read out of the archive. Supplied by
 *   main.js from the sidebar's date range so the panel does not reach into the
 *   filter DOM itself. Absent (or empty) means load the full history.
 */
export function initSalesDbPanel({ onLoad, setStatus, getDateWindow } = {}) {
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

  // Which regions border which. Derived spatially (dissolve the census
  // divisions into regions, ask which polygons touch) rather than typed out
  // by hand — a hand-written adjacency table is exactly the kind that goes
  // quietly wrong at one border and nobody notices.
  const REGION_ADJACENCY = {
    'Winnipeg':                       ['Interlake', 'South-Central / Central Plains', 'Southeast'],
    'Southeast':                      ['Interlake', 'North', 'South-Central / Central Plains', 'Winnipeg'],
    'South-Central / Central Plains': ['Interlake', 'Southeast', 'West & Parkland', 'Winnipeg'],
    'West & Parkland':                ['Interlake', 'North', 'South-Central / Central Plains'],
    'Interlake':                      ['North', 'South-Central / Central Plains', 'Southeast',
                                       'West & Parkland', 'Winnipeg'],
    'North':                          ['Interlake', 'Southeast', 'West & Parkland'],
  };
  // South to north, the order an appraiser reading the province expects.
  // Anything the manifest reports that isn't listed here sorts to the end
  // under its own name rather than vanishing.
  const REGION_ORDER = ['Winnipeg', 'Southeast', 'South-Central / Central Plains',
                        'West & Parkland', 'Interlake', 'North'];
  const UNGROUPED = 'Other';

  const selected = new Set();      // muni_no strings
  let muniIndex = [];              // [{ no, label, sales, region }]

  const $search   = document.getElementById('sales-db-muni-search');
  const $adjacent = document.getElementById('sales-db-adjacent');
  const $selcount = document.getElementById('sales-db-selcount');

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
      };
    }).sort((a, b) => a.label.localeCompare(b.label));
  }

  const regionsOf = (region) => (
    $adjacent?.checked ? [region, ...(REGION_ADJACENCY[region] || [])] : [region]);

  function setRegionSelected(region, on) {
    const wanted = new Set(regionsOf(region));
    for (const m of muniIndex) {
      if (!wanted.has(m.region)) continue;
      if (on) selected.add(m.no); else selected.delete(m.no);
    }
  }

  function updateSelCount() {
    if (!$selcount) return;
    const n = selected.size;
    const sales = muniIndex.reduce((s, m) => s + (selected.has(m.no) ? (m.sales || 0) : 0), 0);
    $selcount.textContent = n
      ? `${n} selected · ${fmt(sales)} sales before date filtering`
      : 'None selected';
  }

  /** Rebuild the region groups. Cheap enough to redraw wholesale — 186 rows. */
  function renderMuniList() {
    if (!$munis) return;
    const q = ($search?.value || '').trim().toLowerCase();
    const match = (m) => !q || m.label.toLowerCase().includes(q);

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
      wrap.open = Boolean(q) || rows.some((m) => selected.has(m.no));

      const sum = document.createElement('summary');
      const box = document.createElement('input');
      box.type = 'checkbox';
      const picked = rows.filter((m) => selected.has(m.no)).length;
      box.checked = picked === rows.length && rows.length > 0;
      box.indeterminate = picked > 0 && picked < rows.length;
      box.addEventListener('click', (e) => e.stopPropagation());   // don't toggle the disclosure
      box.addEventListener('change', () => {
        setRegionSelected(region, box.checked);
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
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = m.no;
        cb.checked = selected.has(m.no);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(m.no); else selected.delete(m.no);
          renderMuniList();     // refresh the parent's tri-state
          updateSelCount();
        });
        const txt = document.createElement('span');
        txt.textContent = m.sales ? `${m.label} (${fmt(m.sales)})` : m.label;
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
  // Toggling adjacency re-applies whole-region picks: a region whose every
  // municipality is selected re-selects with its neighbours, so the checkbox
  // means the same thing before and after the toggle.
  $adjacent?.addEventListener('change', () => {
    for (const region of new Set(muniIndex.map((m) => m.region))) {
      const rows = muniIndex.filter((m) => m.region === region);
      if (rows.length && rows.every((m) => selected.has(m.no))) setRegionSelected(region, true);
    }
    renderMuniList();
    updateSelCount();
  });

  async function populateMunis() {
    await loadMuniIndex();
    // Drop selections for municipalities that are no longer in the archive.
    const live = new Set(muniIndex.map((m) => m.no));
    for (const no of [...selected]) if (!live.has(no)) selected.delete(no);
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
    const picked = [...selected];
    if (!picked.length) { say('Pick at least one municipality.'); return; }
    try {
      const manifest = await getManifest();
      // Load only the sales inside the sidebar's date range. Everything
      // skipped here is a row the app would otherwise parse AND fetch
      // parcel geometry for (80 rolls per ArcGIS request), so on a
      // 12-month window this is ~87% less work — the difference between a
      // region being practical to select and not. No range set means the
      // whole archive, exactly as before.
      const { from, to } = getDateWindow?.() || {};
      const payload = await buildCsvFor(picked, { manifest, from, to });
      if (!payload) {
        say(from || to
          ? 'No sales in that date range for the selection. Widen the date range and load again.'
          : 'No sales found for that selection.');
        return;
      }
      await onLoad?.(payload);
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

  return { refresh: render };
}
