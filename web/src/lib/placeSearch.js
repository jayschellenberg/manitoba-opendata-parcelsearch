// placeSearch.js — "which RM is Souris in?" answered from the map corner.
//
// A search box in the map's top-left that matches two different things:
//
//   * Manitoba PLACE names — towns, villages, localities, local urban
//     districts, reserves, the whole 1,969-entry populated-place list from
//     the Canadian Geographical Names Database. Picking a hit flies the map
//     there, pins it, and names the municipality that contains it.
//   * MUNICIPALITIES — all 183 boundaries the map draws. Picking one selects
//     it in the Property Search dropdown and frames the whole municipality,
//     which is the other half of the same question: having been told Souris
//     is in SOURIS-GLENWOOD, the obvious next move is to go to
//     SOURIS-GLENWOOD, and typing it into a 183-row select is worse than
//     typing it here.
//
// Municipality hits are listed FIRST, above the places, because they are the
// coarser and less ambiguous answer: a query that names a municipality
// almost always means the municipality, while the same string also matches
// every locality that borrowed the name.
//
// The containing municipality of a PLACE is NOT computed here.
// scripts/build-places.js resolves it at build time by point-in-polygon
// against the same municipal boundary file the map draws, and bakes the
// answer into every row of public/mb-places.json. So the RM is on screen
// the moment a result renders — no geometry, no second lookup, no waiting.
//
// The municipality rows come the other way, from the caller: main.js already
// holds the boundary FeatureCollection and the dropdown, so it hands them in
// through `getMunis` rather than this module fetching a 522 KB GeoJSON of
// its own. That also keeps "does this municipality have parcel data" — which
// is a fact about the dropdown, not about geography — out of here.
//
// The matching half of this module (normalizePlaceName, searchPlaces,
// searchMunis) is pure and exported for tests; the control class below is
// the DOM shell around it.

// Fetched once, on first keystroke — the Property Search tab is the common
// entry point and most sessions never touch the box, so 138 KB should not
// be on the critical path for anybody.
const PLACES_URL = 'mb-places.json';

const MAX_RESULTS = 8;

// How many municipalities may take from that budget when places also match.
// Four is enough for every real ambiguity in the boundary file — the worst
// case is a name shared by a city and an RM (Dauphin, Thompson, Portage la
// Prairie) or a town and an RM (Morris, Ste Anne, Lac du Bonnet), which is
// two — with room left for prefix hits like "ST" pulling in ST ANDREWS and
// ST CLEMENTS. Municipalities expand past this when few or no places match,
// so a muni-only query still fills the list; see _onQuery().
const MUNI_MAX_RESULTS = 4;

// Dropdown sizing, in px. The list is clamped between these and the room
// actually left inside the map pane — see _fitToMap().
//
// MAX fits a full MAX_RESULTS set without scrolling: rows are two lines
// (name + type, then municipality) and measure 50 px, so 8 of them plus
// the list's own padding come to 428, and the two group headings shown
// when both municipalities and places match add ~21 px each. Sizing to the
// full set matters more here than it looks — the municipality is the answer
// being read, and a result whose RM sits below the fold is one the user
// never sees.
const LIST_MAX_HEIGHT = 472;
const LIST_MIN_HEIGHT = 96;
const LIST_BOTTOM_GAP = 10;

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
      kind: 'place',
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

// ---- municipalities -------------------------------------------------
//
// The other half of the box. Rows come from the caller as
// { name, shortName, type, selectable } — the boundary file's
// MUNI_LIST_NAME_WITH_TYPE and MUNI_TYPE, the name with its type stripped
// off, and whether the Property Search dropdown actually offers this one.

/**
 * "HANOVER (RM)" → "HANOVER". The name without its type, which is what a
 * result row shows and what people type.
 *
 * Derived rather than read off the boundary file's MUNI_LIST_NAME, even
 * though that field exists: the FeatureCollection the app actually runs on
 * comes from the live ArcGIS service, whose outFields list does not request
 * it, so reading the field would work against the checked-in copy — and
 * against the test — while silently falling back to the full name in the
 * browser. Stripping the trailing parenthetical is one code path that
 * behaves the same on both, and the test pins it to MUNI_LIST_NAME across
 * all 183 rows of the file that does carry it.
 */
export function muniShortName(nameWithType) {
  const full = String(nameWithType ?? '');
  return full.replace(/\s*\([^()]*\)\s*$/, '').trim() || full;
}

/**
 * Spelled-out form of the boundary file's MUNI_TYPE codes.
 *
 * The file abbreviates ("RM", "LGD") in a way that reads fine appended to a
 * name — "HANOVER (RM)" — but poorly as a standalone label beside it, which
 * is where this is used. Anything unlisted falls back to title case, so a
 * new type code shows up readable rather than shouting in caps.
 *
 * Exported so the test can assert the boundary file holds no type this map
 * has never heard of — the fallback keeps such a code legible, but an
 * abbreviation like "LGD" title-cases to "Lgd", which is not an answer.
 */
