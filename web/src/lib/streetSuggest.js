/*
 * Street typeahead — the DOM half. Ported from Winnipeg ParcelSearch's
 * lib/streetSuggest.js (keyboard model, Enter = take the highlighted
 * street AND search, list anchored to the whole row); the ranking and the
 * list itself live in lib/streetIndex.js.
 *
 * The one difference from Winnipeg: the list depends on the municipality.
 * Jason (2026-10-22): suggest only the chosen municipality's streets, so
 * `getList` is asked afresh on every refresh and answers null when no
 * municipality is chosen — the list then says so instead of guessing.
 */
import {
  suggestStreets,
  suggestHint,
  suggestKey,
  STREET_SUGGEST_MIN_QUERY,
} from './streetIndex.js';

/**
 * @param {Object} opts
 * @param {string} opts.inputId  the text input
 * @param {string} opts.listId   an empty, hidden listbox element, a sibling
 *   of the input's field inside a position:relative row
 * @param {() => Promise<Object[]|null>} opts.getList  the chosen
 *   municipality's street list, or null when none is chosen. Rejection is
 *   swallowed: a typeahead that cannot load must not stop anyone typing a
 *   street and searching.
 * @param {string} [opts.noMuniText]  what to say when getList gives null
 * @param {() => void} [opts.onSearch]  run the search; Enter calls it after
 *   accepting, so the search never reads a half-typed street.
 * @returns {{ close: () => void, isOpen: () => boolean }}
 */
export function createStreetSuggest({ inputId, listId, getList, noMuniText, onSearch }) {
  const $input = document.getElementById(inputId);
  const $list = document.getElementById(listId);
  const noop = { close: () => {}, isOpen: () => false };
  if (!$input || !$list) return noop;
  const $row = $list.parentElement;

  $input.setAttribute('autocomplete', 'off');
  $input.setAttribute('role', 'combobox');
  $input.setAttribute('aria-autocomplete', 'list');
  $input.setAttribute('aria-expanded', 'false');
  $input.setAttribute('aria-controls', listId);

  let matches = [];
  let active = -1;
  let ticket = 0;
  // Set while accept() writes the field, so the synthetic 'input' event
  // that tells main.js to refresh the URL does not reopen the list.
  let accepting = false;

  function close() {
    $list.hidden = true;
    $list.innerHTML = '';
    matches = [];
    active = -1;
    $input.setAttribute('aria-expanded', 'false');
    $input.removeAttribute('aria-activedescendant');
    $row?.classList.remove('street-suggest-open');
  }

  function syncActive() {
    const opts = $list.querySelectorAll('.street-suggest-option');
    opts.forEach((el, i) => {
      const on = i === active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
    if (active >= 0 && opts[active]) $input.setAttribute('aria-activedescendant', opts[active].id);
    else $input.removeAttribute('aria-activedescendant');
  }

  function accept(entry) {
    if (!entry) return;
    accepting = true;
    $input.value = entry.n;
    // main.js hangs the URL-state writer and the sales re-filter off
    // 'input'; setting .value in script fires nothing.
    $input.dispatchEvent(new Event('input', { bubbles: true }));
    $input.dispatchEvent(new Event('change', { bubbles: true }));
    accepting = false;
    close();
  }

  function say(text) {
    const empty = document.createElement('div');
    empty.className = 'street-suggest-empty';
    empty.textContent = text;
    $list.appendChild(empty);
  }

  function render(noMuni) {
    $list.innerHTML = '';
    if (noMuni) say(noMuniText || 'Pick a municipality to see its streets');
    else if (!matches.length) say('No street by that name in this municipality');
    matches.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'street-suggest-option';
      row.id = `${listId}-opt-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const name = document.createElement('span');
      name.className = 'street-suggest-name';
      name.textContent = entry.n;
      const hint = document.createElement('span');
      hint.className = 'street-suggest-hint';
      hint.textContent = suggestHint(entry);
      row.appendChild(name);
      row.appendChild(hint);
      row.addEventListener('click', () => accept(entry));
      $list.appendChild(row);
    });
    $list.hidden = false;
    $input.setAttribute('aria-expanded', 'true');
    $row?.classList.add('street-suggest-open');
    syncActive();
  }

  function refresh() {
    if (suggestKey($input.value).length < STREET_SUGGEST_MIN_QUERY) { close(); return; }
    const mine = ++ticket;
    Promise.resolve()
      .then(getList)
      .catch((err) => { console.warn('street suggestions unavailable', err); return []; })
      .then((list) => {
        // The field can have moved on while the list was loading.
        if (mine !== ticket || document.activeElement !== $input) return;
        if (suggestKey($input.value).length < STREET_SUGGEST_MIN_QUERY) { close(); return; }
        matches = list ? suggestStreets(list, $input.value) : [];
        active = -1;
        render(list === null);
      });
  }

  $input.addEventListener('input', () => { if (!accepting) refresh(); });
  $input.addEventListener('focus', () => refresh());
  $input.addEventListener('blur', () => close());
  // Keep the pointer from stealing focus: blur fires before click and
  // would close the list out from under the cursor.
  $list.addEventListener('mousedown', (e) => e.preventDefault());

  $input.addEventListener('keydown', (e) => {
    const open = !$list.hidden && matches.length > 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) { refresh(); return; }
      e.preventDefault();
      // n+1 positions: -1 is "nothing highlighted, my own typing stands".
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const slots = matches.length + 1;
      active = (((active + 1 + step) % slots) + slots) % slots - 1;
      syncActive();
      return;
    }
    if (e.key === 'Escape') {
      if (!$list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
      return;
    }
    if (e.key === 'Tab') {
      if (open && active >= 0) accept(matches[active]);
      else close();
      return;
    }
    if (e.key === 'Enter') {
      // Enter is both keys at once: accept, THEN search. This field is
      // kept out of main.js's generic Enter-runs-the-search loop, since a
      // second listener would search the half-typed text.
      if (open && active >= 0) { e.preventDefault(); accept(matches[active]); }
      else close();
      onSearch?.();
    }
  });

  return { close, isOpen: () => !$list.hidden };
}
