#!/usr/bin/env node
/*
 * Build the per-municipality street lists behind the Street typeahead.
 *
 *   node web/scripts/build-street-index.mjs [--accept-large-change]
 *
 * Reads the Roll Entry snapshot (mb-parcel-data/rollentry-snapshot/, built
 * by r/build_rollentry_snapshot.R just before this in monthly-refresh.bat)
 * and writes mb-parcel-data/streets/<MUNI>.json plus streets/_index.json.
 * The parsing lives in web/src/lib/streetIndex.js so the app and this
 * build share it; its header explains the rules.
 *
 * Publishing is the usual mb-parcel-data path: auto-publish-indexes.ps1 /
 * update-cdn-pin.ps1 commit + push the data repo and repin
 * MB_PARCEL_DATA_REVISION.
 *
 * Guard: if the new province-wide street count falls below half the
 * previous build's, nothing is written and the script exits 1 — a
 * half-built snapshot must not replace a good list. Pass
 * --accept-large-change for a legitimate big drop.
 *
 * Files are written to a temp name and renamed: overwriting in place under
 * D:\Dropbox can report success and change nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMuniStreets } from '../src/lib/streetIndex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.MB_PARCEL_DATA_ROOT
  || path.resolve(here, '../../../mb-parcel-data');
const SNAP_DIR = path.join(DATA_ROOT, 'rollentry-snapshot');
const OUT_DIR = path.join(DATA_ROOT, 'streets');
const acceptLarge = process.argv.includes('--accept-large-change');

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  if (fs.readFileSync(file, 'utf8') !== text) throw new Error(`write did not land: ${file}`);
}

const snapIndex = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, '_index.json'), 'utf8'));
const munis = {};
const lists = [];
let streets = 0;
for (const [name, entry] of Object.entries(snapIndex.munis || {})) {
  const fc = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, entry.file), 'utf8'));
  const list = buildMuniStreets((fc.features || []).map((f) => f?.properties?.Property_Address));
  // muni_no too: Sales Analysis selects municipalities by number.
  munis[name] = { file: entry.file, count: list.length, muni_no: entry.muni_no ?? null };
  lists.push([entry.file, list]);
  streets += list.length;
}

const prevPath = path.join(OUT_DIR, '_index.json');
if (fs.existsSync(prevPath) && !acceptLarge) {
  const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
  if (prev.streets && streets < prev.streets / 2) {
    console.error(`street count fell from ${prev.streets} to ${streets} — NOT writing (rerun with --accept-large-change if real)`);
    process.exit(1);
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [file, list] of lists) writeAtomic(path.join(OUT_DIR, file), JSON.stringify(list));
writeAtomic(prevPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  snapshot_date: snapIndex.snapshot_date ?? null,
  source: snapIndex.source ?? null,
  streets,
  munis,
}, null, 1));
// A muni dropped from the snapshot leaves no stale file behind.
const keep = new Set(['_index.json', ...lists.map(([f]) => f)]);
for (const f of fs.readdirSync(OUT_DIR)) {
  if (!keep.has(f) && f.endsWith('.json')) fs.unlinkSync(path.join(OUT_DIR, f));
}
console.log(`streets: ${streets} across ${lists.length} munis (snapshot ${snapIndex.snapshot_date}) -> ${OUT_DIR}`);
