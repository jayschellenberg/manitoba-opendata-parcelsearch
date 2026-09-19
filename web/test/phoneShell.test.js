// The phone shell must be WIRED, not merely present.
//
// WHY THIS EXISTS. This repo's recurring bug is code that exists and is
// never called (see overlayWiring.test.js). The phone shell has four
// parts that only work together: the markup hooks in index.html, the
// lib/phoneMode.js module, the one call to it from main.js, and the
// body.phone rules in style.css. Any one of them can ship alone and
// nothing fails — the desktop layout is untouched and a phone just keeps
// getting the old stacked page. So this test reads all four and asserts
// they name the same ids, the same class names and the same breakpoint.
//
// Comments are stripped before matching so a commented-out call or a
// selector that survives only in prose cannot satisfy a check.
//
// Run: cd web && node test/phoneShell.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');

const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

const main = stripJs(read('src', 'main.js'));
const mode = stripJs(read('src', 'lib', 'phoneMode.js'));
const css = stripCss(read('src', 'style.css'));
const html = stripHtml(read('index.html'));

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

test('main.js imports initPhoneMode from lib/phoneMode.js and calls it', () => {
  assert.match(main, /import\s*\{[^}]*\binitPhoneMode\b[^}]*\}\s*from\s*'\.\/lib\/phoneMode\.js'/,
    'no initPhoneMode import from ./lib/phoneMode.js');
  assert.match(main, /^\s*initPhoneMode\(/m, 'initPhoneMode is imported but never called');
});

test('the mode change resizes the map (the container changes size)', () => {
  const call = main.match(/initPhoneMode\(([\s\S]*?)\);/);
  assert.ok(call, 'initPhoneMode call not found');
  assert.match(call[1], /map\.resize\(\)/, 'initPhoneMode onChange does not call map.resize()');
});

