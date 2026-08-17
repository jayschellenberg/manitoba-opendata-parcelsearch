// Coverage regression for the Primary Property taxonomy, measured against
// the real MAO archive rather than a handful of fixtures.
//
// WHY THIS IS OPT-IN. It reads the scraped sales archive, which is paid
// subscriber data that never enters this repo (see salesStore.js). So there
// is no fixture to commit: the test finds the archive on disk if it is
// there and skips cleanly if it is not, the same way the ArcGIS integration
// test self-skips. Nothing here is written, uploaded or cached.
//
// WHAT IT CATCHES. MAO adds structure descriptors over time. An unmatched
// one is not lost — it lands in "Other" — but a slow drift into Other makes
// the subcategory filter progressively less useful, silently. This is the
// alarm for that. Run it after a sweep that added municipalities.
//
// Run: cd web && RUN_ARCHIVE_TESTS=1 node test/primaryPropertyCoverage.test.js
//      cd web && RUN_ARCHIVE_TESTS=1 npm test

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forEachCsvRow, tokenizeRows } from '../src/lib/delimitedRows.js';
import { splitStackedCell } from '../src/lib/salesCsvParse.js';
import {
  OTHER_SUBCATEGORY,
  UNCATEGORIZED,
  familyOf,
  inferFamily,
  subcategoryOf,
} from '../src/lib/primaryProperty.js';

const here = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.RUN_ARCHIVE_TESTS) {
  console.log('primaryPropertyCoverage.test.js: skipped (set RUN_ARCHIVE_TESTS=1 to run)');
  process.exit(0);
}

// The scrape's working shards carry snake_case headers; the published
// browser export renames them. Accept either, so this measures whichever
// copy is on the machine.
const COLUMNS = {
  primary: ['primary_property', 'primary property'],
  type:    ['sale_type_label', 'sale_type_effective', 'sale type group', 'sale type group (mao)'],
};

const CANDIDATE_DIRS = [
  path.resolve(here, '../../../mao-scrape/results/sales_search/by_muni'),
  'D:/Dropbox/Appraisal/Web/MAOSales',
];

const dir = CANDIDATE_DIRS.find((d) => existsSync(d));
if (!dir) {
  console.log('primaryPropertyCoverage.test.js: skipped (no sales archive on this machine)');
  process.exit(0);
}

// A sample, not the whole 545k-sale archive: the shapes this measures are
// stable well before then, and a full read is ~40 MB of quote-aware
// tokenizing on every `npm test`.
const SHARD_SAMPLE = 15;

const files = readdirSync(dir)
  .filter((f) => /^muni_\d+\.csv$/i.test(f))
  .sort()
  .slice(0, SHARD_SAMPLE);

