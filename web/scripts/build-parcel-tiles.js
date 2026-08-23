// build-parcel-tiles.js — step 2 of the Assessment Parcels tile build.
//
//   RollEntry_*.gpkg
//     -> [r/export_rollentry_geojson.R]  tiles-build/rollentry.geojsons
//     -> [this script]                   parcels.geojsons + parcels-labels.geojsons
//     -> [tippecanoe, via WSL]           parcels.pmtiles
//
// Why Node for this step and not R: the three derived properties the map
// reads — _rollDisplay, _civicAddress, _acres — are defined by JS the app
// already ships (lib/parcelLabelFields.js, lib/acres.js, arcgis.js's
// acresFromFrontageField). Re-deriving them in R would put a second
// implementation of the acreage guard and the civic-address exclusions in
// the tree, and a divergence between the value baked into a tile and the
// value the live FeatureServer path stamps at runtime would sit there for
// a whole rebuild cadence looking like a data problem. Importing the real
// modules is the only way to be sure they agree.
//
// Everything streams. The input is 350 MB / 438k features as
// newline-delimited GeoJSON, so nothing here ever holds more than one
// feature plus the OBJECTID dedupe set.
//
// Usage:
//   node scripts/build-parcel-tiles.js              # write inputs, print the tippecanoe command
//   node scripts/build-parcel-tiles.js --run         # also run tippecanoe via WSL and promote
//   node scripts/build-parcel-tiles.js --limit=5000  # smoke-test on a slice

import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, stat, rename, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import turfArea from '@turf/area';
import { resolveParcelAcres } from '../src/lib/acres.js';
import { rollDisplay, civicAddressOrEmpty } from '../src/lib/parcelLabelFields.js';
import { polygonBboxMidpoint } from '../src/lib/polygonCentroid.js';
import { acresFromFrontageField } from '../src/arcgis.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const buildDir = path.join(webRoot, 'public', 'tiles-build');

const IN_GEOJSONS     = path.join(buildDir, 'rollentry.geojsons');
const EXPORT_META     = path.join(buildDir, 'export-meta.json');
const OUT_POLYGONS    = path.join(buildDir, 'parcels.geojsons');
const OUT_LABELS      = path.join(buildDir, 'parcels-labels.geojsons');
const OUT_PMTILES_TMP = path.join(buildDir, 'parcels.pmtiles');
const OUT_PMTILES     = path.join(webRoot, 'public', 'parcels.pmtiles');
const OUT_META        = path.join(webRoot, 'public', 'parcels-pmtiles-meta.json');

// What actually goes into the tiles. Measured on the first full build:
// properties were 66% of the payload and geometry only 34%, and because a
// feature is stored once per zoom level, z11-16 multiplied that six times
// into a 1.07 GB archive. Carrying all fourteen fields was the whole
// problem — Winnipeg's archive carries seven.
//
// So the tiles now carry only what the map needs to RENDER and FILTER.
// Everything the popup shows beyond the roll number is resolved by
// OBJECTID when a parcel is actually clicked, against the live
// FeatureServer or the per-muni snapshot shard. That is strictly better
// than baking it in: Asmt_Rpt_Url alone was 15% of every feature AND goes
// stale on MAO's Spring/Fall rollover, which reissues every
// extrct_prop_id — a baked copy is wrong within months of any build.
//
//   OBJECTID           identity: the popup lookup key, and promoteId
//   Muni_Name_With_Typ the per-municipality layer filter
//   Roll_No_Txt        the one field hover can show without a round trip
const TILE_POLYGON_PROPS = ['OBJECTID', 'Muni_Name_With_Typ', 'Roll_No_Txt'];

// The label layers read _rollDisplay (text), _acres (the acreage half of
// the text-size ramp) and _civicAddress; Muni_Name_With_Typ is the filter.
// Roll_No_Txt is dropped here even though the layer coalesces to it —
// _rollDisplay is derived from it and is present whenever it was.
const TILE_LABEL_PROPS = ['_rollDisplay', '_acres', '_civicAddress', 'Muni_Name_With_Typ'];

/** Copy just `keys` from `from`, skipping absent ones. */
function pick(from, keys) {
  const out = {};
  for (const k of keys) if (from[k] !== undefined) out[k] = from[k];
  return out;
}

const args = process.argv.slice(2);
const RUN_TIPPECANOE = args.includes('--run');
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? Number(a.slice('--limit='.length)) : Infinity;
})();

