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
 * TWO MODES.
 *
 *   FLAT — setOptions(['RESIDENTIAL 1', ...]). What the class, zoning and
 *     zoning-type filters use: a short list of strings, ticked directly.
 *
 *   GROUPED — setGroups([{family, options:[{value, label, count}]}]).
 *     Added for the Primary Property filter, whose value space is far too
 *     long to tick through flat (565 descriptors province-wide, median 100
 *     per municipality). Each group renders as its own <details> with a
 *     tri-state parent checkbox, so "every Residential structure type" is
 *     one click rather than nine. The pattern is lifted from the sales
 *     database panel's region list (salesDbPanel.js renderMuniList), which
 *     solved the same problem for 186 municipalities.
 *
 * In grouped mode a tick's `value` is a caller-supplied key rather than the
 * visible text, because labels are NOT unique across groups — Primary
 * Property has an "Other" bucket under both Residential and ICI, and
 * ticking one must not silently tick the other.
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
 *
 * `labelOf` maps a value to its display text, for grouped mode where the
 * two differ. Omitted, the value IS the label, which is what every flat
 * caller wants.
 */
export function summarizeSelection(selected, { placeholder = 'Any', noun = 'selected', labelOf } = {}) {
  const list = (selected || []).filter((v) => v !== '' && v != null);
  if (list.length === 0) return placeholder;
  if (list.length === 1) {
    // Fall back to the value when the label map doesn't know it — a stale
    // selection would otherwise put the literal text "undefined" on the
    // closed control, which reads as a bug rather than as a stale tick.
    const one = list[0];
    return String((labelOf ? labelOf(one) : one) ?? one);
  }
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
 * Flatten a grouped option tree to the leaf values, in display order.
 * Exported so callers (and tests) can reason about what a tree offers
 * without walking it themselves.
 */
export function flattenGroups(groups) {
  const out = [];
  for (const g of groups || []) {
    for (const o of g?.options || []) out.push(o);
  }
  return out;
}

const fmtCount = (n) => Number(n || 0).toLocaleString();

/**
 * Wire up a compact multi-select.
 *
 * @param {HTMLElement} root - the <details class="multiselect"> element
 * @param {Object} opts
 * @param {string} opts.placeholder - label when nothing is selected
 * @param {string} opts.noun - plural noun for the "N noun" summary
 * @returns {{setOptions, setGroups, getSelected, setSelected, clear, isEmpty}}
 *   A no-op stub when `root` is missing, so callers don't need to
 *   null-check every method.
 */
export function initMultiSelect(root, {
  placeholder = 'Any',
  noun = 'selected',
  emptyLabel = 'No values yet.',
} = {}) {
  if (!root) {
    return {
      setOptions: () => {},
      setGroups: () => {},
      getSelected: () => [],
      setSelected: () => {},
      clear: () => {},
      isEmpty: () => true,
    };
  }

  const $label = root.querySelector('.multiselect-label');
  const $menu  = root.querySelector('.multiselect-menu');
  // `options` is always the flat list of selectable leaves, in display
  // order, whichever mode we are in — so selection retention, ordering and
  // the summary have exactly one code path. `groups` is non-empty only in
  // grouped mode, and only the renderer looks at it.
  let groups   = [];
  let options  = [];   // [{value, label, count?}]
  let selected = [];   // values

  // Live checkbox references, rebuilt by renderMenu. Ticking a box updates
  // its siblings' state in place rather than re-rendering the menu, which
  // would collapse the open group and lose the scroll position mid-click.
  let childBoxes = new Map();   // value -> input
  let groupBoxes = [];          // [{box, values}]

  const labelOf = (value) => options.find((o) => o.value === value)?.label ?? value;
  const optionValues = () => options.map((o) => o.value);

  function renderLabel() {
    if ($label) $label.textContent = summarizeSelection(selected, { placeholder, noun, labelOf });
    // Lets CSS mute the control while it reads "Any …", matching how a
    // placeholder in a text input renders against a filled-in one.
    root.classList.toggle('has-selection', selected.length > 0);
  }

  function emitChange() {
    root.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Keep selection in the option list's order, not click order. */
  function normalizeSelection() {
    const picked = new Set(selected);
    selected = optionValues().filter((v) => picked.has(v));
  }

  /** Refresh every checkbox from `selected`, without rebuilding the DOM. */
  function refreshBoxes() {
    const picked = new Set(selected);
    for (const [value, box] of childBoxes) box.checked = picked.has(value);
    for (const { box, values } of groupBoxes) {
      const n = values.filter((v) => picked.has(v)).length;
      box.checked = n === values.length && values.length > 0;
      box.indeterminate = n > 0 && n < values.length;
    }
  }

  function setValues(values, on) {
    const picked = new Set(selected);
    for (const v of values) {
      if (on) picked.add(v); else picked.delete(v);
    }
    selected = [...picked];
    normalizeSelection();
    refreshBoxes();
    renderLabel();
    emitChange();
  }

  function optionRow(opt) {
    const row = document.createElement('label');
    row.className = 'multiselect-option';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = opt.value;
    box.checked = selected.includes(opt.value);
    box.addEventListener('change', (e) => {
      // The checkbox's own change event would bubble to the root as
      // well, so callers listening on the root would be told twice
      // per click. Swallow it and let emitChange() below be the one
      // signal the control produces — the Clear button needs an
      // explicit dispatch anyway, and one code path is easier to
      // reason about than two that happen to agree.
      e.stopPropagation();
      setValues([opt.value], box.checked);
    });
    const text = document.createElement('span');
    // The count matters more than it looks. Primary Property's blank share
    // swings from 45% of Residential sales to 96% of Farm ones, so a bare
    // list would hide that a farm subcategory filter addresses 4% of the
    // farm sales on screen.
    text.textContent = opt.count == null ? opt.label : `${opt.label} (${fmtCount(opt.count)})`;
    row.append(box, text);
    return row;
  }

  function renderMenu() {
    if (!$menu) return;
    $menu.innerHTML = '';
    childBoxes = new Map();
    groupBoxes = [];

    if (options.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'multiselect-empty';
      empty.textContent = emptyLabel;
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
      selected = [];
      refreshBoxes();
      renderLabel();
      emitChange();
    });
    $menu.appendChild(clearBtn);

    if (groups.length === 0) {
      for (const opt of options) {
        const row = optionRow(opt);
        childBoxes.set(opt.value, row.querySelector('input'));
        $menu.appendChild(row);
      }
      refreshBoxes();
      return;
    }

    for (const group of groups) {
      const values = (group.options || []).map((o) => o.value);
      if (values.length === 0) continue;
      const wrap = document.createElement('details');
      wrap.className = 'multiselect-group';
      // Open a group that already has ticks, so a re-render after an
      // upload doesn't hide the user's own selection behind a summary.
      wrap.open = values.some((v) => selected.includes(v));

      const sum = document.createElement('summary');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.addEventListener('click', (e) => e.stopPropagation());   // don't toggle the disclosure
      box.addEventListener('change', (e) => {
        e.stopPropagation();
        setValues(values, box.checked);
      });
      const name = document.createElement('span');
      name.className = 'multiselect-group-name';
      const total = group.count == null
        ? group.options.reduce((s, o) => s + (o.count || 0), 0)
        : group.count;
      name.textContent = total ? `${group.family} (${fmtCount(total)})` : group.family;
      sum.append(box, name);
      wrap.appendChild(sum);
      groupBoxes.push({ box, values });

      for (const opt of group.options) {
        const row = optionRow(opt);
        childBoxes.set(opt.value, row.querySelector('input'));
        wrap.appendChild(row);
      }
      $menu.appendChild(wrap);
    }
    refreshBoxes();
  }

  /** Flat mode: a plain list of strings, value and label being the same. */
  function setOptions(values) {
    groups = [];
    options = (values || []).map((v) => ({ value: v, label: v }));
    selected = retainSelection(selected, optionValues());
    renderMenu();
    renderLabel();
  }

  /** Grouped mode: [{family, count?, options:[{value, label, count?}]}]. */
  function setGroups(next) {
    groups = (next || []).filter((g) => (g?.options || []).length > 0);
    options = flattenGroups(groups);
    selected = retainSelection(selected, optionValues());
    renderMenu();
    renderLabel();
  }

  function getSelected() {
    return [...selected];
  }

  function setSelected(values) {
    selected = retainSelection(values, optionValues());
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
  return { setOptions, setGroups, getSelected, setSelected, clear, isEmpty: () => selected.length === 0 };
}
