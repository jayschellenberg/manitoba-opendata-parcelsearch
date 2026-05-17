# Refactor notes - Manitoba Parcel Search UI/UX pass

Living document. Updated at the end of every refactor phase. Aimed at
future-me porting these patterns to the sister Winnipeg parcel-search
app once this work lands.

## Stack snapshot

- Framework: plain JavaScript (ES modules), bundled with Vite 5.4.10.
- Map: MapLibre GL 4.7.1, `@mapbox/mapbox-gl-draw` 1.5.1, several
  `@turf/*` 7.x helpers.
- Styling: Tailwind CSS v4 (added in Phase 1) layered alongside the
  existing `web/src/style.css`.
- State: imperative DOM, no React. Module surface in `web/src/`.
- Caching: client-only. IndexedDB primary, localStorage fallback,
  namespaced `mbpsCache.*`. Two Vercel Edge Functions serve static
  pre-built JSON shards from `web/public/data/`.
- Package manager: npm. Locale convention: en-CA (Canadian English).
- Deploy: Vercel, `framework: vite`, build `cd web && npm install &&
  npm run build`, output `web/dist`.

## Phase 1 - Foundation

### Decisions

- Tailwind v4 over v3. The `@tailwindcss/vite` plugin keeps the
  config to a single Vite plugin call and a `@theme` block inside
  `web/src/tailwind.css`; no `postcss.config.js` or
  `tailwind.config.js` needed.
- Tailwind is loaded *additively* during the migration: the legacy
  `style.css` stays in place and continues to govern layout. The new
  tokens are exposed as CSS custom properties so the legacy stylesheet
  can consume them too (e.g. `font-family: var(--font-sans, ...)`).
- Header colour shifted from teal `#1a3a4a` to slate-navy `#1e293b`
  (the new `--color-primary-500`). Intentional, per the design-token
  spec. Easy to revert by changing the variable in `tailwind.css`.
- Inter loaded from Google Fonts via `<link>` in `index.html`, with
  preconnect hints. Pinning to Google avoids adding a font npm package
  and matches how MapLibre's stylesheet is loaded today. The system
  stack remains the fallback if the CDN is blocked.
- Locale switched from `en-US` to `en-CA` everywhere that formats
  numbers for display. Thousands and decimal characters are identical
  in English, so this is a no-visual-regression change today but keeps
  future date/currency formatters honest.
- Acres precision dropped from 2 decimals to 1 decimal per the Phase 1
  spec. The old default was implicit; flag if appraisers want it back.
- Loading-state pulse implemented as a single `.skeleton` class on the
  loading element. The class hides text (`color: transparent`) and
  animates a gradient sweep; `prefers-reduced-motion` users see a flat
  shimmer-free placeholder.

### Reusable patterns (lift candidates)

- `web/src/tailwind.css` - Tailwind entry + `@theme` design tokens +
  `.skeleton` pulse. Port verbatim, tweak colours only.
- `web/src/format.js` - number formatters
  (`formatCurrency`, `formatAcres`, `formatAcresWithUnit`,
  `formatSqFt`, `formatSqFtFromAcres`, `formatSqFtWithUnit`,
  `formatPercent`). Pure, no Manitoba assumptions; lift as-is.
- `td(value, className)` helper in `web/src/main.js:5294` (existing,
  unchanged in Phase 1). Maps null/empty to em-dash, accepts a class.
  Useful baseline for both apps.

### Manitoba-specific (do not port)

- `web/src/main.js` formatter wrappers `formatGroupPpa`,
  `formatGroupPpsf`, `formatGroupPpl`, `formatSaleToAsmt` -
  sales-CSV-specific. Winnipeg sales analysis will likely re-use the
  shape but pull from a different upload schema. Lift the call shape,
  re-bind the field names.

### Dependencies added

- `tailwindcss` `^4.3.0` (devDependency)
- `@tailwindcss/vite` `^4.3.0` (devDependency)

### Gotchas