export const MUNI_TYPE_LABELS = {
  RM: 'Rural Municipality',
  LGD: 'Local Government District',
  MUNICIPALITY: 'Municipality',
  CITY: 'City',
  TOWN: 'Town',
  VILLAGE: 'Village',
  'NORTHERN COMMUNITY': 'Northern Community',
  'NORTHERN SETTLEMENT': 'Northern Settlement',
};

export function muniTypeLabel(type) {
  const key = String(type ?? '').trim().toUpperCase();
  if (!key) return 'Municipality';
  return MUNI_TYPE_LABELS[key]
    ?? key.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Orders municipalities that share a name. Six names in the boundary file
// are held by two municipalities at once — Dauphin, Thompson and Portage la
// Prairie (city + RM), Morris, Ste Anne and Lac du Bonnet (town + RM) — and
// in every one of them the settlement is what a bare "Dauphin" means, so
// the urban type sorts first. Mirrors the place list's own RANK.
const MUNI_TYPE_RANK = {
  CITY: 1,
  TOWN: 2,
  VILLAGE: 3,
  MUNICIPALITY: 4,
  RM: 5,
  LGD: 6,
  'NORTHERN COMMUNITY': 7,
  'NORTHERN SETTLEMENT': 8,
};
const MUNI_TYPE_RANK_DEFAULT = 9;

/**
 * Every spelling of one municipality a person might type, as comparison
 * keys.
 *
 * Four forms, because all four occur in the wild: the dropdown's own
 * "HANOVER (RM)", the bare "HANOVER", and the two spoken orders "RM of
 * Hanover" and "Rural Municipality of Hanover". Without the last two,
 * typing a name the way people actually say it finds nothing — the type
 * sits at the END of every stored name, so a leading "RM of" cannot match
 * any tier.
 */
export function muniAliases(muni) {
  const short = muni?.shortName || muniShortName(muni?.name);
  const type = String(muni?.type ?? '').trim();
  const keys = [
    muni?.name,
    short,
    type && `${type} of ${short}`,
    type && `${muniTypeLabel(type)} of ${short}`,
  ];
  return [...new Set(keys.map(normalizePlaceName).filter(Boolean))];
}

/**
 * Rank municipality `rows` against `query`, using the same match tiers as
 * searchPlaces so the two halves of the list agree about what "a good hit"
 * means. A municipality matches on its best alias — an exact hit on the
 * bare name is not demoted just because the name-with-type is longer.
 *
 * Sorted by tier, then by whether the municipality can actually be selected
 * (one with no parcel data is a dead end for a search and belongs below one
 * that isn't), then by type rank, then shortest name, then alphabetically.
 */
export function searchMunis(rows, query, { limit = MUNI_MAX_RESULTS } = {}) {
  const needle = normalizePlaceName(query);
  if (!needle) return [];

  const hits = [];
  for (const m of rows ?? []) {
    if (!m?.name) continue;
    let tier = -1;
    for (const alias of muniAliases(m)) {
      const t = matchTier(alias, needle);
      if (t >= 0 && (tier < 0 || t < tier)) tier = t;
      if (tier === EXACT) break;
    }
    if (tier < 0) continue;
    hits.push({
      kind: 'muni',
      tier,
      name: m.name,
      shortName: m.shortName || muniShortName(m.name),
      type: m.type ?? '',
      typeLabel: muniTypeLabel(m.type),
      selectable: m.selectable !== false,
      rank: MUNI_TYPE_RANK[String(m.type ?? '').toUpperCase()] ?? MUNI_TYPE_RANK_DEFAULT,
    });
  }

  hits.sort((a, b) =>
    (a.tier - b.tier) ||
    (Number(b.selectable) - Number(a.selectable)) ||
    (a.rank - b.rank) ||
    (a.shortName.length - b.shortName.length) ||
    a.name.localeCompare(b.name));

  return hits.slice(0, limit);
}

/**
 * The second line of a municipality's result row.
 *
 * Says what picking it will do, which is not the same for all 183: the ones
 * the archive has parcels for load into Property Search ready to search,
 * and the rest — mostly northern communities and settlements — can only be
 * flown to. Saying so on the row is the difference between "the dropdown
 * didn't change" reading as a bug and reading as an answer.
 */
export function muniPickHint(hit) {
  return hit?.selectable
    ? 'Selects in Property Search'
    : 'No parcel data — map only';
}

/**
 * Place-search control for the map's top-left corner.
 *
 * `onPick(hit)` fires with the chosen row — a place (`kind: 'place'`) or a
 * municipality (`kind: 'muni'`); the caller owns what happens next (fly,
 * pin, set the municipality dropdown) because all of that is app state this
 * module has no business reaching into.
 *
 * `getMunis()` supplies the municipality rows, and is called on every query
 * rather than once: `selectable` is read off the Property Search dropdown,
 * which populates asynchronously after boot, so a list cached on the first
 * keystroke could mark every municipality unselectable forever. It may
 * return an array or a promise for one, and returning `[]` simply leaves
 * the box place-only.
 */
export class PlaceSearchControl {
  constructor({ onPick, getMunis, fetchImpl } = {}) {
    this._onPick = onPick;
    this._getMunis = getMunis;
    // Wrapped, not stored bare: window.fetch throws "Illegal invocation"
    // when called as a method of anything other than window, which is
    // exactly what `this._fetch(url)` would do.
    this._fetch = fetchImpl ?? ((...args) => fetch(...args));
    this._rows = null;       // loaded lazily
    this._loading = null;    // in-flight fetch, shared by concurrent keystrokes
    this._failed = false;    // so a failure doesn't render as "still loading"
    this._hits = [];         // flat, municipalities first — the pickable rows
    this._muniCount = 0;     // how many of _hits are municipalities
    this._rowEls = [];       // their <li>s, so group headings don't shift the index
    this._active = -1;       // keyboard cursor into _hits
  }

  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    // `maplibregl-ctrl` only — deliberately NOT `maplibregl-ctrl-group`.
    // That class carries `overflow: hidden` (style.css), and the results
    // list is absolutely positioned BELOW the container's own box, so the
    // group class clips the entire dropdown away: it stays in the DOM,
    // reads correctly from script, and is never painted. `maplibregl-ctrl`
    // is the part actually needed — it restores pointer-events on top of
    // the control container's `pointer-events: none`.
    this._container.className = 'maplibregl-ctrl place-search';

    this._input = document.createElement('input');
    this._input.type = 'search';
    this._input.className = 'place-search-input';
    this._input.placeholder = 'Find a town or municipality…';
    this._input.autocomplete = 'off';
    this._input.spellcheck = false;
    this._input.setAttribute('aria-label',
      'Find a Manitoba municipality, town, village or locality');
    this._input.title =
      'Search Manitoba municipalities and place names.\n\n'
      + 'Municipalities (RMs, cities, towns, villages, LGDs, northern '
      + 'communities) are listed first; picking one selects it in Property '
      + 'Search and frames it on the map.\n\n'
      + 'Places — towns, villages, localities, local urban districts and '
      + 'reserves — come below; picking one flies the map there, pins it, and '
      + 'tells you which municipality it sits in (and selects that '
      + 'municipality in Property Search, ready to search).';

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

  /**
   * Current municipality rows from the caller, or [] if it supplied none
   * or threw. A failure here is deliberately quiet: the place half of the
   * box still works, and a broken municipality list is not worth blanking
   * a search that would otherwise answer.
   */
  async _ensureMunis() {
    if (!this._getMunis) return [];
    try {
      return (await this._getMunis()) ?? [];
    } catch (err) {
      console.warn('[placeSearch] could not load municipalities', err);
      return [];
    }
  }

  async _onQuery() {
    const q = this._input.value;
    if (!q.trim()) { this._close(); return; }
    const [rows, munis] = await Promise.all([this._ensureRows(), this._ensureMunis()]);
    // The user may have typed on while the fetch was in flight; only
    // render if this query is still the current one.
    if (this._input.value !== q) return;

    const muniHits  = searchMunis(munis, q, { limit: MAX_RESULTS });
    const placeHits = searchPlaces(rows, q, { limit: MAX_RESULTS });
    // Municipalities lead but are rationed, so a prefix like "st" cannot
    // spend the whole list on RMs and hide St-Pierre-Jolys. They do take
    // the room the places leave unused, so a query only municipalities
    // match fills the list instead of showing four rows and stopping.
    const muniTake = Math.min(
      muniHits.length,
      Math.max(MUNI_MAX_RESULTS, MAX_RESULTS - placeHits.length),
    );
    this._muniCount = muniTake;
    this._hits = [
      ...muniHits.slice(0, muniTake),
      ...placeHits.slice(0, MAX_RESULTS - muniTake),
    ];
    this._active = this._hits.length ? 0 : -1;
    this._render();
  }

  /** One result row. Municipalities and places share the row shape — name
   *  and type on the first line, the answer-ish third field on the second —
   *  because they answer the same question at two scales. */
  _renderHit(hit, i) {
    const li = document.createElement('li');
    const isMuni = hit.kind === 'muni';
    li.className = 'place-search-hit'
      + (isMuni ? ' is-muni' : '')
      + (i === this._active ? ' is-active' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === this._active));

    const name = document.createElement('span');
    name.className = 'place-search-name';
    // Municipalities show the bare name, not the dropdown's
    // "HANOVER (RM)": the type is already spelled out in the chip beside
    // it, and printing it twice makes the one line that distinguishes
    // DAUPHIN the city from DAUPHIN the RM harder to scan, not easier.
    name.textContent = isMuni ? hit.shortName : hit.name;

    const type = document.createElement('span');
    type.className = 'place-search-type';
    type.textContent = isMuni ? hit.typeLabel : hit.type;

    const note = document.createElement('span');
    note.className = 'place-search-muni'
      + ((isMuni ? hit.selectable : hit.muni) ? '' : ' is-none');
    note.textContent = isMuni ? muniPickHint(hit) : muniLabel(hit);

    li.append(name, type, note);
    li.addEventListener('mouseenter', () => { this._active = i; this._paintActive(); });
    // mousedown, not click: the input's blur would otherwise race the
    // click and close the list out from under the pointer.
    li.addEventListener('mousedown', (e) => { e.preventDefault(); this._pick(i); });
    return li;
  }

  /** Section heading. Not a `role="option"` and not in _rowEls, so it is
   *  invisible to both the keyboard cursor and the pick index. */
  _renderGroup(text) {
    const li = document.createElement('li');
    li.className = 'place-search-group';
    li.setAttribute('role', 'presentation');
    li.textContent = text;
    return li;
  }

  _render() {
    this._list.innerHTML = '';
    this._rowEls = [];
    if (!this._hits.length) {
      const li = document.createElement('li');
      li.className = 'place-search-empty';
      // Three distinct states — a failed load must not masquerade as a
      // slow one, or the box looks like it is still working when it is
      // never going to answer.
      li.textContent = this._rows ? 'No municipality or place by that name'
        : this._failed ? 'Could not load the place list'
        : 'Loading places…';
      this._list.appendChild(li);
      this._list.hidden = false;
      return;
    }

    // Headings only when both kinds are present. One kind on its own needs
    // no label — every row already carries its type in the chip, and a lone
    // "Municipalities" heading over a full list is chrome, not information.
    const muniCount = this._muniCount ?? 0;
    const grouped = muniCount > 0 && muniCount < this._hits.length;

    this._hits.forEach((hit, i) => {
      if (grouped && i === 0) this._list.appendChild(this._renderGroup('Municipalities'));
      if (grouped && i === muniCount) this._list.appendChild(this._renderGroup('Places'));
      const li = this._renderHit(hit, i);
      this._rowEls.push(li);
      this._list.appendChild(li);
    });
    this._list.hidden = false;
    this._fitToMap();
  }

  /**
   * Cap the list's height to the room left below it inside the map pane.
   *
   * The map pane is `overflow: hidden` and cannot stop being — so a list
   * taller than the space beneath the input has its lower rows clipped
   * away silently. They stay in the DOM and read fine from script; they
   * are simply never painted, which is indistinguishable from "the search
   * only found six things". Scrolling (overflow-y on the list) is the
   * honest alternative, and arrow-key navigation already scrolls the
   * active row into view.
   *
   * Recomputed per render rather than once: the map pane is resizable by
   * the workspace splitter, so the available room changes at runtime.
   */
  _fitToMap() {
    const mapEl = this._map?.getContainer?.();
    if (!mapEl) return;
    const room = mapEl.getBoundingClientRect().bottom
               - this._list.getBoundingClientRect().top
               - LIST_BOTTOM_GAP;
    // Floor at two rows: below that the map pane is too short to work in
    // at all, and a zero-height list would read as "no results".
    this._list.style.maxHeight = `${Math.max(LIST_MIN_HEIGHT, Math.min(LIST_MAX_HEIGHT, room))}px`;
  }

  // Walks _rowEls, not _list.children: the group headings are children too,
  // and indexing through them would paint the wrong row the moment both
  // municipalities and places are on screen.
  _paintActive() {
    this._rowEls.forEach((li, i) => {
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
    this._rowEls[this._active]?.scrollIntoView({ block: 'nearest' });
  }

  _pick(i) {
    const hit = this._hits[i];
    if (!hit) return;
    // Leave the chosen name in the box: it labels what the map is showing,
    // and a second Enter re-flies there after the user has panned away.
    // Municipalities get their full dropdown spelling here rather than the
    // short name shown on the row, so the box and the dropdown read the
    // same afterwards.
    this._input.value = hit.name;
    this._close();
    this._input.blur();
    this._onPick?.(hit, { zoom: PICK_ZOOM });
  }

  _close() {
    this._list.hidden = true;
    this._list.innerHTML = '';
    this._rowEls = [];
    this._active = -1;
  }
}
