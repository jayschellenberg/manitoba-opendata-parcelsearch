// Unit tests for the manifest layer:
//   - scripts/build-manifest.js (the Node builder)
//   - src/manifest.js (the client-side reader)
//
// Run: cd web && node test/manifest.test.js
//
// Uses tmp directories so we don't clobber the real manifest. Builder
// tests fabricate small JSON files mimicking the real shape so we can
// validate extractMetadataBlock without needing the 136 MB
// legal-index sitting on disk.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractMetadataBlock, validateManifest, sameExceptGeneratedAt } from '../scripts/build-manifest.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

function withTempFile(suffix, content, fn) {
  const p = path.join(os.tmpdir(), `mb-manifest-test-${Date.now()}-${Math.random()}${suffix}`);
  fs.writeFileSync(p, content);
  try { return fn(p); }
  finally { try { fs.unlinkSync(p); } catch { /* ignore */ } }
}

console.log('manifest builder tests');

await test('extractMetadataBlock — pulls metadata from a small JSON header', () => {
  const payload = '{"version":1,"fields":["a","b"],"metadata":{"generated_at":"2026-01-01T00:00:00Z","row_count":42},"rows":[[1,2]]}';
  withTempFile('.json', payload, (p) => {
    const meta = extractMetadataBlock(p);
    assert.deepEqual(meta, { generated_at: '2026-01-01T00:00:00Z', row_count: 42 });
  });
});

await test('extractMetadataBlock — handles nested metadata objects', () => {
  const payload = '{"version":1,"metadata":{"a":{"b":{"c":1}},"row_count":5},"rows":[]}';
  withTempFile('.json', payload, (p) => {
    const meta = extractMetadataBlock(p);
    assert.deepEqual(meta, { a: { b: { c: 1 } }, row_count: 5 });
  });
});

await test('extractMetadataBlock — returns null when header has no metadata', () => {
  // section-grid.json shape — no metadata field.
  const payload = '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"label":"x"}}]}';
  withTempFile('.json', payload, (p) => {
    assert.equal(extractMetadataBlock(p), null);
  });
});

await test('extractMetadataBlock — works with metadata as third field', () => {
  // Mirrors the real legal-index layout: version, fields, metadata, rows.
  const meta = { generated_at: '2026-05-01T12:00:00Z', row_count: 1234, source: 'foo.parquet' };
  const head = `{"version":1,"fields":["a","b","c"],"metadata":${JSON.stringify(meta)},"rows":[`;
  // Pad with a big rows array to push the file past 4 KB so we're
  // exercising the "only read the header" path.
  const rows = Array.from({ length: 200 }, () => '[1,2,3]').join(',');
  withTempFile('.json', head + rows + ']}', (p) => {
    const got = extractMetadataBlock(p);
    assert.deepEqual(got, meta);
  });
});

await test('extractMetadataBlock — survives a truly large file (only reads header)', () => {
  // Simulate a 1 MB file with metadata in the first KB.
  const meta = { generated_at: '2026-05-01T00:00:00Z', row_count: 9999 };
  const head = `{"version":1,"metadata":${JSON.stringify(meta)},"rows":[`;
  const filler = ('[1,2,3,4,5],'.repeat(60_000)).slice(0, -1);
  withTempFile('.json', head + filler + ']}', (p) => {
    const stat = fs.statSync(p);
    assert.ok(stat.size > 500_000, `expected a big file, got ${stat.size}`);
    const got = extractMetadataBlock(p);
    assert.deepEqual(got, meta);
  });
});

// ---------- Publish-gate tests ----------

console.log('\nvalidateManifest (publish gate) tests');

await test('healthy manifest passes against its predecessor', () => {
  const prev = { datasets: { legal_index: { row_count: 1000 } }, shard_dirs: { masc: { entries: 99, files: 100 } } };
  const next = { datasets: { legal_index: { row_count: 1010 } }, shard_dirs: { masc: { entries: 99, files: 100 } } };
  assert.deepEqual(validateManifest(next, prev).failures, []);
});