- `main.js` already had a local `function formatCurrency(s)` that
  parses strings. The new module export collides on the name, so the
  import is aliased: `import { formatCurrency as fmtCurrency } from
  './format.js'`. The local function now delegates to `fmtCurrency`
  after running its string parser. Watch for the same collision in
  the Winnipeg port.
- Tailwind v4 with the Vite plugin requires the CSS file to be
  imported from a JS module (`import './tailwind.css'` from
  `main.js`); a bare `<link rel="stylesheet" href="./src/tailwind.css">`
  in `index.html` is not enough because Vite needs to process the
  file. Leaving the link tag in place would 404 against the source
  path.
- esbuild advisory (GHSA-67mh-4wv8-2f99) surfaced after install. It is
  a dev-server-only CORS issue, not relevant to production. Fix
  requires Vite 8 which is a breaking upgrade; defer.

### Phase 1 porting checklist (Winnipeg)

- Tailwind entry + `@theme` tokens: reuse as-is.
- Inter font preconnect + link in `index.html`: reuse.
- Number formatters (`format.js`): reuse.
- Skeleton pulse class: reuse.
- Header colour swap (teal -> slate): apply if the Winnipeg app's
  header is also branded teal/navy and you want the tone match.

## Phase 2 - Layout restructure

### Decisions

- App shell switched from CSS grid (`350px 1fr`) to flex. On md+
  (>=768 px) the shell is `flex-direction: row` with the sidebar
  capped at `flex: 0 0 35%`; below md it stacks vertically. The same
  markup serves both layouts.
- Right pane (`.workspace`) is a vertical flex column: map on top,
  draggable divider, table on bottom. The split is expressed as a
  single CSS custom property `--map-pane-height` (default 60%) that
  `layout.js` updates on drag and arrow-key nudges. CSS rules read
  the variable for the map's flex-basis and height, so the JS only
  needs to update one value.
- Sticky topbar replaces the old `<header>`. The "Data sources"
  details element opens a 640-px-wide panel positioned absolute
  below the topbar so it doesn't push the app shell down. Disclaimer,
  About blurb, and data-refresh row all moved into that panel.
- The map's `aspect-ratio: 16/9` rule still applies in the stacked
  layout (below md). At md+ it's neutralised so the flex split
  governs the map's height. Stacked mode is what a mobile pass will
  hit, where 16:9 reads better than a fixed-height pane.
- Draggable handle uses pointer events (works for mouse + touch +
  pen) and respects arrow keys / Home / End when focused. While
  dragging, `body.workspace-resizing` disables text selection and
  iframe pointer events so the cursor can't escape the handle.
- MapLibre's WebGL canvas needs a manual `map.resize()` call after
  the container changes size. The workspace emits a custom
  `workspace:resize` event that main.js listens to and forwards to
  MapLibre once `mapReady` resolves.

### Reusable patterns (lift candidates)

- `web/src/layout.js` - workspace resize handle. Pure layout logic,
  no Manitoba assumptions. Lift verbatim; the only contract is that
  the parent workspace element has id `workspace`, the handle has
  id `workspace-resize`, and CSS reads `--map-pane-height`.
- Topbar markup (`.topbar`, `.topbar-nav`, `.topbar-details`,
  `.topbar-panel`) - portable. The link targets and panel content
  are content-only; structure is reusable.
- `.app-shell` / `.workspace` / `.map-pane` / `.table-pane` CSS
  block in `web/src/style.css` - portable. Same naming will work
  in the Winnipeg port.
- The `body.workspace-resizing` pattern for suspending text-selection
  during a drag is a generic UI helper.

### Manitoba-specific (do not port)

- The "Data sources" panel content (About + the geoportal links) is
  Manitoba-specific. Lift the markup shape (h2 + p + data-refresh
  row + disclaimer section), swap the link targets and copy.

### Dependencies added

None.

### Gotchas