// Flag choices follow the Winnipeg archive's (ParcelSearch/r/lib_tippecanoe.R),
// which were settled against a live overlay, with one deliberate difference:
// the zoom floor.
//
//   --minimum-zoom=11    : Winnipeg uses 13 because below that a city lot is
//                          sub-pixel. Manitoba's overlay is municipality-scoped
//                          and a whole RM only fits on screen around z10-11, so
//                          a floor of 13 would leave the layer blank at exactly
//                          the extent a user lands on after picking a rural muni.
//   --maximum-zoom=16    : rural quarter-sections carry no detail past this, and
//                          MapLibre overzooms the z16 tiles for the urban cores.
//   --simplification=2   : gentle Douglas-Peucker — preserves rectangle corners.
//                          Note the export step deliberately does NOT pre-simplify
//                          (unlike build_rollentry_snapshot.R's 10 m pass), so
//                          this is the only simplification applied.
//   --full-detail=14     : 16384-quantum grid per tile vs the default 4096.
//   --no-feature-limit
//   --no-tile-size-limit : never drop a parcel. A missing parcel in an appraisal
//                          tool is worse than a fat tile.
const TIPPECANOE_FLAGS = [
  '--minimum-zoom=11', '--maximum-zoom=16',
  '--simplification=2', '--full-detail=14',
  '--no-feature-limit', '--no-tile-size-limit', '--force',
];

// Sanity band for the finished archive, checked before it is promoted over
// whatever is live. The floor catches a truncated or empty tile run; the
// ceiling catches runaway growth. Widen deliberately, never reflexively.
const PMTILES_MIN_MB = 40;
const PMTILES_MAX_MB = 400;

/** WSL sees the Windows drives under /mnt/<drive letter>. */
function toWslPath(p) {
  let s = p.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(s)) s = `/mnt/${s[0].toLowerCase()}${s.slice(2)}`;
  return s;
}

/** Write with backpressure — 438k lines will outrun the stream otherwise. */
async function writeLine(stream, line) {
  if (!stream.write(line)) await once(stream, 'drain');
}

