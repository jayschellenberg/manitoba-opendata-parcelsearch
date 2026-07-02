/*
 * Driver for the "Import parcel list" modal.
 *
 * Two-screen flow inside a single <dialog>:
 *   Screen 1: textarea + file picker. Parse → next.
 *   Screen 2: column-mapping preview. Confirm → resolve → emit
 *             parcelKeys (and the unresolved rows) to the caller.
 *
 * A confidently-recognized sales export (header row + Municipality-name
 * + Roll #) skips Screen 2 and resolves straight from Screen 1 — the
 * one-paste flow (see isRecognizedSalesExport).
 *
 * The resolver itself runs in lib/parcelListResolver.js; this file
 * only handles the user-facing flow. main.js wires onResolved into
 * the listParcelKeys state + the resolved-list pill.
 *
 * LocalStorage memory: when the same header signature is seen again
 * within the same browser, the previously-confirmed mapping is
 * applied automatically (overriding heuristics). The key is the
 * header row text joined with a separator the user can't type into
 * a cell, so two pastes with different shapes don't collide.
 */

import {
  parseParcelList,
  applyMapping,
  validateMapping,
  FIELD_TYPES,
} from './parcelListParser.js';
import { resolveParcelList } from '../parcelListResolver.js';

const STORAGE_KEY = 'mbps_parcel_list_mapping_v1';
const RECENT_STORAGE_KEY = 'mbps_parcel_list_recent_v1';
const RECENT_CAP = 5;
const MAX_PREVIEW_ROWS = 5;

const FIELD_LABELS = {
  roll: 'Roll #',
  muni: 'Muni #',
  muniName: 'Municipality (name)',
  legal: 'Legal Desc',
  title: 'Title #',
  ignore: 'Ignore',
};

/**
 * Wire up the modal. Returns { open, close } for callers that want
 * to open the modal programmatically (e.g. the "Import list…" link
 * in the sidebar).
 *
 * @param {Object} opts
 * @param {() => Promise<void>} [opts.warmIndex] - optional pre-warm
 *   call so the legal index loads while the user is still pasting.
 * @param {Function} opts.canonicalRoll - roll-canonicalization helper
 *   from arcgis.js (kept as an injection so this module doesn't pull
 *   that dependency).
 * @param {(payload: { parcelKeys, resolved, unresolved, stats }) => void}
 *   opts.onResolved - called when the user clicks Resolve and the
 *   resolver returns. The modal closes itself before invoking this.
 * @param {(rows: Array<{lineNo, muniName, roll}>) => Promise<{
 *     resolvedByLine: Map, unresolvedByLine: Map }>} [opts.resolveMuniNames]
 *   - optional Roll Entry name→muni_no reconciler (used for the
 *   sales-export "Municipality (name)" column). Injected so the parser/
 *   resolver stay free of arcgis.js.
 */
