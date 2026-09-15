// Every HTML page must be a build entry, and the Data Sources panel must
// point at one that exists.
//
// WHY THIS EXISTS. Vite builds `index.html` and whatever else is named in
// rollupOptions.input — nothing more. A second page works perfectly in dev,
// where the server hands back every .html file straight off disk, and 404s in
// production, where only the built entries were emitted. charts.html was
// nearly shipped that way (see the note on `input` in vite.config.js); this
// test is what stops the next page repeating it.
//
// It also checks the links out of the app: the Data Sources panel is now a
// short index that sends the reader to data-sources.html for the detail, and
// a dead link there would quietly take the whole data-sources reference with
// it. Anchors are checked too — #disclaimer has to exist on the target page.
//
// Run: cd web && node test/pageEntries.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const viteConfig = fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('html pages are build entries, and the links between them resolve');

/** Every .html file at the web root — these are the pages that must build. */
const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));

/** The `input:` map in vite.config.js, as the filenames it names. */
function buildEntries() {
  const at = viteConfig.indexOf('input: {');
  assert.ok(at >= 0, 'rollupOptions.input is gone from vite.config.js');
  const body = viteConfig.slice(at, viteConfig.indexOf('}', at));
  return [...body.matchAll(/new URL\('\.\/([^']+\.html)'/g)].map((m) => m[1]);
}

test('every page at the web root is a build entry', () => {
  const entries = buildEntries();
  assert.ok(pages.length > 1, 'expected more than one page to guard');
  for (const page of pages) {
    assert.ok(entries.includes(page),
      `${page} is not in vite.config.js rollupOptions.input — it will serve `
      + 'in dev and 404 in production');
  }
});

test('every build entry is a page that exists', () => {
  for (const entry of buildEntries()) {
    assert.ok(fs.existsSync(path.join(root, entry)),
      `vite.config.js names ${entry}, which is not in web/`);
  }
});

test('the Data Sources panel links to a page that exists, at anchors that exist', () => {
  // The panel holds the summary; the reference itself lives on the page it
  // links to, so a broken link here loses the whole account of the data.
  const links = [...index.matchAll(/href="\.\/([A-Za-z0-9._-]+\.html)(#[A-Za-z0-9-]+)?"/g)];
  assert.ok(links.length > 0, 'index.html links to no sibling page at all');
  const seen = new Set();
  for (const [, file, hash] of links) {
    const target = path.join(root, file);
    assert.ok(fs.existsSync(target), `index.html links to ${file}, which does not exist`);
    if (!hash) continue;
    const html = fs.readFileSync(target, 'utf8');
    assert.ok(html.includes(`id="${hash.slice(1)}"`),
      `index.html links to ${file}${hash}, but that page has no such id`);
    seen.add(`${file}${hash}`);
  }
  assert.ok(links.some(([, f]) => f === 'data-sources.html'),
    'the Data Sources panel no longer links to data-sources.html');
});

test('the panel summarises rather than restates the reference', () => {
  // The whole point of the split: the 1,000-word account lives on the page,
  // and the panel holds an index of it. Two copies of a paragraph drift.
  const panel = index.slice(
    index.indexOf('<div class="topbar-panel"'),
    index.indexOf('</details>', index.indexOf('<div class="topbar-panel"')),
  );
  const words = panel.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
    .split(/\s+/).filter(Boolean).length;
  assert.ok(words < 260,
    `the Data Sources panel is back up to ${words} words — it is a summary `
    + 'plus the refresh row; detail belongs on data-sources.html');
  // The refresh row is the one live thing in there and must stay put.
  assert.match(panel, /id="data-refresh-footer"/,
    'the data-refresh row is populated by populateDataRefreshFooter() and '
    + 'must stay inside the panel');
  assert.match(panel, /id="data-refresh-list"/);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
