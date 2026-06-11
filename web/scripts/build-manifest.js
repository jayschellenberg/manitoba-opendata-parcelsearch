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
//
// Publish gate: `--validate` compares the freshly-built manifest
// against the previously written one (the deployed baseline) and
// refuses to write when something looks like a broken rebuild —
// vanished datasets, row counts collapsed below 50% of the prior run,
// empty shard registries, unparseable sample shards, or truncated
// files. A failing gate exits nonzero so monthly-refresh.bat aborts
// with the previous data still in place. For the rare legitimate big
// change, rerun with --accept-large-change.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'public', 'data');

const DATASETS = [
  { name: 'legal_index',      file: 'legal-index.json',      hasMetadata: true,  schema_version: 1 },
  { name: 'assessment_index', file: 'assessment-index.json', hasMetadata: true,  schema_version: 1 },
  // Per-municipality assessment shards — registry only; the
  // individual shard files are discovered through assessment/_index.json
  // at runtime, not enumerated in the manifest (avoids re-listing
  // 200+ files on every rebuild).
  { name: 'assessment_shards', file: 'assessment/_index.json', hasMetadata: true, schema_version: 1 },
  { name: 'section_grid',     file: 'section-grid.json',     hasMetadata: false, schema_version: 1 },
  { name: 'river_lots',       file: 'river-lots.json',       hasMetadata: false, schema_version: 1 },
  { name: 'masc_riverlots',   file: 'masc-riverlots.json',   hasMetadata: false, schema_version: 1 },
  { name: 'masc_index',       file: 'masc/_index.json',      hasMetadata: false, schema_version: 1 },
];

// Shard directories: each holds per-municipality JSON files registered
// in a _index.json. The manifest records entry/file counts so the
// --validate gate can spot a collapsed rebuild. New shard datasets are
// one-line additions here.
const SHARD_DIRS = [
  { name: 'assessment',         dir: 'assessment' },
  { name: 'masc',               dir: 'masc' },
  { name: 'parcel_masc',        dir: 'parcel-masc' },
  { name: 'landcover',          dir: 'landcover' },
  // rollentry-snapshot moved to the mb-parcel-data repo (jsDelivr,
  // pinned commit — SNAPSHOT_CDN in web/src/arcgis.js); no longer a
  // local shard dir. First rebuild after the move needs
  // --accept-large-change once.
];

/**
 * Pull the list of shard filenames out of a parsed _index.json. Handles
 * the three shapes in use: `{shards:[{file}]}` (assessment), a flat
 * `{NAME:{file}}` map (masc / parcel-masc / landcover), and
 * rollentry-snapshot's nested `{munis:{NAME:{file}}}`.
 */
function shardIndexEntries(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  if (Array.isArray(parsed.shards)) {
    return parsed.shards.filter((s) => s && typeof s.file === 'string').map((s) => s.file);
  }
  const direct = Object.values(parsed)
    .filter((v) => v && typeof v === 'object' && typeof v.file === 'string')
    .map((v) => v.file);
  if (direct.length) return direct;
  for (const v of Object.values(parsed)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = Object.values(v)
        .filter((x) => x && typeof x === 'object' && typeof x.file === 'string')
        .map((x) => x.file);
      if (nested.length) return nested;
    }
  }
  return [];
}

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

  const shardDirs = {};
  for (const sd of SHARD_DIRS) {
    const dirPath = path.join(DATA_DIR, sd.dir);
    const indexPath = path.join(dirPath, '_index.json');
    if (!fs.existsSync(indexPath)) {
      warnings.push(`${sd.dir}/_index.json not found (run the matching r/build_*.R first)`);
      continue;
    }
    let entries = 0;
    try {
      entries = shardIndexEntries(JSON.parse(fs.readFileSync(indexPath, 'utf8'))).length;
    } catch {
      warnings.push(`${sd.dir}/_index.json failed to parse`);
    }
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json')).length;
    shardDirs[sd.name] = { dir: sd.dir, entries, files };
  }

  return {
    manifest_version: 1,
    generated_at: new Date().toISOString(),
    datasets,
    shard_dirs: shardDirs,
    warnings: warnings.length ? warnings : undefined,
  };
}

/**
 * Publish gate, pure half: compare a freshly-built manifest against the
 * previously deployed one and flag anything that looks like a broken
 * rebuild. No I/O so it's unit-testable. Returns { failures, notes }.
 * `acceptLargeChange` downgrades the delta checks (collapse / vanished
 * dataset) to notes for the rare legitimate big change; structural
 * checks (zero rows, empty registry) always fail.
 */
