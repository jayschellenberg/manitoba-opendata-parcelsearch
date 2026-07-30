// Unit tests for src/lib/provenance.js — the evidence-export provenance
// record + its CSV-preamble and plain-text renderers.
//
// Run: cd web && node test/provenance.test.js

import assert from 'node:assert/strict';
import {
  buildProvenance,
  provenanceCsvLines,
  provenanceText,
  provenanceWithSkipped,
  EXPORT_DISCLAIMER,
  WATER_RIGHTS_CAVEAT,
} from '../src/lib/provenance.js';

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

const NOW = new Date('2026-06-06T12:34:56Z');

const MANIFEST = {
  manifest_version: 1,
  generated_at: '2026-06-05T00:00:00Z',
  datasets: {
    legal_index:      { schema_version: 1, generated_at: '2026-06-01T00:00:00Z', row_count: 100 },
    assessment_index: { schema_version: 1, generated_at: '2026-06-04T00:00:00Z', row_count: 50 },
    section_grid:     { schema_version: 1, modified_at:  '2026-03-15T00:00:00Z' },
  },
};

console.log('provenance.js tests');

await test('buildProvenance — core fields populated', () => {
  const p = buildProvenance({ rowCount: 7, kind: 'csv', manifest: MANIFEST, now: NOW });
  assert.equal(p.exported_at, '2026-06-06T12:34:56.000Z');
  assert.equal(p.kind, 'csv');
  assert.equal(p.row_count, 7);
  assert.equal(p.app_commit, 'dev'); // no Vite define in node test
  assert.ok(p.live_sources.length >= 1, 'should cite at least one live source');
  assert.ok(p.live_sources.every((s) => /^https:\/\//.test(s.url)), 'sources are https URLs');
  assert.equal(p.disclaimer, EXPORT_DISCLAIMER);
  assert.equal(p.data_refreshed, '2026-06-04T00:00:00Z'); // newest dataset date
});

await test('waterRights off — WALLAS is neither cited nor caveated', () => {
  const p = buildProvenance({ rowCount: 7, now: NOW });
  assert.equal(p.water_rights_caveat, null);
  assert.ok(
    p.live_sources.every((s) => !s.url.includes('web43.gov.mb.ca')),
    'an export that never read WALLAS must not cite it',
  );
  const csv = provenanceCsvLines(p).join('\n');
  assert.ok(!csv.includes('Water rights:'));
  assert.ok(!provenanceText(p).includes('Water rights (WALLAS)'));
});

await test('waterRights on — WALLAS endpoints cited and the lag caveat carried', () => {
  const p = buildProvenance({ rowCount: 7, now: NOW, waterRights: true });
  assert.equal(p.water_rights_caveat, WATER_RIGHTS_CAVEAT);
  // The standing disclaimer must stay byte-identical — the water-rights
  // text is additive, not a rewrite of it.
  assert.equal(p.disclaimer, EXPORT_DISCLAIMER);
  const wallas = p.live_sources.filter((s) => s.url.includes('web43.gov.mb.ca'));
  assert.ok(wallas.length >= 3, 'tile + both water-use layers cited');
  assert.ok(p.live_sources.some((s) => s.url.includes('services.arcgis.com')), 'base sources kept');

  // The lag is the caveat that actually protects a reader, so assert on
  // its substance rather than just its presence.
  assert.match(WATER_RIGHTS_CAVEAT, /LICENSED works only/);
  assert.match(WATER_RIGHTS_CAVEAT, /NOT evidence that\s+land is undrained/);

  const csv = provenanceCsvLines(p).join('\n');
  assert.ok(csv.includes('# Water rights: '));
  for (const s of wallas) assert.ok(csv.includes(s.url), `missing ${s.url}`);
  const txt = provenanceText(p);
  assert.ok(txt.includes('Water rights (WALLAS):'));
});

await test('buildProvenance — no manifest leaves freshness null + datasets empty', () => {
  const p = buildProvenance({ rowCount: 1, manifest: null, now: NOW });
  assert.equal(p.data_refreshed, null);
  assert.deepEqual(p.datasets, []);
});

await test('buildProvenance — historical context normalized when active', () => {
  const p = buildProvenance({
    rowCount: 2,
    now: NOW,
    historical: { active: true, snap: '2025-02-12', layerDates: { roll: '2025-02-12', zoning: '2025-02-22', devplan: null } },
  });
  assert.equal(p.historical.snapshot, '2025-02-12');
  assert.equal(p.historical.layer_dates.zoning, '2025-02-22');
  assert.equal(p.historical.layer_dates.devplan, null);
});

await test('buildProvenance — inactive historical is dropped', () => {
  const p = buildProvenance({ rowCount: 2, now: NOW, historical: { active: false, snap: '2025-02-12' } });
  assert.equal(p.historical, null);
});

await test('provenanceCsvLines — comment block, sources, disclaimer, trailing blank', () => {
  const p = buildProvenance({ rowCount: 7, kind: 'csv', salesMode: true, starredOnly: true, manifest: MANIFEST, now: NOW });
  const lines = provenanceCsvLines(p);
  assert.ok(lines[0].startsWith('# '), 'first line is a comment');
  assert.ok(lines.some((l) => l.includes('Exported (UTC): 2026-06-06T12:34:56.000Z')));
  assert.ok(lines.some((l) => l.includes('commit dev')));
  assert.ok(lines.some((l) => l.includes('Rows: 7') && l.includes('sales comps') && l.includes('starred only')));
  // Every live source URL appears in the preamble.
  for (const s of p.live_sources) assert.ok(lines.some((l) => l.includes(s.url)), `missing ${s.url}`);
  assert.ok(lines.some((l) => l.includes('Local enrichment data refreshed: 2026-06-04T00:00:00Z')));
  assert.ok(lines.some((l) => l.startsWith('# Disclaimer:')));
  assert.equal(lines[lines.length - 1], '', 'ends with a blank separator row');
  // Comment lines never start a data row (all begin with # or are blank).
  assert.ok(lines.every((l) => l === '' || l.startsWith('#')));
});

await test('provenanceCsvLines — historical note present + warns rows are live', () => {
  const p = buildProvenance({
    rowCount: 3,
    now: NOW,
    historical: { active: true, snap: '2025-02-12', layerDates: { roll: '2025-02-12', zoning: null, devplan: null } },
  });
  const lines = provenanceCsvLines(p);
  assert.ok(lines.some((l) => l.includes('Historical overlay was active') && l.includes('2025-02-12')));
  assert.ok(lines.some((l) => l.includes('EXPORTED ROWS are current/live data')));
});

await test('provenanceText — readable block with datasets + imagery + disclaimer', () => {
  const p = buildProvenance({
    rowCount: 12,
    kind: 'parcel-snapshots',
    manifest: MANIFEST,
    imagery: 'Esri World Imagery',
    now: NOW,
  });
  const txt = provenanceText(p);
  assert.ok(txt.includes('evidence export provenance'));
  assert.ok(txt.includes('Export type:     parcel-snapshots'));
  assert.ok(txt.includes('Exported (UTC):  2026-06-06T12:34:56.000Z'));
  assert.ok(txt.includes('Imagery credit:  Esri World Imagery'));
  assert.ok(txt.includes('legal_index'));
  assert.ok(txt.includes('schema v1'));
  assert.ok(txt.includes('Disclaimer:'));
  // Disclaimer text body wrapped into the block.
  assert.ok(txt.includes('Research-grade data'));
});

// ---------- provenanceWithSkipped ----------

console.log('\nprovenanceWithSkipped');

await test('nothing skipped leaves the record untouched', () => {
  assert.equal(provenanceWithSkipped('BASE', []), 'BASE');
  assert.equal(provenanceWithSkipped('BASE', undefined), 'BASE');
});

await test('skipped subjects are named, counted, and explained', () => {
  const txt = provenanceWithSkipped('BASE', ['10-610-225600.jpg', '24-610-83100_83200_85200-6p.jpg']);
  assert.ok(txt.startsWith('BASE'), 'the original record is preserved verbatim');
  assert.ok(txt.includes('Not captured (2):'));
  assert.ok(txt.includes('  - 10-610-225600.jpg'));
  assert.ok(txt.includes('  - 24-610-83100_83200_85200-6p.jpg'));
  // The reason matters as much as the list: a reader must be able to tell a
  // transient imagery gap from a parcel deliberately left out.
  assert.ok(/did not finish loading/.test(txt));
  assert.ok(/re-run the export/.test(txt));
});

await test('the explanation is wrapped, not one long line', () => {
  const txt = provenanceWithSkipped('BASE', ['610-1.jpg']);
  const longest = Math.max(...txt.split('\n').map((l) => l.length));
  assert.ok(longest <= 76, `expected wrapped lines, longest was ${longest}`);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