test('a fresh result set brings a peeked sheet back up', () => {
  assert.match(main, /\bensureSheetVisible\b[^;]*from\s*'\.\/lib\/phoneMode\.js'|import\s*\{[^}]*\bensureSheetVisible\b/,
    'ensureSheetVisible not imported');
  const fn = main.slice(main.indexOf('function renderTable('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /ensureSheetVisible\(\)/, 'renderTable never calls ensureSheetVisible()');
});

test('index.html carries every hook phoneMode.js looks up by id', () => {
  for (const id of ['topbar-menu-btn', 'topbar-nav', 'sheet-handle', 'phone-results-slot', 'results-wrap', 'workspace']) {
    assert.ok(html.includes(`id="${id}"`), `index.html has no id="${id}"`);
    assert.ok(mode.includes(`'${id}'`), `phoneMode.js never looks up '${id}'`);
  }
});

test('the menu button controls the nav it toggles', () => {
  const btn = html.match(/<button[^>]*id="topbar-menu-btn"[^>]*>/);
  assert.ok(btn, 'menu button not found');
  assert.match(btn[0], /aria-controls="topbar-nav"/, 'menu button does not aria-control topbar-nav');
  assert.match(btn[0], /aria-expanded="false"/, 'menu button has no aria-expanded');
});

test('the results slot sits inside the sidebar, not the workspace', () => {
  const aside = html.indexOf('<aside class="controls sidebar"');
  const asideEnd = html.indexOf('</aside>', aside);
  const slot = html.indexOf('id="phone-results-slot"');
  assert.ok(aside >= 0 && asideEnd > aside, 'sidebar aside not found');
  assert.ok(slot > aside && slot < asideEnd, 'phone-results-slot is not inside the sidebar');
  const handle = html.indexOf('id="sheet-handle"');
  assert.ok(handle > aside && handle < asideEnd, 'sheet-handle is not inside the sidebar');
});

test('phoneMode.js toggles body.phone and the CSS keys on it', () => {
  assert.match(mode, /classList\.toggle\(\s*'phone'/, "phoneMode.js never toggles the 'phone' body class");
  for (const sel of [
    'body.phone .topbar',
    'body.phone .topbar.menu-open .topbar-nav',
    'body.phone .topbar-menu-btn',
    'body.phone .workspace',
    'body.phone .sidebar',
    'body.phone .sheet-handle',
    'body.phone .phone-results-slot .table-pane',
  ]) {
    assert.ok(css.includes(sel), `style.css has no rule for "${sel}"`);
  }
});

test('every sheet state phoneMode.js can set has a CSS rule', () => {
  const arr = mode.match(/SHEET_STATES\s*=\s*\[([^\]]*)\]/);
  assert.ok(arr, 'SHEET_STATES not found');
  const states = [...arr[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(states.length >= 3, 'fewer than three sheet states');
  for (const s of states) {
    // "half" is the base .sidebar rule; the others must override it.
    if (s === 'half') continue;
    assert.ok(css.includes(`body.phone .sidebar.sheet-${s}`), `no CSS for sheet state "${s}"`);
  }
});

test('the drag gesture is wired, not just written', () => {
  const drag = stripJs(read('src', 'lib', 'sheetDrag.js'));
  assert.match(mode, /import\s*\{[^}]*\binitSheetDrag\b[^}]*\}\s*from\s*'\.\/sheetDrag\.js'/,
    'phoneMode.js does not import initSheetDrag');
  const call = mode.match(/initSheetDrag\(\{([\s\S]*?)\}\)/);
  assert.ok(call, 'phoneMode.js never calls initSheetDrag');
  assert.match(call[1], /measure:\s*measureSnapHeights/, 'drag has no measure()');
  assert.match(call[1], /onSnap:\s*setSheetState/, 'drag has no onSnap()');
  assert.match(call[1], /grabbers:\s*\[handle,\s*tabs\]/, 'drag grabbers are not the handle and tab strip');
  // The classes the gesture toggles must exist in CSS, and the grab
  // surfaces must opt out of browser panning.
  for (const cls of ['sheet-dragging', 'sheet-settling']) {
    assert.ok(drag.includes(`'${cls}'`), `sheetDrag.js never toggles ${cls}`);
    assert.ok(css.includes(`body.phone .sidebar.${cls}`), `style.css has no rule for .${cls}`);
  }
  const touch = css.match(/body\.phone \.sheet-handle,\s*body\.phone \.sidebar-tabs \{[^}]*touch-action: none/);
  assert.ok(touch, 'handle and tab strip lack touch-action: none');
  // Measurement relies on transitions being off under sheet-dragging.
  const rule = css.match(/body\.phone \.sidebar\.sheet-dragging \{([^}]*)\}/);
  assert.match(rule[1], /transition: none/, 'sheet-dragging must switch transitions off');
  assert.match(mode, /classList\.add\('sheet-dragging'\)[\s\S]*offsetHeight/,
    'measureSnapHeights must measure under sheet-dragging');
});

test('the gesture never takes pointer capture, so a tap still clicks the button', () => {
  // Chromium fires the click at the capturing element. Capturing on the
  // tab strip at pointerdown made every tap on a tab button a click on
  // the strip, and no tab ever switched. Moves and the release are heard
  // on window instead.
  const drag = stripJs(read('src', 'lib', 'sheetDrag.js'));
  assert.doesNotMatch(drag, /setPointerCapture/, 'sheetDrag.js must not take pointer capture');
  for (const ev of ['pointermove', 'pointerup', 'pointercancel']) {
    assert.ok(drag.includes(`window.addEventListener('${ev}'`), `${ev} must be listened for on window`);
  }
});