export function validateManifest(manifest, prev, { acceptLargeChange = false } = {}) {
  const failures = [];
  const notes = [];
  const flag = (msg) => (acceptLargeChange ? notes.push(`${msg} (accepted)`) : failures.push(msg));

  const ds = manifest?.datasets || {};
  const prevDs = prev?.datasets || {};
  for (const [name, entry] of Object.entries(ds)) {
    if (entry.row_count != null && !(Number.isFinite(entry.row_count) && entry.row_count > 0)) {
      failures.push(`${name}: row_count is ${entry.row_count}`);
    }
    const prevCount = prevDs[name]?.row_count;
    if (Number.isFinite(prevCount) && prevCount > 0
        && Number.isFinite(entry.row_count) && entry.row_count < prevCount * 0.5) {
      flag(`${name}: row_count collapsed ${prevCount.toLocaleString()} → ${entry.row_count.toLocaleString()}`);
    }
  }
  for (const name of Object.keys(prevDs)) {
    if (!(name in ds)) flag(`${name}: present in previous manifest, missing now`);
  }

  const sh = manifest?.shard_dirs || {};
  const prevSh = prev?.shard_dirs || {};
  for (const [name, entry] of Object.entries(sh)) {
    if (!(entry.entries > 0)) failures.push(`${name}: shard index lists no shards`);
    if (entry.files < entry.entries) {
      failures.push(`${name}: index lists ${entry.entries} shards but only ${entry.files} .json files on disk`);
    }
    const prevEntries = prevSh[name]?.entries;
    if (Number.isFinite(prevEntries) && prevEntries > 0 && entry.entries < prevEntries * 0.5) {
      flag(`${name}: shard count collapsed ${prevEntries} → ${entry.entries}`);
    }
  }
  for (const name of Object.keys(prevSh)) {
    if (!(name in sh)) flag(`${name}: shard dir present in previous manifest, missing now`);
  }

  return { failures, notes };
}

/**
 * Publish gate, I/O half: cheap structural checks on the actual files.
 * Samples three shards per directory (first / middle / last of the
 * index) for parseability + non-emptiness, and head/tail-checks every
 * manifest-tracked single file so a truncated write can't ship — no
 * full parse of the 40 MB section grid required.
 */
function checkFilesOnDisk(manifest) {
  const failures = [];
  for (const sd of SHARD_DIRS) {
    if (!manifest.shard_dirs?.[sd.name]) continue;
    const dirPath = path.join(DATA_DIR, sd.dir);
    let files = [];
    try {
      files = shardIndexEntries(JSON.parse(fs.readFileSync(path.join(dirPath, '_index.json'), 'utf8')));
    } catch {
      failures.push(`${sd.dir}/_index.json failed to parse`);
      continue;
    }
    const picks = [...new Set([0, Math.floor(files.length / 2), files.length - 1])]
      .map((i) => files[i]).filter(Boolean);
    for (const f of picks) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8'));
        const empty = parsed == null
          || (Array.isArray(parsed) && parsed.length === 0)
          || (typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0);
        if (empty) failures.push(`${sd.dir}/${f}: parsed but empty`);
      } catch (e) {
        failures.push(`${sd.dir}/${f}: ${e.code === 'ENOENT' ? 'listed in index but missing on disk' : 'invalid JSON'}`);
      }
    }
  }
  for (const ds of DATASETS) {
    if (!manifest.datasets?.[ds.name]) continue;
    if (!headTailLooksLikeJson(path.join(DATA_DIR, ds.file))) {
      failures.push(`${ds.file}: head/tail don't look like complete JSON (truncated write?)`);
    }
  }
  return failures;
}

function headTailLooksLikeJson(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 2) return false;
    const head = Buffer.alloc(Math.min(64, size));
    fs.readSync(fd, head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(64, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const first = head.toString('utf8').trimStart()[0];
    const last = tail.toString('utf8').trimEnd().slice(-1);
    return (first === '{' || first === '[') && (last === '}' || last === ']');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function main() {
  const args = process.argv.slice(2);
  const validate = args.includes('--validate');
  const acceptLargeChange = args.includes('--accept-large-change');

  if (!fs.existsSync(DATA_DIR)) {
    console.error(`Data directory not found: ${DATA_DIR}`);
    process.exit(1);
  }
  const outPath = path.join(DATA_DIR, 'manifest.json');

  // The previously written manifest is the validation baseline —
  // read it before overwriting.
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { /* first run */ }

  const manifest = buildManifest();

  if (validate) {
    const { failures, notes } = validateManifest(manifest, prev, { acceptLargeChange });
    failures.push(...checkFilesOnDisk(manifest));
    for (const n of notes) console.log(`  ~ ${n}`);
    if (failures.length) {
      console.error('\nVALIDATION FAILED — manifest NOT written; previous data left in place:');
      for (const f of failures) console.error(`  ✗ ${f}`);
      console.error('\nIf a large change is intentional, rerun with --accept-large-change.');
      process.exit(1);
    }
    console.log('Validation passed.');
  }

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
