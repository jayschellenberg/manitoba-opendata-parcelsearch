// placeSearch.js — "which RM is Souris in?" answered from the map corner.
//
// A search box in the map's top-left that matches Manitoba place names —
// towns, villages, localities, local urban districts, reserves, the whole
// 1,969-entry populated-place list from the Canadian Geographical Names
// Database. Picking a hit flies the map there, pins it, and names the
// municipality that contains it.
//
// The containing municipality is NOT computed here. scripts/build-places.js
// resolves it at build time by point-in-polygon against the same municipal
// boundary file the map draws, and bakes the answer into every row of
// public/mb-places.json. So the RM is on screen the moment a result
// renders — no geometry, no second lookup, no waiting.
//
// The matching half of this module (normalizePlaceName, searchPlaces) is
// pure and exported for tests; the control class below is the DOM shell
// around it.

// Fetched once, on first keystroke — the Property Search tab is the common
// entry point and most sessions never touch the box, so 138 KB should not
// be on the critical path for anybody.
const PLACES_URL = 'mb-places.json';

const MAX_RESULTS = 8;

// Zoom for a picked place. 12.5 frames a small Manitoba town with enough
// surrounding township to see which direction the RM extends — the point
// of the search is orientation, so landing too tight defeats it.
const PICK_ZOOM = 12.5;

/**
 * Fold a name to a comparison key: uppercase, accents stripped, hyphens
 * and apostrophes flattened to spaces, runs of space collapsed.
 *
 * Manitoba place names are full of both ("Ste. Rose du Lac", "St-Pierre-
 * Jolys", "L'Ile-des-Chenes"), and nobody types the punctuation. Folding
 * both sides means "ile des chenes" finds "L'Île-des-Chênes".
 */