test('result cards are wired: container, observer, phone-mode call, CSS swap', () => {
  const cards = stripJs(read('src', 'lib', 'resultCards.js'));
  assert.match(mode, /import\s*\{[^}]*\binitResultCards\b[^}]*\}\s*from\s*'\.\/resultCards\.js'/,
    'phoneMode.js does not import initResultCards');
  const call = mode.match(/initResultCards\(\{([\s\S]*?)\}\)/);
  assert.ok(call, 'phoneMode.js never calls initResultCards');
  assert.match(call[1], /getElementById\('results'\)/, 'cards are not read from #results');
  assert.match(call[1], /getElementById\('result-cards'\)/, 'cards do not render into #result-cards');
  assert.match(mode, /cards\?\.render\(\)/, 'a phone-mode change never re-renders the cards');
  // The container must sit inside #results-wrap, which is what moves
  // into the sheet.
  const wrap = html.indexOf('id="results-wrap"');
  const slot = html.indexOf('id="result-cards"');
  const table = html.indexOf('id="results"');
  assert.ok(wrap >= 0 && slot > wrap && slot < table, '#result-cards is not inside #results-wrap ahead of the table');
  // The observer is the only thing keeping cards in step with the table.
  assert.match(cards, /new MutationObserver\([\s\S]*?\)\.observe\(table,/, 'resultCards.js does not observe the table');
  assert.match(cards, /tr\.click\(\)/, 'a card tap never forwards to its row (no map fly-to)');
  for (const sel of [
    'body.phone .phone-results-slot .table-scroll',
    'body.phone .phone-results-slot .result-cards',
    'body.phone .phone-results-slot .parcel-summary',
  ]) {
    assert.ok(css.includes(sel), `style.css has no rule for "${sel}"`);
  }
});

test('a parcel tap on the map reaches its card, with a popup fallback', () => {
  const mapSrc = stripJs(read('src', 'map.js'));
  const cards = stripJs(read('src', 'lib', 'resultCards.js'));
  assert.match(mapSrc, /import\s*\{[^}]*\bisPhone\b[^}]*\}\s*from\s*'\.\/lib\/phoneMode\.js'/,
    'map.js does not import isPhone');
  // The gate sits inside the parcel click handler and defers to the
  // popup unless the callback reports the card was found.
  const click = mapSrc.slice(mapSrc.indexOf('const onParcelClick = (e) => {'));
  const body = click.slice(0, click.indexOf('\n      };'));
  assert.match(body, /isPhone\(\)[^\n]*onFeatureClick\(key\) === true/, 'onParcelClick is not gated on the phone card reveal');
  assert.match(body, /parcelClickPopup/, 'the popup fallback is gone from onParcelClick');
  // main.js answers that callback with the card on the phone.
  const scroll = main.slice(main.indexOf('function scrollToRow('));
  const scrollBody = scroll.slice(0, scroll.indexOf('\n}\n'));
  assert.match(scrollBody, /if \(isPhone\(\)\) return revealResultCard\(key\);/, 'scrollToRow does not route to the card on phone');
  assert.match(scrollBody, /return true;/, 'scrollToRow must report success for the popup fallback to work');
  assert.match(mode, /export function revealResultCard\(key\)[\s\S]*cards\.reveal\(key\)/, 'phoneMode.revealResultCard does not use cards.reveal');
  assert.match(cards, /return \{ render: schedule, reveal \}/, 'resultCards does not expose reveal()');
  assert.match(cards, /scrollIntoView\(/, 'reveal never scrolls the card into view');
  // Every hover popup is tagged, and the tag hides it on the phone.
  // A hover popup is one with no close button (the place-search `popup`
  // near the end of map.js has one, and is a click popup).
  const hovers = [...mapSrc.matchAll(/const (\w*[hH]over\w*|popup) = new maplibregl\.Popup\(\{([^}]*)\}/g)]
    .filter((m) => /closeButton: false/.test(m[2]));
  assert.ok(hovers.length >= 6, `expected the hover popups, found ${hovers.length}`);
  for (const m of hovers) {
    assert.match(m[2], /className: 'hover-popup'/, `${m[1]} lacks className: 'hover-popup'`);
  }
  assert.ok(css.includes('body.phone .maplibregl-popup.hover-popup'), 'style.css does not hide .hover-popup on phone');
  assert.ok(css.includes('.result-card.card-highlight'), 'style.css has no card-highlight rule');
});

