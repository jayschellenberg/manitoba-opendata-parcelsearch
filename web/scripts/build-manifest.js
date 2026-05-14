#!/usr/bin/env node
// Build web/public/data/manifest.json — a tiny aggregator of metadata
// for every generated data asset. Lets the footer surface "data
// refreshed YYYY-MM-DD" without loading the 136 MB legal-index, and
// lets each client-side data module ask the manifest for a versioned
// url/size/schema instead of hard-coding them.
//
// Run after any of the r/build_*.R scripts that emit web/public/data
// content. Wired into the npm "manifest" script; safe to invoke any
// time — re-reads every file from disk, so stale entries get
// refreshed automatically.
//
// Metadata extraction strategy: legal-index and assessment-index put
// their metadata block within the first 4 KB of the file (the JSON is
// structured `{version, fields, metadata, rows: [...] }`). We read
// just that header, brace-balance to the end of the block, and
// JSON.parse the slice. Avoids loading the multi-hundred-MB rows
// arrays — extraction completes in milliseconds even on the legal
// index.
//
// Other datasets (section-grid, river-lots, MASC shards) don't carry
// an embedded metadata block; they get size + mtime only. The
// section-grid + river-lots datasets are stable reference data, so
// mtime is sufficient.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'public', 'data');

const DATASETS = [
  { name: 'legal_index',      file: 'legal-index.json',      hasMetadata: true,  schema_version: 1 },
  { name: 'assessment_index', file: 'assessment-index.json', hasMetadata: true,  schema_version: 1 },
  { name: 'section_grid',     file: 'section-grid.json',     hasMetadata: false, schema_version: 1 },
  { name: 'river_lots',       file: 'river-lots.json',       hasMetadata: false, schema_version: 1 },
  { name: 'masc_riverlots',   file: 'masc-riverlots.json',   hasMetadata: false, schema_version: 1 },
  { name: 'masc_index',       file: 'masc/_index.json',      hasMetadata: false, schema_version: 1 },
];

/**
 * Extract the `metadata` block from the first 4 KB of a JSON file.
 * Returns the parsed metadata object, or null when the file doesn't
 * carry one in its header. Brace-balances to find the end of the
 * block so nested objects parse correctly.
 */
function extractMetadataBlock(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    const text = buf.slice(0, bytesRead).toString('utf8');
    const m = text.match(/"metadata"\s*:\s*\{/);
    if (!m) return null;
    const start = m.index + m[0].length - 1; // points at opening '{'
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function buildManifest() {
  const datasets = {};
  const warnings = [];
  for (const ds of DATASETS) {
    const filePath = path.join(DATA_DIR, ds.file);
    if (!fs.existsSync(filePath)) {
      warnings.push(`${ds.file} not found (run the matching r/build_*.R first)`);
      continue;
    }
    const stat = fs.statSync(filePath);
    const entry = {
      file: ds.file,
      schema_version: ds.schema_version,
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    };
    if (ds.hasMetadata) {
      const meta = extractMetadataBlock(filePath);
      if (meta) Object.assign(entry, meta);
      else warnings.push(`${ds.file} has no extractable metadata block`);
    }
    datasets[ds.name] = entry;
  }
  return {
    manifest_version: 1,
    generated_at: new Date().toISOString(),
    datasets,
    warnings: warnings.length ? warnings : undefined,
  };
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`Data directory not found: ${DATA_DIR}`);
    process.exit(1);
  }
  const manifest = buildManifest();
  const outPath = path.join(DATA_DIR, 'manifest.json');
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`Manifest written to ${outPath}`);
  for (const [name, entry] of Object.entries(manifest.datasets)) {
    const mb = (entry.size_bytes / (1024 * 1024)).toFixed(1);
    const rows = entry.row_count != null ? ` · ${entry.row_count.toLocaleString()} rows` : '';
    console.log(`  ${name.padEnd(20)} ${mb.padStart(6)} MB${rows}`);
  }
  if (manifest.warnings) {
    console.log('\nWarnings:');
    for (const w of manifest.warnings) console.log(`  ! ${w}`);
  }
}

// Run only when invoked directly, not when imported by tests.
// On Windows, process.argv[1] uses backslashes — convert through
// pathToFileURL so the cross-platform comparison works.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

// Exposed for unit tests.
export { extractMetadataBlock, buildManifest, DATA_DIR };
