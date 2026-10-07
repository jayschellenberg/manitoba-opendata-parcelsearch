# Winnipeg port: map fits the screen + Capture Map panel

Built in Manitoba Parcel Search on 2026-10-07 (Jason). This doc is the recipe
for doing the same in the Winnipeg app (`D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`).
The MB PR is the reference implementation. Diff it rather than retyping from
this page.

## What Jason asked for

1. **The map always fits on a laptop screen, with room for 5 grid rows below it.**
2. **The map's shape is 1950 × 1050** (6.5 × 3.5 in at 300 dpi, same as the Sales
   Charts PNGs), so what you see is what gets captured.
3. **One capture button** replaces "Current Map View" / "Map w/Legend". It opens
   a panel with a preview, an **Include legend** tick box, **Copy image**,
   **Download PNG** and **Download JPG (smaller)**.
4. **Alt+C** copies the current view straight to the clipboard, with no panel.

## Part 1: map size (CSS only)

MB `web/src/style.css`:

- `.map-pane` base rule: `aspect-ratio: 1950 / 1050;` (was `16 / 9`).
- The later `.map-pane` override (the visual-refresh block, `max-width: 100%`
  in MB) becomes:

```css
--map-table-reserve: 300px;
max-width: min(100%, calc((100dvh - var(--topbar-height, 52px) - var(--map-table-reserve)) * 1950 / 1050));
```

The WIDTH is capped, not the height, so the shape never changes. The 300 px
reserve was **measured in MB**: table-pane padding + toolbar 76 px, header
31 px, 5 × 34 px rows (cells are `white-space: nowrap`, so a row is always
34 px), plus the grid's horizontal scrollbar.

**Winnipeg differences to check:**
- Winnipeg's base `.map-pane` is at style.css ~266 (`max-width: min(1280px, 100%)`,
  `aspect-ratio: 16 / 9`), and there is a second `.map-pane` rule ~2747. Find
  which rule actually sets the live `max-width`. Put the formula there, after
  any rule that would override it.
- Re-measure the reserve. Inject 5 rows into `#results tbody` and measure, or
  run a real search, then read the toolbar/thead/row heights in the browser.
  Winnipeg's toolbar may differ. `#results td` has the same 7px 10px padding.
- Check `--topbar-height` is defined in Winnipeg (it is referenced with a 56px
  fallback, so check the real topbar height and use that as the fallback).
- Leave `.workspace.map-expanded` and the `body.phone` rules alone. They
  already override `max-width` / `aspect-ratio`.
- The 320px `min-height` stays. Below a ~670 px window the map sits at that
  floor and the 5th row slips below the fold (accepted in MB).

Verified in MB: at 1920×950 the map is 1111×598; at 1536×730 it is 702×378.
5 rows plus the scrollbar fit in both.

## Part 2: Capture Map panel (main.js / index.html / style.css)

### The core idea: fixed export size via pixel ratio

`generateStaticMap()` no longer captures at screen size. It:

1. Computes the CSS width of the 1950:1050 window inside the map canvas
   (`min(cssW, cssH * 1950/1050)`). That equals the full canvas unless the map
   is expanded or on a phone.
2. `map.setPixelRatio(Math.max(prevRatio, 1950 / cropCssW))`, then
   `map.triggerRepaint()`. MapLibre redraws with labels and line widths
   scaled, so the image looks like the screen, just sharper. Do NOT upscale
   the bitmap instead.
3. `await waitForMapIdle(map, STATIC_MAP_IDLE_TIMEOUT_MS)` (bounded; a timeout
   captures the current frame and the panel shows a "still loading" note).
4. `drawImage`s the centre 1950:1050 crop into a 1950 × 1050 canvas, the
   "frame".
5. **`finally`: `map.setPixelRatio(prevRatio)`**, clears `captureInFlight`, and
   restores the button. If the ratio is left raised, the live map renders at
   export resolution for the rest of the session.

It resolves `{ frame, staleFrame }`. `composeWithAttribution(frame, { withLegend })`
now takes that frame and returns a canvas. It no longer downscales or encodes,
and no longer reads a `captureWithLegend` global. Winnipeg's
`composeWithAttribution` already takes `{ withLegend }`, which is closer than
MB was.

### Panel + wiring (MB main.js)