async function main() {
  const meta = JSON.parse(await readFile(EXPORT_META, 'utf8')).valueOf();
  console.log(`Input   : ${path.basename(IN_GEOJSONS)} (${meta.features.toLocaleString()} features, ${meta.source_file})`);

  const polyOut = createWriteStream(OUT_POLYGONS);
  const labelOut = createWriteStream(OUT_LABELS);

  const seen = new Set();
  let read = 0, written = 0, dupes = 0, noGeom = 0, labelled = 0, malformed = 0;
  const acresSources = new Map();

  const rl = createInterface({
    input: createReadStream(IN_GEOJSONS, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (read >= LIMIT) break;
    read += 1;

    let f;
    try { f = JSON.parse(line); } catch { malformed += 1; continue; }
    const p = f.properties || {};

    // OBJECTID dedupe, mirroring the v5 pass in arcgis.js's
    // fetchAllParcelsInMunicipality — an upstream duplicate row renders its
    // label multiple times on one polygon (observed on roll 187640 in
    // DE SALABERRY). Same composite fallback when OBJECTID is absent.
    const oid = p.OBJECTID;
    const key = oid != null ? `oid:${oid}` : `roll:${p.Roll_No_Txt || ''}|${p.Property_Address || ''}`;
    if (seen.has(key)) { dupes += 1; continue; }
    seen.add(key);

    if (!f.geometry) { noGeom += 1; continue; }

    // --- derived fields, using the app's own modules -------------------
    const rd = rollDisplay(p.Roll_No_Txt);
    if (rd !== null) p._rollDisplay = rd;
    p._civicAddress = civicAddressOrEmpty(p.Property_Address);

    const rollAcres = acresFromFrontageField(p.Frontage_or_Area);
    let geomAcres = null;
    try {
      const sqm = turfArea(f);
      if (Number.isFinite(sqm) && sqm > 0) geomAcres = sqm / 4046.8564224;
    } catch { /* topology errors — leave geometry out of the decision */ }
    const resolved = resolveParcelAcres(rollAcres, geomAcres);
    if (resolved.acres != null) {
      p._acres = Number(resolved.acres.toFixed(4));
      p._acresSource = resolved.source;
      acresSources.set(resolved.source, (acresSources.get(resolved.source) || 0) + 1);
      if (resolved.rollNominal) {
        p._acresRollNominal = true;
        p._rollNominalAcres = resolved.rollValue;
      }
      if (resolved.areaMismatch) {
        p._acresMismatch = true;
        p._acresVariancePct = resolved.variancePct;
        p._acresGeomValue = resolved.geomValue;
      }
    }

    f.properties = pick(p, TILE_POLYGON_PROPS);
    await writeLine(polyOut, `${JSON.stringify(f)}\n`);
    written += 1;

    // --- the parallel label point --------------------------------------
    // One Point per parcel at its bbox midpoint, carrying only the
    // properties the label layers read. Placing it here at build time is
    // what makes a runtime label builder unnecessary — a tile-clipped
    // polygon cannot place a duplicate label if the label never rode on
    // the polygon layer in the first place.
    const c = polygonBboxMidpoint(f.geometry);
    if (c) {
      const props = pick(p, TILE_LABEL_PROPS);
      await writeLine(labelOut, `${JSON.stringify({
        type: 'Feature', properties: props,
        geometry: { type: 'Point', coordinates: c },
      })}\n`);
      labelled += 1;
    }
  }

  polyOut.end(); labelOut.end();
  await Promise.all([once(polyOut, 'finish'), once(labelOut, 'finish')]);

  console.log(`Read    : ${read.toLocaleString()}`);
  console.log(`Written : ${written.toLocaleString()} polygons, ${labelled.toLocaleString()} label points`);
  console.log(`Dropped : ${dupes.toLocaleString()} duplicate OBJECTIDs, ${noGeom.toLocaleString()} without geometry, ${malformed.toLocaleString()} unparseable`);
  console.log(`Acreage : ${[...acresSources].map(([k, v]) => `${k}=${v.toLocaleString()}`).join(', ')}`);

  // Reconcile against the export's own count. A short read here means the
  // .geojsons was truncated, and a truncated fabric must not become the
  // province's parcel overlay for a whole cadence.
  if (LIMIT === Infinity && read < meta.features) {
    throw new Error(`INCOMPLETE read: ${read} lines < exported ${meta.features} — refusing to build tiles from a partial set.`);
  }

  const tippecanoeArgs = [
    'tippecanoe',
    '-o', toWslPath(OUT_PMTILES_TMP),
    '-L', `parcels:${toWslPath(OUT_POLYGONS)}`,
    '-L', `parcels-labels:${toWslPath(OUT_LABELS)}`,
    ...TIPPECANOE_FLAGS,
  ];

  if (!RUN_TIPPECANOE) {
    console.log('\nTile inputs written. Run tippecanoe with:\n');
    console.log(`  wsl ${tippecanoeArgs.join(' ')}\n`);
    console.log('Or re-run this script with --run to do it and promote the archive.');
    return;
  }

  console.log('\nRunning tippecanoe via WSL...');
  const started = Date.now();
  const res = spawnSync('wsl', tippecanoeArgs, { stdio: 'inherit' });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`tippecanoe exited ${res.status}`);
  const secs = Math.round((Date.now() - started) / 1000);

  const sizeMb = (await stat(OUT_PMTILES_TMP)).size / 1024 ** 2;
  console.log(`\nArchive : ${sizeMb.toFixed(1)} MB in ${secs}s`);
  if (LIMIT === Infinity && (sizeMb < PMTILES_MIN_MB || sizeMb > PMTILES_MAX_MB)) {
    throw new Error(
      `Archive is ${sizeMb.toFixed(1)} MB, outside the ${PMTILES_MIN_MB}-${PMTILES_MAX_MB} MB sanity band. ` +
      'Not promoting. Inspect it, then widen the band deliberately if the growth is real.');
  }

  await rename(OUT_PMTILES_TMP, OUT_PMTILES);
  await writeFile(OUT_META, `${JSON.stringify({
    built: new Date().toISOString().slice(0, 10),
    source_file: meta.source_file,
    snapshot_date: meta.snapshot_date,
    features_exported: meta.features,
    features_tiled: written,
    label_points: labelled,
    dropped_duplicates: dupes,
    dropped_no_geometry: noGeom,
    size_mb: Number(sizeMb.toFixed(1)),
    min_zoom: 11,
    max_zoom: 16,
    layers: ['parcels', 'parcels-labels'],
  }, null, 2)}\n`);
  console.log(`Promoted: ${OUT_PMTILES}`);
  console.log(`Meta    : ${OUT_META}`);

  // The .geojsons intermediates are ~700 MB combined and reproducible from
  // the gpkg in under a minute. Keeping them would put that in Dropbox.
  for (const f of [OUT_POLYGONS, OUT_LABELS, IN_GEOJSONS]) {
    await unlink(f).catch(() => {});
  }
  console.log('Cleaned : removed .geojsons intermediates');
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
