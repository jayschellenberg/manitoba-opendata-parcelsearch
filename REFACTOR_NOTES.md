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
_pending_

## Phase 3 - Tabbed sidebar
_pending_

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