New functions, all near `generateStaticMap`: `captureLegendWanted`,
`composedCapture`, `canvasToBlob`, `refreshCapturePreview`, `openCapturePanel`,
`showCaptureError`, `captureFilename`, `flashButton`, `mapToast`,
`wireCapturePanel`, `copyMapToClipboard`. Constants `CAPTURE_W`/`CAPTURE_H`
replace the `captureWithLegend` global, and `captureFrame` holds the last raw
frame so the legend box can recompose without re-shooting the map.

- The button click runs `generateStaticMap().then(openCapturePanel).catch(showCaptureError)`.
- **Clipboard:** pass the Blob **promise** into `new ClipboardItem({ 'image/png': promise })`
  so the write is registered inside the click/keypress's user activation.
  Clipboard images must be PNG.
- **Alt+C** is a branch in the global `document` keydown handler:
  `e.altKey && !ctrl && !meta && !shift && e.code === 'KeyC'`, skipped while any
  `dialog[open]`. **Winnipeg has no global keydown handler** (only per-element
  ones), so add one.
- The legend choice is remembered in localStorage (`mbps.captureLegend`; use a
  Winnipeg-specific key), wrapped in try/catch.
- Download names are `<MUNI>-map-YYYY-MM-DD.png|jpg`. In Winnipeg, use the
  neighbourhood/ward or just `wpg-map-…`, whatever the result set shares.

### Legend box bug to avoid (cost an hour in MB)

`updateLegendAvailability()` runs from the map pane's MutationObserver. A real
mouse click on the tick box fires that observer **between the click and its
`change` event**. Re-ticking from storage on every run therefore silently undid
every untick. A scripted `el.click()` does NOT reproduce it; only a real mouse
click does. Fix: only re-read the tick from storage when availability flips,
or when the panel opens (`updateLegendAvailability({ sync: true })`).

### Markup / CSS

- index.html: the two buttons become one `#static-map-btn` ("📸 Capture Map"
  + `<span class="kbd-hint">Alt+C</span>`). Because the label has a span,
  save and restore the busy label with **`innerHTML`**, not `textContent`.
  The `<dialog id="map-capture-modal">` sits beside the other dialogs.
- Panel buttons reuse MB's `.parcel-list-modal-btn` / `.primary`. Winnipeg
  has no such class (bare `primary`/`secondary` buttons render unstyled in a
  dialog), so copy those rules or use Winnipeg's dialog button class.
- New CSS block at the end of MB style.css: `.map-capture-*` plus
  `.map-capture-toast`. Remove the dead `.generate-map-row` and
  `.generate-map-btn-legend` rules.
- The `#static-map-section` under the table stays: the location-map button
  still renders there.

### Tests

MB `web/test/staticMapIdle.test.js` gained a "capture map panel is wired"
section: ratio restored in `finally`, button → `openCapturePanel`,
`wireCapturePanel()` called, Alt+C → `copyMapToClipboard` → `ClipboardItem`,
and legend box driven by `updateLegendAvailability`. It was proven to fail 4/9
against the old main.js. Winnipeg has no staticMapIdle test, so port the whole
file (its `functionBody` helper now accepts non-async functions). Winnipeg CI
runs `npm run lint` separately; run it locally.

## How it was verified in MB (repeatable)

The in-app Browser pane cannot draw MapLibre, so capture can't be tested
there. Use headless Playwright Chromium with software WebGL:

```
chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
context: { acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] }
```

(Playwright lives in `D:\Dropbox\ClaudeCode\appraisal-process\node_modules`;
load it with `createRequire`.) Checks that passed:
- panel image is 1950×1050 from a 702 px map
- the map canvas buffer is back to its own size afterwards
- Copy and Alt+C both put a 1950×1050 PNG on the clipboard
- PNG is about 1.1 MB and JPG about 0.3 MB
- with zoning on, the legend box enables, the legend draws bottom-right above
  the credit, and unticking gives a different (legend-free) file
- no page errors

**Dev-server trap:** the plain `npm run dev` config hits `EBUSY` renaming
`node_modules/.vite/deps_temp_*` under Dropbox and serves "504 Outdated
Optimize Dep", so the map never initialises. Use the `-tmpcache` launch
config (cacheDir outside Dropbox), or add one for Winnipeg.
