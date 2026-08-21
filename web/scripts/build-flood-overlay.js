#!/usr/bin/env node
// Build web/public/data/flood/*.geojson — the Flood overlay's display
// geometry, plus _meta.json carrying each group's source and vintage.
//
// Source is the sister MBFloodMapping project, which already fetches the
// authoritative layers (R/refresh_flood_data.R), simplifies them for web
// display (R/simplify_for_web.R) and records provenance per layer in
// web/data/layers.json. This script does no geometry work of its own — it
// merges nine single-purpose files into the five toggle-sized groups defined
// in src/lib/flood.js and stamps each feature with its zone `code` so one
// MapLibre source can colour its members apart.
//
// The group list, file names and zone codes all come from src/lib/flood.js.
// The only knowledge that lives HERE is which upstream file feeds which zone
// — everything the app renders is defined once, in that module.
//
// WHY A BAKED COPY RATHER THAN A FETCH
//
// The production CSP pins connect-src to a fixed allowlist that does not
// include the flood tool's origin, and these are dissolved provincial
// boundaries — nine files, twenty-one features, ~500 KB total, refreshed
// about once a year. A static asset under public/ is served same-origin, is
// versioned with the app, and needs no CDN pin bump. Same call as
// public/mb-municipalities.geojson.
//
// THIS GEOMETRY IS FOR DISPLAY ONLY — DO NOT DERIVE A VERDICT FROM IT.
//
// simplify_for_web.R keeps 3% of the 1-in-200 extent's vertices and 10% of
// the DFA boundaries. That is right for a map at province-to-town zooms and
// wrong for "is this parcel in the DFA", where a boundary parcel would be
// decided by a vertex that was thrown away. The per-parcel Flood Zone column
// is joined at full resolution in r/build_flood.R and shipped as a shard;
// the two answer the same question from different geometry on purpose.
//
// Run: npm run flood:overlay
// Re-run after MBFloodMapping refreshes its data (R/refresh_flood_data.R
// then R/simplify_for_web.R). Not part of the monthly refresh.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { FLOOD_GROUPS } from '../src/lib/flood.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(WEB_ROOT, '..');

// Sister project root. Env-overridable so a clone that keeps the two repos
// somewhere else does not have to edit this file — same contract as the
// roots in r/config.R.
const FLOOD_ROOT = process.env.MBFLOODMAPPING_ROOT
  || resolve(REPO_ROOT, '..', 'MBFloodMapping');
const SRC = join(FLOOD_ROOT, 'web', 'data');
const OUT_DIR = join(WEB_ROOT, 'public', 'data', 'flood');

// Zone code -> upstream file, and which of its properties survive the merge.
// Everything else is dropped: upstream spellings differ between layers
// (NAME vs Name, one with a leading space) and nothing downstream reads
// them. The stamped `code` is the contract.
//
// `Name` is kept for the 1-in-200 extent alone, where it is the study reach
// ("Icelandic River") and the popup should say which one — the other layers
// are single dissolved polygons whose name is already the zone label.
const SOURCE_FOR = {
  RRVDFA: { src: 'dfa_all' },
  LRDFA: { src: 'dfa_lower_red_river' },
  SMA: { src: 'rrv_special_management_area' },
  F200: { src: 'mb_1in200_flood_extent', keep: ['Name'] },
  FL1997: { src: 'red_river_flood_1997' },
  FL2009: { src: 'red_river_flood_2009' },
  FL2011: { src: 'red_river_flood_2011' },
  WWCR: { src: 'wpg_waterway_river_corridor' },
  WWCC: { src: 'wpg_waterway_creek_corridor' },
};

function readFc(name) {
  const path = join(SRC, `${name}.geojson`);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `Cannot read ${path}\n`
      + 'Set MBFLOODMAPPING_ROOT, or run MBFloodMapping\'s R/simplify_for_web.R first.\n'
      + `(${err.message})`,
    );
  }
  const fc = JSON.parse(raw);
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error(`${path} is not a FeatureCollection`);
  }
  return fc;
}

// Provenance, keyed by MBFloodMapping's layer name. Its refresh script
// rewrites this on every pull, so the date here is the date the bytes were
// last FETCHED — which for the MLI-sourced layers (both DFAs and the SMA) is
// not the date the boundary last changed: that source stopped publishing
// updates in February 2022. Read the source-status table in MBFloodMapping's
// README before quoting a vintage to anyone.
const layerMeta = new Map(
  JSON.parse(readFileSync(join(SRC, 'layers.json'), 'utf8'))
    .map((l) => [l.name, l]),
);

mkdirSync(OUT_DIR, { recursive: true });

const meta = { groups: {} };
let totalBytes = 0;
let totalFeatures = 0;

for (const group of FLOOD_GROUPS) {
  const features = [];
  const sources = [];
  let refreshed = null;

  for (const zone of group.zones) {
    const member = SOURCE_FOR[zone.code];
    if (!member) throw new Error(`No upstream file mapped for zone ${zone.code}`);
    const fc = readFc(member.src);
    for (const f of fc.features) {
      if (!f?.geometry) continue;
      const kept = {};
      for (const k of member.keep || []) {
        if (f.properties?.[k] != null) kept[k] = String(f.properties[k]).trim();
      }
      features.push({
        type: 'Feature',
        properties: { ...kept, code: zone.code },
        geometry: f.geometry,
      });
    }
    const m = layerMeta.get(member.src);
    if (m) {
      sources.push({
        code: zone.code, label: m.label, source: m.source, url: m.url, refreshed: m.refreshed,
      });
      // Oldest member wins: a group is only as current as its stalest part.
      if (m.refreshed && (!refreshed || m.refreshed < refreshed)) refreshed = m.refreshed;
    }
  }

  if (features.length === 0) throw new Error(`Group ${group.key} came out empty`);

  const json = JSON.stringify({ type: 'FeatureCollection', features });
  writeFileSync(join(OUT_DIR, group.file), json);
  const bytes = Buffer.byteLength(json);
  totalBytes += bytes;
  totalFeatures += features.length;

  meta.groups[group.key] = {
    file: group.file,
    label: group.label,
    features: features.length,
    refreshed,
    sources,
  };

  console.log(
    `  ${group.key.padEnd(9)} ${String(features.length).padStart(3)} features  `
    + `${String(Math.round(bytes / 1024)).padStart(4)} KB  ${group.file}`,
  );
}

meta.generated_at = new Date().toISOString();
meta.note = 'Display geometry, simplified upstream. Per-parcel verdicts come from '
  + 'the flood shards (r/build_flood.R), which join at full resolution.';
writeFileSync(join(OUT_DIR, '_meta.json'), JSON.stringify(meta, null, 2));

console.log(`\nWrote ${OUT_DIR}`);
console.log(`  ${FLOOD_GROUPS.length} groups, ${totalFeatures} features, ${Math.round(totalBytes / 1024)} KB total`);