export function initParcelListImport({
  warmIndex,
  canonicalRoll,
  onResolved,
  resolveMuniNames,
} = {}) {
  const $modal     = document.getElementById('parcel-list-import-modal');
  if (!$modal) return { open: () => {}, close: () => {} };

  const $textarea = document.getElementById('parcel-list-import-text');
  const $file     = document.getElementById('parcel-list-import-file');
  const $cancel   = document.getElementById('parcel-list-import-cancel');
  const $next     = document.getElementById('parcel-list-import-next');
  const $back     = document.getElementById('parcel-list-import-back');
  const $resolve  = document.getElementById('parcel-list-import-resolve');
  const $closeBtn = document.getElementById('parcel-list-import-close');
  const $stepPaste = $modal.querySelector('[data-step="paste"]');
  const $stepMap   = $modal.querySelector('[data-step="map"]');
  const $stepRun   = $modal.querySelector('[data-step="resolving"]');
  const $mapTable  = document.getElementById('parcel-list-mapping-table-wrap');
  const $mapWarn   = document.getElementById('parcel-list-mapping-warning');
  const $resolveErr = document.getElementById('parcel-list-resolve-error');
  const $recentRow    = document.getElementById('parcel-list-import-recent-row');
  const $recentSelect = document.getElementById('parcel-list-import-recent-select');
  const $recentClear  = document.getElementById('parcel-list-import-recent-clear');

  // Per-session state — re-initialized on every open() so a previous
  // run doesn't leak across modal sessions. `sourceName` tracks how
  // the current text was obtained (file name or a synthetic paste
  // label) so it can be passed to rememberImport() on success.
  let parsed = null;
  let mapping = [];
  let sourceName = '';

  // ---- open / close --------------------------------------------

  function open() {
    parsed = null;
    mapping = [];
    sourceName = '';
    setStep('paste');
    if ($textarea) $textarea.value = '';
    if ($file) $file.value = '';
    if ($resolveErr) $resolveErr.hidden = true;
    populateRecentDropdown();
    try { $modal.showModal(); } catch { $modal.setAttribute('open', ''); }
    // Pre-warm the legal index in the background while the user
    // pastes. By the time they hit Next the bulk lookup should be
    // a no-op on the load step.
    if (typeof warmIndex === 'function') {
      try { warmIndex(); } catch (err) { console.warn('warmIndex failed', err); }
    }
    // Focus the textarea so paste-and-go works without a mouse hop.
    requestAnimationFrame(() => $textarea?.focus());
  }

  function close() {
    try { $modal.close(); } catch { $modal.removeAttribute('open'); }
  }

  // ---- step navigation -----------------------------------------

  function setStep(step) {
    if ($stepPaste) $stepPaste.hidden = step !== 'paste';
    if ($stepMap)   $stepMap.hidden   = step !== 'map';
    if ($stepRun)   $stepRun.hidden   = step !== 'resolving';
    $modal.dataset.step = step;
  }

  // ---- step 1 → step 2 (parse paste, render mapping) -----------

  async function goToMapping() {
    const text = ($textarea?.value || '').trim();
    if (!text) {
      flashWarn($next, 'Paste a list or choose a file first.');
      return;
    }
    parsed = parseParcelList(text);
    if (parsed.columns.length === 0) {
      flashWarn($next, "Couldn't read any rows from that input.");
      return;
    }
    // Apply remembered mapping if the header signature matches a
    // prior run; otherwise use the heuristic guesses.
    const remembered = recallMapping(parsed.headers);
    mapping = (remembered && remembered.length === parsed.columns.length)
      ? remembered
      : parsed.guesses.slice();
    // Render the mapping table up front either way — it doubles as the
    // fallback screen if an auto-skipped resolve fails, so it must be
    // populated before we might jump past it.
    renderMappingTable();
    // Direct path: a confidently-recognized sales export (header row +
    // Municipality-name + Roll #, an unambiguous valid mapping) skips the
    // column-confirmation screen and resolves straight away — the
    // one-paste flow. Any less-certain shape still stops here so the user
    // can confirm or override the auto-detected columns.
    if (isRecognizedSalesExport(parsed, mapping)) {
      await goToResolve();
      return;
    }
    setStep('map');
  }

  function renderMappingTable() {
    if (!$mapTable) return;
    const headers = parsed.headers || parsed.columns.map((_, i) => `Col ${i + 1}`);
    const sampleCount = Math.min(MAX_PREVIEW_ROWS, parsed.columns[0]?.length || 0);

    let html = '<table class="parcel-list-mapping-table"><thead><tr>';
    for (let c = 0; c < parsed.columns.length; c++) {
      const hdr = escapeHtml(headers[c] || '');
      const opts = FIELD_TYPES.map((t) =>
        `<option value="${t}"${mapping[c] === t ? ' selected' : ''}>${FIELD_LABELS[t]}</option>`
      ).join('');
      html += `<th>
        <div class="mapping-col-header">${hdr}</div>
        <select class="mapping-col-select" data-col="${c}">${opts}</select>
      </th>`;
    }
    html += '</tr></thead><tbody>';
    for (let r = 0; r < sampleCount; r++) {
      html += '<tr>';
      for (let c = 0; c < parsed.columns.length; c++) {
        html += `<td>${escapeHtml(parsed.columns[c][r] || '')}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    $mapTable.innerHTML = html;

    // Wire the per-column dropdowns. Plain change events update the
    // mapping array and re-run validation.
    $mapTable.querySelectorAll('select.mapping-col-select').forEach((sel) => {
      sel.addEventListener('change', () => {
        const c = Number(sel.dataset.col);
        mapping[c] = sel.value;
        validate();
      });
    });

    // Footnote: total row count + delimiter.
    const total = parsed.columns[0]?.length || 0;
    const tail = `<p class="parcel-list-mapping-meta">${total} row${total === 1 ? '' : 's'} detected${parsed.headers ? ' (header row skipped)' : ''}.</p>`;
    $mapTable.insertAdjacentHTML('beforeend', tail);

    validate();
  }

  function validate() {
    if (!$mapWarn || !$resolve) return;
    const msg = validateMapping(mapping);
    // Also flag duplicate field types — applyMapping will surface
    // them anyway, but the modal can warn before resolve too.
    const types = mapping.filter((t) => t && t !== 'ignore');
    const counts = {};
    for (const t of types) counts[t] = (counts[t] || 0) + 1;
    const dups = Object.entries(counts).filter(([, n]) => n > 1).map(([t]) => FIELD_LABELS[t]);

    if (msg) {
      $mapWarn.textContent = msg;
      $mapWarn.hidden = false;
      $resolve.disabled = true;
      return;
    }
    if (dups.length > 0) {
      $mapWarn.textContent = `Each field can only be mapped to one column (duplicate: ${dups.join(', ')}).`;
      $mapWarn.hidden = false;
      $resolve.disabled = true;
      return;
    }
    if (!types.includes('roll')) {
      // Soft warning — applyMapping will work but every row will be
      // unresolvable. Block resolve to keep the user out of a dead end.
      $mapWarn.textContent = 'Map a Roll # column. The resolver intersects each row by its roll #.';
      $mapWarn.hidden = false;
      $resolve.disabled = true;
      return;
    }
    $mapWarn.hidden = true;
    $resolve.disabled = false;
  }

  // ---- step 2 → resolve -----------------------------------------

  async function goToResolve() {
    setStep('resolving');
    if ($resolveErr) $resolveErr.hidden = true;
    const mapped = applyMapping(parsed, mapping, { canonicalRoll });
    if (mapped.issues.length > 0) {
      // Should be caught by the validator above; this is the fail-safe.
      console.warn('Mapping issues:', mapped.issues);
    }
    let out;
    try {
      out = await resolveParcelList(mapped.rows, { resolveMuniNames });
    } catch (err) {
      console.error('Resolver failed:', err);
      if ($resolveErr) {
        $resolveErr.textContent = `Resolve failed: ${err.message || err}. Try again or check the legal index.`;
        $resolveErr.hidden = false;
      }
      setStep('map');
      return;
    }
    // Persist the confirmed mapping for next time, and cache the
    // original text under a friendly name so it shows up in the
    // Recent imports dropdown on next open.
    rememberMapping(parsed.headers, mapping);
    rememberImport(sourceName || synthesizePasteName($textarea?.value), $textarea?.value);
    close();
    if (typeof onResolved === 'function') onResolved(out);
  }

  // ---- file input ----------------------------------------------

  async function handleFile(file) {
    if (!file || !$textarea) return;
    try {
      const text = await file.text();
      $textarea.value = text;
      sourceName = file.name || '';
      $textarea.focus();
    } catch (err) {
      console.warn('File read failed:', err);
    }
  }

  // ---- localStorage memory ---------------------------------------

  function mappingSignature(headers) {
    if (!Array.isArray(headers)) return null;
    return headers.map((h) => String(h || '').trim().toLowerCase()).join('|');
  }

  function recallMapping(headers) {
    const sig = mappingSignature(headers);
    if (!sig) return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const all = JSON.parse(raw);
      const hit = all?.[sig];
      if (!Array.isArray(hit)) return null;
      // Validate each entry is a known field type.
      for (const t of hit) if (!FIELD_TYPES.includes(t)) return null;
      return hit;
    } catch { return null; }
  }

  function rememberMapping(headers, mapping) {
    const sig = mappingSignature(headers);
    if (!sig) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const all = raw ? JSON.parse(raw) : {};
      all[sig] = mapping.slice();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch { /* quota or disabled storage — silently skip */ }
  }

  // ---- Recent-imports storage + populator ----------------------

  function loadRecentImports() {
    try {
      const raw = localStorage.getItem(RECENT_STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(0, RECENT_CAP) : [];
    } catch { return []; }
  }

  function saveRecentImports(list) {
    try {
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list.slice(0, RECENT_CAP)));
    } catch { /* quota errors — best-effort */ }
  }

  function rememberImport(name, text) {
    if (!name || !text) return;
    // De-dup by name, keep newest at the front. Re-importing the same
    // file refreshes its cached text (handy when the spreadsheet was
    // edited between sessions).
    const list = loadRecentImports().filter((e) => e.name !== name);
    list.unshift({ name, text, ts: Date.now() });
    saveRecentImports(list);
  }

  function populateRecentDropdown() {
    if (!$recentSelect || !$recentRow) return;
    const list = loadRecentImports();
    $recentSelect.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = list.length ? 'Pick a recent import…' : '—';
    $recentSelect.appendChild(blank);
    for (const e of list) {
      const opt = document.createElement('option');
      opt.value = e.name;
      const dt = new Date(e.ts || 0);
      const ts = Number.isFinite(dt.valueOf()) ? dt.toISOString().slice(0, 10) : '';
      opt.textContent = ts ? `${e.name} (${ts})` : e.name;
      $recentSelect.appendChild(opt);
    }
    $recentRow.hidden = list.length === 0;
  }

  /** Build a friendly label for a pasted (no-file) import — uses the
   *  first non-empty line's leading chars so users can tell pastes
   *  apart in the recent dropdown. */
  function synthesizePasteName(text) {
    if (!text) return '';
    const firstLine = String(text).split(/\r\n|\r|\n/).find((l) => l.trim()) || '';
    const snippet = firstLine.replace(/\s+/g, ' ').trim().slice(0, 30);
    const dt = new Date();
    const stamp = `${dt.toISOString().slice(5, 10)} ${dt.toTimeString().slice(0, 5)}`;
    return snippet ? `Paste: ${snippet}… (${stamp})` : `Paste (${stamp})`;
  }

  // ---- wire events ---------------------------------------------

  $next?.addEventListener('click', goToMapping);
  $cancel?.addEventListener('click', close);
  $closeBtn?.addEventListener('click', close);
  $back?.addEventListener('click', () => setStep('paste'));
  $resolve?.addEventListener('click', goToResolve);
  $file?.addEventListener('change', () => {
    const f = $file.files?.[0];
    if (f) handleFile(f);
  });
  $recentSelect?.addEventListener('change', () => {
    const name = $recentSelect.value;
    if (!name) return;
    const entry = loadRecentImports().find((e) => e.name === name);
    if (!entry || !$textarea) return;
    $textarea.value = entry.text;
    sourceName = entry.name;
    // Auto-advance straight to the mapping step — the user explicitly
    // picked a known-good import, so they don't need to re-confirm
    // the paste step.
    $recentSelect.value = '';
    goToMapping();
  });
  $recentClear?.addEventListener('click', () => {
    saveRecentImports([]);
    populateRecentDropdown();
  });
  // <dialog> emits 'cancel' on Esc — let it close cleanly.
  $modal.addEventListener('cancel', (e) => { e.preventDefault(); close(); });

  return { open, close };
}

// ---- small helpers -------------------------------------------

/**
 * True when a parsed import is a confidently-recognized sales export —
 * a header row plus an unambiguous auto-mapping that carries exactly one
 * Municipality (name) column and one Roll # column, with no field mapped
 * twice and an otherwise-valid mapping. These skip the column-
 * confirmation screen and resolve immediately (the one-paste flow); any
 * less-certain shape still stops at the mapping step for confirmation.
 */
function isRecognizedSalesExport(parsed, mapping) {
  if (!parsed?.headers || !Array.isArray(mapping)) return false;
  const counts = {};
  for (const t of mapping) if (t && t !== 'ignore') counts[t] = (counts[t] || 0) + 1;
  if (counts.muniName !== 1 || counts.roll !== 1) return false;   // muni-name + roll signature
  if (Object.values(counts).some((n) => n > 1)) return false;     // no field mapped twice
  return validateMapping(mapping) == null;                        // overall mapping valid
}

function flashWarn(btn, msg) {
  if (!btn) return;
  const old = btn.title || '';
  btn.title = msg;
  btn.classList.add('warn-flash');
  setTimeout(() => {
    btn.classList.remove('warn-flash');
    btn.title = old;
  }, 1500);
  console.warn(msg);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
