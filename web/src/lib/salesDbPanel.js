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
export function initSalesDbPanel({ onLoad, setStatus } = {}) {
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

  // ---- rendering ----------------------------------------------------------
  async function render() {
    const info = await describeImport();
    if (!info.present) {
      $status.textContent = 'Not imported';
      $empty.hidden = false;
      $ready.hidden = true;
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
    setManualCollapsed(true);
    await populateMunis();
    return info;
  }

  // Municipality list comes from the manifest when present (it carries proper
  // names); otherwise fall back to the shard keys so a folder without a
  // manifest still works, just with numbers instead of names.
  async function populateMunis() {
    const manifest = await getManifest();
    const keys = (await listShardKeys()).map(String);
    const nameByNo = new Map((manifest?.munis || []).map((m) => [String(m.muni_no), m.municipality]));
    const salesByNo = new Map((manifest?.munis || []).map((m) => [String(m.muni_no), m.sales]));

    const prev = new Set(Array.from($munis.selectedOptions).map((o) => o.value));
    $munis.textContent = '';
    keys
      .map((k) => ({ k, name: nameByNo.get(k) || `Muni ${k}`, sales: salesByNo.get(k) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(({ k, name, sales }) => {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = sales ? `${name} (${fmt(sales)})` : name;
        if (prev.has(k)) o.selected = true;
        $munis.appendChild(o);
      });
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
    const picked = Array.from($munis.selectedOptions).map((o) => o.value);
    if (!picked.length) { say('Pick at least one municipality.'); return; }
    try {
      const manifest = await getManifest();
      const payload = await buildCsvFor(picked, { manifest });
      if (!payload) { say('No sales found for that selection.'); return; }
      await onLoad?.(payload);
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
