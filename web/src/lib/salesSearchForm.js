// salesSearchForm.js — the Sales tab's one Search form (2026-11-23).
//
// The form has two "where" modes that share everything else:
//
//   Municipalities   the ticked municipalities        (salesDbPanel.js)
//   Whole province   by assessment class at the sale  (salesProvincePanel.js)
//
// Date range, sale price and sale type are the same controls in both, and
// each panel reads them through getters main.js injects. This file owns only
// what sits across the two: the mode switch and the saved searches, which
// store the whole form in either mode.
//
// The mode is a hidden checkbox (#sales-db-province) behind a segmented pill
// (lib/pillBinding.js), like the sidebar's other pills; the form mirrors it
// into data-mode, and style.css shows .mode-muni or .mode-prov to match.

import { getManifest } from './salesStore.js';
import {
  describeCriteria, listSaved, saveSearch, deleteSaved, savedMode, defaultDateWindow,
} from './provinceSearch.js';

function safeStorage() {
  try { return window.localStorage; } catch { return null; }
}

/**
 * @param {Object} opts
 * @param {{getSelection: Function, setSelection: Function}} opts.dbPanel
 * @param {{recount: Function, getCriteria: Function, setCriteria: Function}} opts.provPanel
 * @param {{getSelected: Function, setSelected: Function}} opts.typeFilter the
 *   sale-type multi-select (lib/multiSelect.js)
 * @param {() => {from:string,to:string,min:string,max:string}} opts.getWindow
 *   the form's date range and Sale Price pair
 * @param {(w:{from:string,to:string,min:string,max:string}) => void} opts.applyWindow
 *   sets them, firing the same events typing would
 * @param {() => boolean} [opts.hasLoadedSales] true while the table holds sales
 * @param {(msg:string) => void} [opts.setStatus]
 * @returns {{getMode: Function, setMode: Function}}
 */
export function initSalesSearchForm({
  dbPanel, provPanel, typeFilter, getWindow, applyWindow, hasLoadedSales, setStatus,
} = {}) {
  const $form = document.getElementById('sales-search');
  const $province = document.getElementById('sales-db-province');
  if (!$form || !$province) return {};
  const $type = document.getElementById('sales-db-type');
  const $saved = document.getElementById('sales-prov-saved');
  const $delete = document.getElementById('sales-prov-delete');
  const $save = document.getElementById('sales-prov-save');

  const say = (m) => { if (typeof setStatus === 'function') setStatus(m); };
  const getMode = () => ($province.checked ? 'province' : 'muni');

  // ---- mode -------------------------------------------------------------------
  /**
   * A province search with no dates reads every year of the archive, so the
   * first switch into it offers Jan 1 five years back through the newest sale
   * (Jason, 2026-09-24). Only into an EMPTY range, and only while nothing is
   * loaded: the date range also filters the table, so filling it over a
   * loaded set would hide rows the user never asked to lose.
   */
  async function offerDefaultDates() {
    const w = getWindow?.() || {};
    if (w.from || w.to || hasLoadedSales?.()) return;
    let manifest = null;
    try { manifest = await getManifest(); } catch { return; }   // no archive yet
    if (getMode() !== 'province') return;                        // switched back meanwhile
    const now = getWindow?.() || {};
    if (now.from || now.to) return;
    const d = defaultDateWindow(new Date(), manifest?.newest_sale);
    applyWindow?.({ from: d.from, to: d.to, min: now.min || '', max: now.max || '' });
  }

  function syncMode() {
    const mode = getMode();
    $form.dataset.mode = mode;
    if (mode === 'province') {
      offerDefaultDates();
      provPanel?.recount?.();
    }
  }

  function setMode(mode) {
    const want = mode === 'province';
    if ($province.checked === want) return;
    $province.checked = want;
    // The pill repaints from the box's change event; syncMode rides it too.
    $province.dispatchEvent(new Event('change', { bubbles: true }));
  }

  $province.addEventListener('change', syncMode);
  syncMode();

  // ---- saved searches -----------------------------------------------------------
  /** The whole form as it stands: what both modes share, plus this mode's "where". */
  function criteria() {
    const mode = getMode();
    const w = getWindow?.() || {};
    const shared = {
      mode,
      from: w.from || '',
      to: w.to || '',
      min: w.min || '',
      max: w.max || '',
      types: typeFilter?.getSelected?.() || [],
    };
    return mode === 'province'
      ? { ...shared, ...(provPanel?.getCriteria?.() || {}) }
      : { ...shared, ...(dbPanel?.getSelection?.() || {}) };
  }

  function apply(c) {
    const mode = savedMode(c);
    setMode(mode);
    applyWindow?.({ from: c.from || '', to: c.to || '', min: c.min ?? '', max: c.max ?? '' });
    typeFilter?.setSelected?.(c.types || []);
    // setSelected is silent; both panels listen for the picker's change.
    $type?.dispatchEvent(new Event('change', { bubbles: true }));
    if (mode === 'province') provPanel?.setCriteria?.(c);
    else dbPanel?.setSelection?.(c);
  }

  function renderSaved(select = '') {
    if (!$saved) return;
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
    if ($delete) $delete.disabled = !$saved.value;
  }

  $saved?.addEventListener('change', () => {
    if ($delete) $delete.disabled = !$saved.value;
    const s = listSaved(safeStorage()).find((x) => x.name === $saved.value);
    if (s) apply(s.criteria);
  });

  $save?.addEventListener('click', () => {
    const c = criteria();
    // Nothing to come back to: a search with no "where" cannot be run.
    if (c.mode === 'province' ? !(c.classes || []).length : !(c.munis || []).length) {
      say(c.mode === 'province' ? 'Choose a class before saving the search.'
        : 'Tick at least one municipality before saving the search.');
      return;
    }
    const name = window.prompt('Name this search (saved in this browser only):',
      $saved?.value || describeCriteria(c));
    if (!name) return;
    const list = saveSearch(safeStorage(), name, c);
    if (!list) { say('Could not save — this browser is blocking site storage.'); return; }
    renderSaved(name.trim());
    say(`Saved search "${name.trim()}".`);
  });

  $delete?.addEventListener('click', () => {
    const name = $saved?.value;
    if (!name || !window.confirm(`Delete the saved search "${name}"?`)) return;
    deleteSaved(safeStorage(), name);
    renderSaved();
  });

  renderSaved();
  return { getMode, setMode };
}