- Vite's default build wipes `dist/`. Repo convention (per HANDOFF.md)
  is `npm run build -- --emptyOutDir=false` because `dist/data/`
  contains large pre-built shards. Keep the flag when building
  locally; production builds on Vercel start from a clean dist so
  the flag is fine to omit there.
- The legacy `#results-wrap { padding; overflow-x }` rule had higher
  specificity than the new `.table-pane` class and was overriding
  the md+ split's `overflow: auto`. Removed the rule (kept an empty
  selector so any external CSS targeting it doesn't break).
- The old `<details class="explainer">`, `<footer id="disclaimer">`,
  and `<aside id="data-refresh-footer">` all relocated into the
  topbar panel. Their IDs are preserved so `populateDataRefreshFooter()`
  and the like keep working without a JS change.

### Things visually replaced / removed

- `<header>` (bare element) -> `<header class="topbar">` with title,
  Winnipeg portal link, Data sources details.
- `<div class="layout">` grid container -> `<div class="app-shell">`
  flex container.
- `<main class="main-pane">` -> `<main class="main-pane workspace"
  id="workspace">`.
- `#map` keeps its id; gains `.map-pane` class. The 16:9 aspect-ratio
  applies only in the stacked layout now.
- `#results-wrap` keeps its id; gains `.table-pane` class. Its
  padding+overflow rules now live on the class.
- Trailing `<details class="explainer">`, `<aside id="data-refresh-footer">`,
  and `<footer id="disclaimer">` removed from the bottom of the page
  and reborn inside the topbar's Data sources panel.

### Phase 2 porting checklist (Winnipeg)

- `.app-shell` / `.sidebar` / `.workspace` / `.map-pane` /
  `.table-pane` CSS block: reuse.
- `layout.js` workspace resize: reuse.
- Topbar markup shape: reuse, swap link targets and panel content.
- Map resize wiring (`workspace:resize` -> `map.resize()`): reuse.

## Phase 3 - Tabbed sidebar

### Decisions

- Sidebar split into **two** tab panels by workflow: Property search
  (default) and Sales analysis. Plan originally called for three
  tabs with Map layers as the third, but overlay toggles are
  integral to the search workflow (an appraiser flips zoning / dev
  plan / contamination on while reviewing parcels), so Map layers
  lives as an **always-visible section below the active tab panel**
  instead. The status block (count, unmatched drawer, Export CSV)
  sits below Map layers and is also always visible.
- Tab state persisted to localStorage under `mbps_sidebar_tab_v1`
  so a refresh keeps the user on the tab they were on.
- Successful sales-CSV upload auto-switches to the Sales tab so the
  newly-visible filters land in view immediately, regardless of
  where the user dropped the file.
- Sales upload changed from a button to a drag-and-drop area with a
  cloud icon. The hidden `<input type="file">` keeps its id
  (`sales-upload-input`); the dropzone wraps it, click → picker,
  drop → handler, drag-over lights up the border.
- Map overlays grouped by purpose: Boundaries (parcel boundaries +
  section/township grid), Planning (zoning + dev plan), Risk
  (environmental sites, MASC risk areas, MASC rating, CLI soil),
  Reference (traffic flow), Quick links (muni + PD website).
  Generate Map sits below the groups as the action button.
- Each overlay toggle gets a coloured dot from `--dot-color` set
  inline on the button. Colours are best-guess representatives of
  the map render colour; verify against `map.js` if a particular
  layer's swatch reads wrong.
- Renames applied: Roll Layer -> Parcel boundaries, Sec-Twp Grid ->
  Section/township grid, Zoning Layer -> Zoning, Dev Plan Layer ->
  Development plan, Enviro Sites -> Environmental sites, MASC
  Rating -> MASC rating, CLI Soil -> Soil productivity (CLI),
  Traffic Flow -> Traffic flow, Muni Website -> Muni website, PD
  Website -> PD website. The legacy technical name now lives in
  the button's title attribute (Phase 4 replaces these with info
  icons).
