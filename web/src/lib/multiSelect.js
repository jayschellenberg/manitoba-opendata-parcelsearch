/*
 * Compact multi-select — a one-line control that opens a checkbox list.
 *
 * Replaces a `<select multiple size="4">`, which costs four rows of
 * sidebar height whether or not anything is selected and hides the
 * Ctrl/Cmd-click requirement behind a control that looks like it
 * supports plain clicking. This shows the current state as text ("Any
 * class" / "RESIDENTIAL 1" / "3 classes") and only spends vertical
 * space while the user is actually choosing.
 *
 * Built on <details>, like the sidebar's other disclosures, so the
 * open/close state, keyboard activation and focus behaviour come from
 * the element rather than from hand-written key handlers. The menu is
 * absolutely positioned (see .multiselect-menu in style.css) so opening
 * it overlays the rows below instead of shoving them down the panel.
 *
 * The control dispatches a bubbling `change` event on its root whenever
 * the selection changes, so callers can keep wiring it alongside plain
 * <input>/<select> elements in a single listener loop.
 *
 * Expected markup — the module fills in the label and the menu:
 *   <details class="multiselect" id="asmt-class">
 *     <summary><span class="multiselect-label"></span></summary>
 *     <div class="multiselect-menu"></div>
 *   </details>
 */

/**
 * The text shown on the closed control.
 *
 * One selection reads as itself — with a short list of assessment
 * classes, naming the one you picked is more useful than a count. Two
 * or more collapse to a count, because the values run to 30-odd
 * characters ("RESIDENTIAL 3--CONDOS & CO-OPS") and two of them
 * side by side would just truncate into noise.
 */
export function summarizeSelection(selected, { placeholder = 'Any', noun = 'selected' } = {}) {
  const list = (selected || []).filter((v) => v !== '' && v != null);
  if (list.length === 0) return placeholder;
  if (list.length === 1) return String(list[0]);
  return `${list.length} ${noun}`;
}

/**
 * Rebuild an option list while keeping whatever is still selectable.
 *
 * Each sales upload recomputes the available classes from the parcels
 * that actually matched, so the list changes underfoot. Selections that
 * survive into the new list are kept — re-picking the same class after
 * every upload would be the kind of small tax that stops people using
 * the filter at all — and ones that don't simply drop.
 */
export function retainSelection(previousSelected, nextOptions) {
  const available = new Set(nextOptions || []);
  return (previousSelected || []).filter((v) => available.has(v));
}

/**
 * Wire up a compact multi-select.
 *
 * @param {HTMLElement} root - the <details class="multiselect"> element
 * @param {Object} opts
 * @param {string} opts.placeholder - label when nothing is selected
 * @param {string} opts.noun - plural noun for the "N noun" summary
 * @returns {{setOptions, getSelected, setSelected, clear, isEmpty}}
 *   A no-op stub when `root` is missing, so callers don't need to
 *   null-check every method.
 */
export function initMultiSelect(root, { placeholder = 'Any', noun = 'selected' } = {}) {
  if (!root) {
    return {
      setOptions: () => {},
      getSelected: () => [],
      setSelected: () => {},
      clear: () => {},
      isEmpty: () => true,
    };
  }

  const $label = root.querySelector('.multiselect-label');
  const $menu  = root.querySelector('.multiselect-menu');
  let options  = [];
  let selected = [];

  function renderLabel() {
    if ($label) $label.textContent = summarizeSelection(selected, { placeholder, noun });
    // Lets CSS mute the control while it reads "Any …", matching how a
    // placeholder in a text input renders against a filled-in one.
    root.classList.toggle('has-selection', selected.length > 0);
  }

  function emitChange() {
    root.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function renderMenu() {
    if (!$menu) return;
    $menu.innerHTML = '';
    if (options.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'multiselect-empty';
      empty.textContent = 'No values yet — upload sales first.';
      $menu.appendChild(empty);
      return;
    }
    // "Clear" sits above the list rather than beside the summary: the
    // summary is the click target that opens the menu, so a button
    // inside it would fight the disclosure for the same click.
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'multiselect-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      if (selected.length === 0) return;
      clear();
      emitChange();
    });
    $menu.appendChild(clearBtn);

    const selectedSet = new Set(selected);
    for (const value of options) {
      const row = document.createElement('label');
      row.className = 'multiselect-option';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = value;
      box.checked = selectedSet.has(value);
      box.addEventListener('change', (e) => {
        // The checkbox's own change event would bubble to the root as
        // well, so callers listening on the root would be told twice
        // per click. Swallow it and let emitChange() below be the one
        // signal the control produces — the Clear button needs an
        // explicit dispatch anyway, and one code path is easier to
        // reason about than two that happen to agree.
        e.stopPropagation();
        selected = box.checked
          ? [...selected, value]
          : selected.filter((v) => v !== value);
        // Keep selection in the option list's order so the summary and
        // any future export read predictably rather than in click order.
        selected = options.filter((v) => selected.includes(v));
        renderLabel();
        emitChange();
      });
      const text = document.createElement('span');
      text.textContent = value;
      row.append(box, text);
      $menu.appendChild(row);
    }
  }

  function setOptions(values) {
    options = [...(values || [])];
    selected = retainSelection(selected, options);
    renderMenu();
    renderLabel();
  }

  function getSelected() {
    return [...selected];
  }

  function setSelected(values) {
    selected = retainSelection(values, options);
    renderMenu();
    renderLabel();
  }

  function clear() {
    if (selected.length === 0) return;
    selected = [];
    renderMenu();
    renderLabel();
  }

  // Close on outside click and on Escape. <details> gives us toggle and
  // keyboard-open for free but has no notion of "click elsewhere means
  // done", which is the behaviour a dropdown is expected to have.
  document.addEventListener('click', (e) => {
    if (!root.open) return;
    if (!root.contains(e.target)) root.open = false;
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.open) {
      root.open = false;
      root.querySelector('summary')?.focus();
    }
  });

  renderMenu();
  renderLabel();
  return { setOptions, getSelected, setSelected, clear, isEmpty: () => selected.length === 0 };
}