export function normalizePlaceName(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

// Match tiers, best first. Ordering results by tier before the place's own
// rank is what keeps "Souris" the town above "Souris Corner" the locality:
// an exact hit always outranks a longer name that merely starts the same.
const EXACT = 0, PREFIX = 1, WORD = 2, CONTAINS = 3;

function matchTier(haystack, needle) {
  if (haystack === needle) return EXACT;
  if (haystack.startsWith(needle)) return PREFIX;
  // Word-start match, so "lac" finds "Ste Rose du Lac" but "ros" does not
  // match it here (it lands in CONTAINS instead, below every real hit).
  if (haystack.includes(` ${needle}`)) return WORD;
  if (haystack.includes(needle)) return CONTAINS;
  return -1;
}

/**
 * Rank `rows` against `query`. Rows are the raw arrays from
 * mb-places.json: [name, type, rank, lat, lon, muni, near].
 *
 * Sorted by match tier, then the place's own rank (city before town
 * before railway point), then shortest name, then alphabetically —
 * shortest-first so "Gimli" beats "Gimli Industrial Park" on the same
 * tier.
 */
export function searchPlaces(rows, query, { limit = MAX_RESULTS } = {}) {
  const needle = normalizePlaceName(query);
  if (!needle) return [];

  const hits = [];
  for (const r of rows) {
    const tier = matchTier(normalizePlaceName(r[0]), needle);
    if (tier < 0) continue;
    hits.push({
      tier,
      name: r[0], type: r[1], rank: r[2],
      lat: r[3], lon: r[4], muni: r[5], near: !!r[6],
    });
  }

  hits.sort((a, b) =>
    (a.tier - b.tier) ||
    (a.rank - b.rank) ||
    (a.name.length - b.name.length) ||
    a.name.localeCompare(b.name));

  return hits.slice(0, limit);
}

/** How a hit's municipality reads in the result list and the pin popup. */
export function muniLabel(hit) {
  if (!hit.muni) return 'Unorganized territory';
  return hit.near ? `near ${hit.muni}` : hit.muni;
}

/**
 * Place-search control for the map's top-left corner.
 *
 * `onPick(hit)` fires with the chosen place; the caller owns what happens
 * next (fly, pin, set the municipality dropdown) because all of that is
 * app state this module has no business reaching into.
 */
export class PlaceSearchControl {
  constructor({ onPick, fetchImpl } = {}) {
    this._onPick = onPick;
    // Wrapped, not stored bare: window.fetch throws "Illegal invocation"
    // when called as a method of anything other than window, which is
    // exactly what `this._fetch(url)` would do.
    this._fetch = fetchImpl ?? ((...args) => fetch(...args));
    this._rows = null;       // loaded lazily
    this._loading = null;    // in-flight fetch, shared by concurrent keystrokes
    this._failed = false;    // so a failure doesn't render as "still loading"
    this._hits = [];
    this._active = -1;       // keyboard cursor into _hits
  }

  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group place-search';

    this._input = document.createElement('input');
    this._input.type = 'search';
    this._input.className = 'place-search-input';
    this._input.placeholder = 'Find a town…';
    this._input.autocomplete = 'off';
    this._input.spellcheck = false;
    this._input.setAttribute('aria-label', 'Find a Manitoba town, village or locality');
    this._input.title =
      'Search Manitoba place names — towns, villages, localities, local urban '
      + 'districts and reserves. Picking one flies the map there, pins it, and '
      + 'tells you which municipality it sits in (and selects that municipality '
      + 'in Property Search, ready to search).';

    this._list = document.createElement('ul');
    this._list.className = 'place-search-results';
    this._list.hidden = true;

    this._container.append(this._input, this._list);

    // Keystrokes must not reach the map: MapLibre binds single letters to
    // nothing today, but it does own the arrow keys for panning, and a
    // typed space would otherwise scroll the page.
    this._container.addEventListener('keydown', (e) => e.stopPropagation());

    this._input.addEventListener('input', () => this._onQuery());
    this._input.addEventListener('keydown', (e) => this._onKeyDown(e));
    this._input.addEventListener('focus', () => { this._ensureRows(); });
    // Close on outside click. Not on blur — blur fires before the click
    // lands on a result row and would cancel the pick.
    this._onDocClick = (e) => {
      if (!this._container.contains(e.target)) this._close();
    };
    document.addEventListener('click', this._onDocClick);

    return this._container;
  }

  onRemove() {
    document.removeEventListener('click', this._onDocClick);
    this._container?.remove();
    this._map = undefined;
  }

  /** Load the place table once; concurrent callers share the one request. */
  _ensureRows() {
    if (this._rows) return Promise.resolve(this._rows);
    if (!this._loading) {
      this._loading = this._fetch(PLACES_URL)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data) => {
          this._rows = data.rows ?? [];
          this._failed = false;
          return this._rows;
        })
        .catch((err) => {
          console.warn('[placeSearch] could not load places', err);
          this._loading = null;   // let a later keystroke retry
          this._rows = null;
          this._failed = true;
          return [];
        });
    }
    return this._loading;
  }

  async _onQuery() {
    const q = this._input.value;
    if (!q.trim()) { this._close(); return; }
    const rows = await this._ensureRows();
    // The user may have typed on while the fetch was in flight; only
    // render if this query is still the current one.
    if (this._input.value !== q) return;
    this._hits = searchPlaces(rows, q);
    this._active = this._hits.length ? 0 : -1;
    this._render();
  }

  _render() {
    this._list.innerHTML = '';
    if (!this._hits.length) {
      const li = document.createElement('li');
      li.className = 'place-search-empty';
      // Three distinct states — a failed load must not masquerade as a
      // slow one, or the box looks like it is still working when it is
      // never going to answer.
      li.textContent = this._rows ? 'No place by that name'
        : this._failed ? 'Could not load the place list'
        : 'Loading places…';
      this._list.appendChild(li);
      this._list.hidden = false;
      return;
    }

    this._hits.forEach((hit, i) => {
      const li = document.createElement('li');
      li.className = 'place-search-hit' + (i === this._active ? ' is-active' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === this._active));

      const name = document.createElement('span');
      name.className = 'place-search-name';
      name.textContent = hit.name;

      const type = document.createElement('span');
      type.className = 'place-search-type';
      type.textContent = hit.type;

      const muni = document.createElement('span');
      muni.className = 'place-search-muni' + (hit.muni ? '' : ' is-none');
      muni.textContent = muniLabel(hit);

      li.append(name, type, muni);
      li.addEventListener('mouseenter', () => { this._active = i; this._paintActive(); });
      // mousedown, not click: the input's blur would otherwise race the
      // click and close the list out from under the pointer.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); this._pick(i); });
      this._list.appendChild(li);
    });
    this._list.hidden = false;
  }

  _paintActive() {
    [...this._list.children].forEach((li, i) => {
      li.classList.toggle('is-active', i === this._active);
      li.setAttribute('aria-selected', String(i === this._active));
    });
  }

  _onKeyDown(e) {
    if (e.key === 'Escape') { this._close(); this._input.blur(); return; }
    if (!this._hits.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._active = (this._active + 1) % this._hits.length;
      this._paintActive();
      this._scrollActiveIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._active = (this._active - 1 + this._hits.length) % this._hits.length;
      this._paintActive();
      this._scrollActiveIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this._active >= 0) this._pick(this._active);
    }
  }

  _scrollActiveIntoView() {
    this._list.children[this._active]?.scrollIntoView({ block: 'nearest' });
  }

  _pick(i) {
    const hit = this._hits[i];
    if (!hit) return;
    // Leave the chosen name in the box: it labels what the pin is, and a
    // second Enter re-flies there after the user has panned away.
    this._input.value = hit.name;
    this._close();
    this._input.blur();
    this._onPick?.(hit, { zoom: PICK_ZOOM });
  }

  _close() {
    this._list.hidden = true;
    this._list.innerHTML = '';
    this._active = -1;
  }
}