if (files.length === 0) {
  console.log(`primaryPropertyCoverage.test.js: skipped (no muni_*.csv in ${dir})`);
  process.exit(0);
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const idxOf = (header, names) => {
  const lower = header.map((h) => String(h || '').trim().toLowerCase());
  for (const n of names) {
    const i = lower.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
};

// Per-family tallies, plus the inference audit.
const seen = new Map();      // family -> {total, other, blank}
let inferOk = 0, inferTotal = 0;
const otherSamples = new Map();   // descriptor -> count
let parcels = 0, missingTypeColumn = 0;

const bump = (family, key) => {
  if (!seen.has(family)) seen.set(family, { total: 0, other: 0, blank: 0 });
  seen.get(family)[key] += 1;
};

for (const file of files) {
  const text = readFileSync(path.join(dir, file), 'utf8');
  const nl = text.indexOf('\n');
  if (nl === -1) continue;
  const header = tokenizeRows(text.slice(0, nl).replace(/\r$/, ''), ',')[0] || [];
  const pi = idxOf(header, COLUMNS.primary);
  const ti = idxOf(header, COLUMNS.type);
  if (pi < 0) continue;              // export vintage without the column
  if (ti < 0) missingTypeColumn += 1;

  forEachCsvRow(text.slice(nl + 1), (rawRow) => {
    const cells = tokenizeRows(rawRow, ',')[0] || [];
    // Per-parcel cells stack on newlines; the sale-level type does not.
    const descs = splitStackedCell(cells[pi] ?? '');
    const type  = ti >= 0 ? String(cells[ti] ?? '').split('\n')[0].trim() : '';
    for (const raw of (descs.length ? descs : [''])) {
      const desc = String(raw).trim();
      parcels += 1;
      const family = familyOf(type, desc);
      bump(family, 'total');
      if (!desc) { bump(family, 'blank'); continue; }
      const sub = subcategoryOf(family, desc);
      if (sub === OTHER_SUBCATEGORY) {
        bump(family, 'other');
        otherSamples.set(desc, (otherSamples.get(desc) || 0) + 1);
      }
      // Inference audit: only meaningful where MAO stated a family for us
      // to be graded against.
      if (type) {
        inferTotal += 1;
        if (inferFamily(desc) === family) inferOk += 1;
      }
    }
    return true;
  });
}

console.log(`\narchive: ${dir}`);
console.log(`sampled ${files.length} shards, ${parcels.toLocaleString()} parcel rows`);
if (missingTypeColumn) console.log(`  (${missingTypeColumn} shard(s) carry no Sale Type Group column)`);

const classified = (family) => {
  const s = seen.get(family);
  if (!s) return null;
  const nonBlank = s.total - s.blank;
  return nonBlank === 0 ? null : (nonBlank - s.other) / nonBlank;
};

console.log('\nsubcategory coverage (share of non-blank descriptors NOT in "Other")');
for (const family of [...seen.keys()].sort()) {
  const s = seen.get(family);
  const c = classified(family);
  console.log(
    `  ${family.padEnd(14)} rows=${String(s.total).padStart(7)}  ` +
    `blank=${String(Math.round(100 * s.blank / s.total)).padStart(3)}%  ` +
    `classified=${c == null ? '   n/a' : `${(100 * c).toFixed(1)}%`}`);
}

test('Residential descriptors classify at 97% or better', () => {
  const c = classified('Residential');
  if (c == null) return;   // sample held no residential structures
  assert.ok(c >= 0.97, `Residential coverage fell to ${(100 * c).toFixed(1)}%`);
});

test('Farm descriptors classify at 95% or better', () => {
  const c = classified('Farm');
  if (c == null) return;
  assert.ok(c >= 0.95, `Farm coverage fell to ${(100 * c).toFixed(1)}%`);
});

test('ICI descriptors classify at 90% or better', () => {
  // A looser bar on purpose. ICI's residue is largely MAO's own catch-alls
  // ("OTHER", "CODE/TYPE NO LONGER USED", "UNIQUE ICI STRUCTURE"), which no
  // string rule can place and which should NOT be chased below ~2%.
  const c = classified('ICI');
  if (c == null) return;
  assert.ok(c >= 0.90, `ICI coverage fell to ${(100 * c).toFixed(1)}%`);
});

test('family inference still agrees with MAO on 99% of descriptors', () => {
  if (inferTotal === 0) return;   // no type column in this sample
  const acc = inferOk / inferTotal;
  console.log(`    inference: ${(100 * acc).toFixed(3)}% of ${inferTotal.toLocaleString()} graded rows`);
  assert.ok(acc >= 0.99, `inference accuracy fell to ${(100 * acc).toFixed(2)}%`);
});

test('nothing is silently uncategorized when MAO stated a type', () => {
  // familyOf() must never answer Uncategorized for a row whose Sale Type
  // Group says Residential/ICI/Farm — that would mean the column parse
  // broke, not that the taxonomy needs another rule.
  const s = seen.get(UNCATEGORIZED);
  if (!s) return;
  const share = s.total / parcels;
  assert.ok(share < 0.02,
    `${(100 * share).toFixed(1)}% of rows landed in ${UNCATEGORIZED} — check the Sale Type Group column`);
});

// The drift report: what an updated archive is asking to have a rule for.
const top = [...otherSamples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
if (top.length) {
  console.log('\nlargest "Other" descriptors (candidates for a new rule):');
  for (const [desc, n] of top) console.log(`  ${String(n).padStart(6)}  ${desc}`);
}

const fails = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length > 0) process.exit(1);