test('sales mode on the phone: draw tools on the map, star proxy, no-folder import copy', () => {
  const cards = stripJs(read('src', 'lib', 'resultCards.js'));
  const panel = stripJs(read('src', 'lib', 'salesDbPanel.js'));
  // Draw tools: moved into #map by phone mode, shown by CSS only in sales mode.
  assert.match(mode, /function relocateShapeTools\(phone\)[\s\S]*getElementById\('shape-tools'\)[\s\S]*mapEl\.appendChild\(tools\)/,
    'phoneMode.js does not move #shape-tools into the map');
  assert.match(mode, /relocateResults\(phone\);\s*relocateShapeTools\(phone\);/, 'relocateShapeTools is not called from apply()');
  assert.ok(html.includes('id="shape-tools"'), 'index.html has no #shape-tools');
  assert.ok(css.includes('body.phone.sales-mode #map .shape-tools { display: flex; }'), 'CSS never shows the relocated draw tools in sales mode');
  assert.ok(css.includes('body.phone #map .shape-tool-btn'), 'CSS has no phone styling for the draw buttons');
  // Star: the card forwards to the row's button, which owns the Set.
  assert.match(cards, /rowStar\.click\(\)/, 'the card star does not forward to the row star');
  assert.match(cards, /td\.fav-col button\.fav-star/, 'the card star is not read from the row');
  assert.match(main, /className = isFav \? 'fav-star active' : 'fav-star'/, 'main.js no longer renders button.fav-star — update the card proxy');
  assert.ok(css.includes('.result-card-star'), 'CSS has no card star rule');
  // Import: no File System Access -> the button must not promise a folder.
  assert.match(panel, /if \(\$import && !fsAccessSupported\(\)\) \{[\s\S]*Choose export files/, 'salesDbPanel.js keeps "Choose export folder" without File System Access');
  assert.match(panel, /getElementById\('sales-db-nofs-hint'\)/, 'salesDbPanel.js never reveals the no-folder hint');
  assert.ok(html.includes('id="sales-db-nofs-hint"'), 'index.html has no #sales-db-nofs-hint');
});

test('"use my location" is on the map and reuses the parcel click', () => {
  const mapSrc = stripJs(read('src', 'map.js'));
  const locate = stripJs(read('src', 'lib', 'locateControl.js'));
  assert.match(mapSrc, /import\s*\{[^}]*\baddLocateControl\b[^}]*\}\s*from\s*'\.\/lib\/locateControl\.js'/,
    'map.js does not import addLocateControl');
  const call = mapSrc.match(/addLocateControl\(map,\s*\{([\s\S]*?)\}\);/);
  assert.ok(call, 'map.js never calls addLocateControl');
  assert.match(call[1], /hitLayers:\s*\[\.\.\.PARCEL_HIT_LAYERS,\s*'muni-parcels-fill'\]/,
    'the locate control does not hit-test the result parcels first, then the municipality fabric');
  assert.match(call[1], /missText:/, 'a fix on no parcel would be silent');
  // The control opens the parcel by firing the map's own click, so the
  // phone card reveal and every popup keep one code path.
  assert.match(locate, /new MapMouseEvent\('click', map, mouse\)/, 'locateControl.js does not fire a real MapMouseEvent at the fix');
  assert.match(locate, /preventDefault\(\) \{\}/, 'the fallback event lacks preventDefault(), which the draw tools call');
  assert.match(locate, /map\.once\('idle'/, 'the hit test must wait for the fly-to to settle');
  assert.match(locate, /new maplibregl\.GeolocateControl\(/, 'the built-in GeolocateControl is not used');
  assert.ok(css.includes('body.phone .maplibregl-ctrl-group button'), 'phone map control buttons are not thumb-sized');
});

test('the JS breakpoint and the desktop split breakpoint agree', () => {
  const q = mode.match(/PHONE_QUERY\s*=\s*'\(max-width:\s*(\d+)px\)'/);
  assert.ok(q, 'PHONE_QUERY not found');
  const phoneMax = Number(q[1]);
  // The sidebar/workspace row split turns on at min-width: N px — the
  // phone mode must end exactly one pixel below it.
  const split = css.match(/@media \(min-width: (\d+)px\) \{\s*\.app-shell \{\s*flex-direction: row/);
  assert.ok(split, 'desktop split breakpoint not found');
  assert.equal(phoneMax, Number(split[1]) - 1,
    `phone ends at ${phoneMax}px but the desktop split starts at ${split[1]}px`);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