await test('first run with no previous manifest passes', () => {
  const next = { datasets: { legal_index: { row_count: 10 } }, shard_dirs: { masc: { entries: 5, files: 6 } } };
  assert.deepEqual(validateManifest(next, null).failures, []);
});

await test('collapsed row_count fails', () => {
  const prev = { datasets: { legal_index: { row_count: 430_000 } } };
  const next = { datasets: { legal_index: { row_count: 31_000 } } };
  const { failures } = validateManifest(next, prev);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /collapsed/);
});

await test('--accept-large-change downgrades delta failures to notes', () => {
  const prev = { datasets: { legal_index: { row_count: 430_000 } } };
  const next = { datasets: { legal_index: { row_count: 31_000 } } };
  const { failures, notes } = validateManifest(next, prev, { acceptLargeChange: true });
  assert.deepEqual(failures, []);
  assert.equal(notes.length, 1);
});

await test('vanished dataset and empty shard registry fail', () => {
  const prev = { datasets: { legal_index: { row_count: 10 }, assessment_index: { row_count: 5 } } };
  const next = { datasets: { legal_index: { row_count: 10 } }, shard_dirs: { masc: { entries: 0, files: 3 } } };
  const { failures } = validateManifest(next, prev);
  assert.equal(failures.length, 2);
});

await test('zero row_count fails even with the accept flag (structural)', () => {
  const next = { datasets: { legal_index: { row_count: 0 } } };
  const { failures } = validateManifest(next, null, { acceptLargeChange: true });
  assert.equal(failures.length, 1);
});

await test('index listing more shards than files on disk fails', () => {
  const next = { datasets: {}, shard_dirs: { landcover: { entries: 150, files: 80 } } };
  const { failures } = validateManifest(next, null);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /150 shards but only 80/);
});

// ---------- Client-side manifest.js tests ----------

console.log('\nmanifest.js (client) tests');

await test('manifest.js — getManifest fetches and caches', async () => {
  // Shim fetch to return a tiny manifest.
  const fakeManifest = {
    manifest_version: 1,
    generated_at: '2026-05-12T00:00:00Z',
    datasets: {
      legal_index: { file: 'legal-index.json', row_count: 100, generated_at: '2026-05-05T00:00:00Z' },
      assessment_index: { file: 'assessment-index.json', row_count: 50, generated_at: '2026-05-11T00:00:00Z' },
    },
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: true,
      async json() { return fakeManifest; },
    };
  };

  const mod = await import(`../src/manifest.js?t=${Date.now()}-${Math.random()}`);
  const m1 = await mod.getManifest();
  const m2 = await mod.getManifest();
  assert.equal(calls, 1, 'expected one fetch despite two getManifest calls');
  assert.equal(m1, m2);
  assert.equal(m1.datasets.legal_index.row_count, 100);
});

await test('manifest.js — getDataset resolves by name', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        manifest_version: 1,
        generated_at: '2026-01-01T00:00:00Z',
        datasets: { legal_index: { row_count: 5 } },
      };
    },
  });
  const mod = await import(`../src/manifest.js?t=${Date.now()}-${Math.random()}`);
  const ds = await mod.getDataset('legal_index');
  assert.deepEqual(ds, { row_count: 5 });
  const missing = await mod.getDataset('does-not-exist');
  assert.equal(missing, null);
});

await test('manifest.js — getManifest returns null on fetch failure', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  const mod = await import(`../src/manifest.js?t=${Date.now()}-${Math.random()}`);
  const m = await mod.getManifest();
  assert.equal(m, null);
});

