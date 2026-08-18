#!/usr/bin/env node
// Build web/public/mb-places.json — the lookup table behind the map's
// place-search box (find "Souris", get told it sits in SOURIS-GLENWOOD).
//
// Source is the Canadian Geographical Names Database (CGNDB), NRCan's
// official gazetteer, taken as the bulk Manitoba CSV. We keep only the
// populated-place feature types — the other 22K names in the file are
// lakes, rivers and bluffs, which would bury "Souris" the town under
// "Souris River" and "Souris Sand Hills".
//
// Bulk file, not the geogratis query service: that service hard-caps a
// response at 1000 rows and its `start` parameter does not actually
// offset (every page comes back beginning at the same record), so there
// is no way to page the 1,464 unincorporated places out of it. The bulk
// CSV is the same data, complete, and is the form NRCan publishes for
// exactly this purpose.
//
// Why a baked file rather than a runtime call: the production CSP pins
// connect-src to a fixed allowlist that includes neither host, and the
// whole province is only ~2K populated places (~100 KB of JSON, a fifth
// of the municipal boundary file already shipped). A static asset means
// the search is instant, works offline, needs no API key, and cannot be
// rate-limited.
//
// The containing municipality is resolved HERE, at build time, by
// point-in-polygon against public/mb-municipalities.geojson — the same
// boundary file the map already draws. That is the whole point of the
// feature: the answer to "what RM is Souris in?" is precomputed, so the
// client does no geometry work and the result is ready before the user
// finishes typing.
//
// Places in unorganized territory (much of northern Manitoba) legitimately
// fall outside every municipal polygon; they get a null muni and the UI
// renders an em dash. That is a real answer, not a failure.
//
// Run: npm run places
// Re-run only when CGNDB or the boundary file changes — this is stable
// reference data, not part of the monthly refresh.

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB  = join(HERE, '..');
const BOUNDARIES = join(WEB, 'public', 'mb-municipalities.geojson');
const OUT        = join(WEB, 'public', 'mb-places.json');

const ZIP_URL = 'https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/geobase_cgn_toponyme/prov_csv_eng/cgn_mb_csv_eng.zip';

// CGNDB "concise" codes for places people live in. Everything else in the
// gazetteer is physical geography. HAM currently has no Manitoba rows (the
// province files its hamlets under UNP) but is listed so the script keeps
// working if that changes.
const POPULATED = new Set(['CITY', 'TOWN', 'VILG', 'HAM', 'UNP', 'IR']);

// Display label comes from CGNDB's own "Generic Term", which is finer than
// the concise code: the 1,464 UNP rows split into Locality, Community,
// Local Urban District, Northern Community, Railway Point and so on, and
// reserves carry "Indian Reserve" — the legal designation that appears on
// title, which is both the useful term in an appraisal context and the
// distinct label that keeps reserves from reading as ordinary towns.
//
// Rank orders equally-good name matches so the real settlement wins: a
// search for a name held by both a town and a railway point shows the
// town first. Anything unlisted sorts last but is still findable.
const RANK = {
  'City': 1,
  'Town': 2,
  'Village': 3,
  'Hamlet': 4,
  'Local Urban District': 5,
  'Urban Community': 6,
  'Northern Community': 7,
  'Community': 8,
  'Locality': 9,
  'Indian Reserve': 10,
  'Neighbourhood': 11,
  'Industrial Area': 12,
  'Railway Point': 13,
  'Post Office': 14,
};
const RANK_DEFAULT = 15;

// How far outside a municipal polygon a place may sit and still be called
// that municipality's, in km.
//
// CGNDB gives each place ONE reference coordinate, and for the narrow
// lakeshore strips along Lake Winnipeg that point can land just off the
// boundary — Dunnottar's sits ~1 km outside DUNNOTTAR (VILLAGE), which is
// its own incorporated municipality. Reporting "unorganized" there would
// be plainly wrong. Genuinely unorganized places (northern communities,
// most reserves) are tens of kilometres from any municipal boundary, so a
// tolerance this tight cannot reach them by accident. Matches found this
// way are flagged `near` and the UI labels them as nearest-to rather than
// within.
const NEAR_TOLERANCE_KM = 2;

/**
 * Extract the single CSV member from a zip, using only node builtins.
 *
 * Reads the central directory rather than the local file headers: a
 * streamed zip leaves the sizes as zero in the local header and defers
 * them to a trailing data descriptor, so the central directory is the
 * only place the compressed length is reliably recorded.
 */
function unzipSingleCsv(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  let p = buf.readUInt32LE(eocd + 16);            // central directory offset

  while (buf.readUInt32LE(p) === 0x02014b50) {
    const method   = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const fnLen    = buf.readUInt16LE(p + 28);
    const exLen    = buf.readUInt16LE(p + 30);
    const cmLen    = buf.readUInt16LE(p + 32);
    const localAt  = buf.readUInt32LE(p + 42);
    const name     = buf.toString('utf8', p + 46, p + 46 + fnLen);

    if (name.toLowerCase().endsWith('.csv')) {
      // Local header carries its own name/extra lengths, which can differ
      // from the central directory's — always re-read them here.
      const lFnLen = buf.readUInt16LE(localAt + 26);
      const lExLen = buf.readUInt16LE(localAt + 28);
      const start  = localAt + 30 + lFnLen + lExLen;
      const data   = buf.subarray(start, start + compSize);
      return method === 0 ? data : inflateRawSync(data);   // 0 = stored, 8 = deflate
    }
    p += 46 + fnLen + exLen + cmLen;
  }
  throw new Error('no .csv member found in the archive');
}