- Legal description + Certificate of title + Zoning category +
  Amendment status + Dwelling-unit filters all moved into a single
  `<details>` "Advanced filters" inside the Property search tab.

### Reusable patterns (lift candidates)

- `web/src/tabs.js` - sidebar tab switcher. `PRIMARY_INPUT_BY_TAB`
  map is the only thing that needs editing per app; the rest is
  generic. Includes arrow-key + Home/End keyboard support.
- `.sidebar-tabs` / `.sidebar-tab` / `.sidebar-tab-panel` CSS:
  portable.
- `.sales-dropzone` CSS + the inline SVG cloud-upload icon: portable.
  The drag/drop wiring in `main.js` is also generic (the only
  app-specific call is `handleSalesUpload`).
- `.overlay-group` / `.overlay-btn` / `.overlay-dot` CSS: portable.
  Each app's overlay list will differ; the styling won't.
- The `Advanced filters` `<details>` shape (uppercase summary, soft
  slate hover): portable.

### Manitoba-specific (do not port)

- The overlay button IDs (`muni-parcels-toggle`, `masc-toggle`,
  `cli-toggle`, etc.) are Manitoba-specific layers. The grouping
  shape (Boundaries / Planning / Risk / Reference / Quick links)
  is reusable; the button list inside each group is per-app.
- `--dot-color` values are best-guess representative swatches for
  Manitoba's render colours. Winnipeg's render palette will differ.
- The "Advanced filters" content (zoning category, amendment
  status, DU filters) is Manitoba-driven; the wrapper is reusable.

### Dependencies added

None.

### Gotchas

- The legacy `body.sales-mode .sidebar .search-section { display:
  none; }` rule no longer applies (the Search inputs are in their
  own tab panel now). The `body.sales-mode` class still gates the
  `.sales-only` filter row visibility inside the Sales tab, so it
  remains useful.
- `#sales-upload-btn` no longer exists; main.js now binds to
  `#sales-dropzone`. The hidden `#sales-upload-input` is unchanged.
- Tab panel hiding uses `[hidden]` + `display: none !important`
  because the inline flex layout inside each panel could otherwise
  win the cascade.
- Initial tab activation skips focus (`skipFocus: true`) so the
  muni dropdown doesn't grab focus on page load and steal it from
  the URL/Cmd-K affordance arriving in Phase 7.

### Things visually replaced / removed

- The single big sidebar with two `<h2>` headings (Search, Map
  overlays) and inline sales filters is gone. Replaced by tab
  panels.
- Old `Search` `<h2>` heading removed; the Property search tab is
  itself the label.
- Old `Map overlays` `<h2>` removed; group titles replace it.
- Old `.overlay-grid` 2-column grid replaced by stacked
  `.overlay-group` blocks. The dotted divider `<hr class="overlay-grid-sep">`
  is gone.
- Old `Upload Sales CSV…` button (`#sales-upload-btn`) replaced
  by the dropzone (`#sales-dropzone`).
- Old `.more-filters` details collapsed into the new
  `.advanced-filters` details; old CSS rules remain for any
  defensive code paths but the markup no longer uses `.more-filters`.

### Phase 3 porting checklist (Winnipeg)

- Tab markup + `tabs.js` + tab CSS: reuse. Update
  `PRIMARY_INPUT_BY_TAB` for any renamed primary inputs.
- Sales dropzone markup + CSS + drag/drop wiring: reuse.
- Overlay group structure (Boundaries / Planning / Risk /
  Reference / Quick links): reuse the buckets, swap the buttons.
- Advanced filters `<details>` shape: reuse.
- Plain-language label rename pattern (label + legacy term in
  title attribute): apply to Winnipeg's overlays where their
  internal names diverge from how appraisers describe them.

## Phase 4 - Form controls
_pending_

## Phase 5 - Results table
_pending_

## Phase 6 - Appraisal-specific features
_pending_

## Phase 7 - Status feedback and empty states
_pending_

## Phase 8 - Portability documentation pass
_pending_