await test('manifest.js — getOverallFreshness picks the newest generated_at', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        manifest_version: 1,
        generated_at: '2026-05-12T00:00:00Z',
        datasets: {
          legal_index:      { generated_at: '2026-04-01T00:00:00Z' },
          assessment_index: { generated_at: '2026-05-09T00:00:00Z' },
          section_grid:     { modified_at:  '2026-03-15T00:00:00Z' },
        },
      };
    },
  });
  const mod = await import(`../src/manifest.js?t=${Date.now()}-${Math.random()}`);
  const latest = await mod.getOverallFreshness();
  assert.equal(latest, '2026-05-09T00:00:00Z');
});

// --- muni-vintage is rewritten only when something other than the clock moved

// WHY. buildMuniVintage() re-derives the file on every manifest build, and the
// ledger it reads changes a few times a year. An unconditional write rewrote
// `generated_at` and nothing else, every run — and auto-publish-indexes.ps1
// stages manifest.json but NOT this file, so the working tree went dirty on
// every scheduled run and stayed that way (Jason, 2026-09-15: five days of a
// one-line diff), while the manifest advertised a fresh modified_at for a file
// nobody had published.

const VINTAGE = {
  version: 1,
  metadata: {
    generated_at: '2026-09-10T16:20:07.124Z',
    source: 'mao-scrape muni_refresh_ledger.csv (assessment cadence, month precision)',
    source_modified: '2026-09-03T05:58:44.045Z',
    precision: 'month',
    row_count: 2,
  },
  rows: [
    { muni_no: '340', name: 'Niverville', region: 'South', last_refreshed: '2026-07', cadence_months: 6 },
    { muni_no: '451', name: 'Steinbach', region: 'South', last_refreshed: '2026-07', cadence_months: 6 },
  ],
};
const asText = (o) => JSON.stringify(o, null, 1) + '\n';
const withClock = (t) => ({ ...VINTAGE, metadata: { ...VINTAGE.metadata, generated_at: t } });

await test('a new build timestamp alone is not a change', () => {
  assert.equal(
    sameExceptGeneratedAt(asText(VINTAGE), withClock('2026-09-15T09:36:02.331Z')),
    true,
    'this is the churn: same rows, same source, five days of clock');
});

await test('anything else IS a change', () => {
  const moved = { ...VINTAGE, metadata: { ...VINTAGE.metadata, source_modified: '2026-09-14T00:00:00.000Z' } };
  assert.equal(sameExceptGeneratedAt(asText(VINTAGE), moved), false,
    'the ledger itself moving must reach the file');
  const rows = { ...VINTAGE, rows: [{ ...VINTAGE.rows[0], last_refreshed: '2027-01' }, VINTAGE.rows[1]] };
  assert.equal(sameExceptGeneratedAt(asText(VINTAGE), rows), false, 'a refreshed muni');
  const count = { ...VINTAGE, metadata: { ...VINTAGE.metadata, row_count: 3 } };
  assert.equal(sameExceptGeneratedAt(asText(VINTAGE), count), false, 'a muni added or dropped');
});

await test('CRLF on disk is not a change either', () => {
  // The file is checked out with CRLF on Windows. A byte comparison would
  // call every file different and rewrite it — reintroducing the churn this
  // exists to stop. The comparison is over the PARSED objects.
  const crlf = asText(VINTAGE).replace(/\n/g, '\r\n');
  assert.equal(sameExceptGeneratedAt(crlf, withClock('2026-09-15T09:36:02.331Z')), true);
});

await test('when in doubt, write', () => {
  assert.equal(sameExceptGeneratedAt(null, VINTAGE), false, 'no file yet');
  assert.equal(sameExceptGeneratedAt('', VINTAGE), false);
  assert.equal(sameExceptGeneratedAt('{ not json', VINTAGE), false, 'a truncated write');
  assert.equal(sameExceptGeneratedAt('{"version":1,"rows":[]}', VINTAGE), false,
    'an older shape with no metadata block');
  assert.equal(sameExceptGeneratedAt(asText(VINTAGE), { version: 1 }), false);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