/** RFC 4180 CSV → array of row arrays. Handles quoted fields and "" escapes. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (text[i + 1] === '"') { field += '"'; i += 1; continue; }
      quoted = false;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** [w,s,e,n] of a GeoJSON geometry, and every vertex, in one walk. */
function bboxAndVertices(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const verts = [];
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
      verts.push(c);
      return;
    }
    for (const part of c) walk(part);
  };
  if (geom?.coordinates) walk(geom.coordinates);
  return { bbox: [w, s, e, n], verts };
}

/** Km between two lon/lat pairs, flat-earth. Fine over a 2 km tolerance. */
function km(lon1, lat1, lon2, lat2) {
  const dy = (lat2 - lat1) * 110.57;
  const dx = (lon2 - lon1) * 111.32 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot(dx, dy);
}

/**
 * Containing municipality for a lon/lat, or the nearest one within
 * NEAR_TOLERANCE_KM, or null in unorganized territory.
 *
 * Linear scan over 183 polygons per place. At ~2K places that is ~360K
 * point-in-polygon tests, which finishes in seconds — not worth a spatial
 * index for a script that runs about once a year. The nearest-polygon
 * fallback only runs for the ~600 places no polygon contains, and its
 * bbox pre-filter leaves a handful of candidates to measure against.
 */
function findMuni(indexed, lon, lat) {
  const pt = { type: 'Point', coordinates: [lon, lat] };
  for (const m of indexed) {
    if (booleanPointInPolygon(pt, m.feature)) return { name: m.name, near: false };
  }

  // Nothing contains it — is it just off the edge of one?
  const padLat = NEAR_TOLERANCE_KM / 110.57;
  const padLon = NEAR_TOLERANCE_KM / (111.32 * Math.cos(lat * Math.PI / 180));
  let best = null, bestKm = Infinity;
  for (const m of indexed) {
    const [w, s, e, n] = m.bbox;
    if (lon < w - padLon || lon > e + padLon || lat < s - padLat || lat > n + padLat) continue;
    for (const v of m.verts) {
      const d = km(lon, lat, v[0], v[1]);
      if (d < bestKm) { bestKm = d; best = m.name; }
    }
  }
  return bestKm <= NEAR_TOLERANCE_KM ? { name: best, near: true } : null;
}

console.log(`Fetching ${ZIP_URL}`);
const res = await fetch(ZIP_URL);
if (!res.ok) throw new Error(`CGNDB bulk download: HTTP ${res.status}`);
const csv = unzipSingleCsv(Buffer.from(await res.arrayBuffer())).toString('utf8');

const table = parseCsv(csv.replace(/^﻿/, ''));
const header = table[0].map((h) => h.trim());
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`CGNDB column "${name}" missing — schema changed: ${header.join(', ')}`);
  return i;
};
const C_NAME = col('Geographical Name');
const C_GEN  = col('Generic Term');
const C_CODE = col('Concise Code');
const C_LAT  = col('Latitude');
const C_LON  = col('Longitude');
console.log(`CGNDB: ${table.length - 1} Manitoba names`);

const boundaries = JSON.parse(readFileSync(BOUNDARIES, 'utf8'));
// Precompute each municipality's bbox and vertex list once, so the
// nearest-polygon fallback doesn't re-walk the geometry per place.
const indexed = (boundaries.features ?? [])
  .filter((f) => f.geometry)
  .map((f) => ({
    feature: f,
    name: f.properties?.MUNI_LIST_NAME_WITH_TYPE ?? null,
    ...bboxAndVertices(f.geometry),
  }));
console.log(`Boundaries: ${indexed.length} municipalities`);

const rows = [];
const seen = new Set();
const byLabel = new Map();
let unorganized = 0;
let near = 0;

for (let i = 1; i < table.length; i += 1) {
  const r = table[i];
  if (!r || r.length < header.length) continue;
  if (!POPULATED.has(r[C_CODE])) continue;

  const name = r[C_NAME].trim();
  const lat  = Number(r[C_LAT]);
  const lon  = Number(r[C_LON]);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

  // CGNDB carries alternate spellings of one feature at identical
  // coordinates. Key on name + rounded position so we keep a single row.
  const key = `${name.toUpperCase()}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const label = r[C_GEN].trim() || r[C_CODE];
  const muni = findMuni(indexed, lon, lat);
  if (!muni) unorganized += 1;
  else if (muni.near) near += 1;

  byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
  rows.push([
    name,
    label,
    RANK[label] ?? RANK_DEFAULT,
    Number(lat.toFixed(5)),
    Number(lon.toFixed(5)),
    muni?.name ?? null,
    muni?.near ? 1 : 0,
  ]);
}

// Sorted by rank then name: makes the asset diffable and gives a sane
// order to equally-good matches. The client re-ranks by match quality.
rows.sort((a, b) => (a[2] - b[2]) || a[0].localeCompare(b[0]));

const payload = {
  version: 1,
  fields: ['name', 'type', 'rank', 'lat', 'lon', 'muni', 'near'],
  metadata: {
    generated: new Date().toISOString().slice(0, 10),
    source: 'Canadian Geographical Names Database (NRCan) — Manitoba bulk CSV',
    source_url: ZIP_URL,
    muni_source: 'public/mb-municipalities.geojson (point-in-polygon, build time)',
    near_tolerance_km: NEAR_TOLERANCE_KM,
    concise_codes: [...POPULATED].join(', '),
    count: rows.length,
    unorganized,
    near,
  },
  rows,
};

const json = JSON.stringify(payload);
writeFileSync(OUT, json);

for (const [label, n] of [...byLabel].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${label}`);
}
console.log(`\nWrote ${OUT}`);
console.log(`  ${rows.length} places, ${near} matched to a nearby boundary, ${unorganized} in unorganized territory, ${Math.round(Buffer.byteLength(json) / 1024)} KB`);
