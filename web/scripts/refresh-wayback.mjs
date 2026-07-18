#!/usr/bin/env node
/*
 * refresh-wayback.mjs — keep the curated Esri Wayback date list current.
 *
 * Esri only publishes a Wayback release when World Imagery changes
 * SOMEWHERE globally, so the app can't show all ~195 releases (most look
 * identical here). Instead lib/wayback.js carries a hand-curated list of
 * just the dates where imagery changed over Manitoba. This script
 * regenerates that list automatically:
 *
 *   1. Fetch Esri's waybackconfig.json (release number -> date + tile URL).
 *   2. Sample a spread of tiles across the appraisal region (southern +
 *      central MB — the extent Jason curated from).
 *   3. For each tile, walk the releases newest->oldest and resolve each to
 *      its "canonical" release (a Wayback tile request 301-redirects to the
 *      release that actually introduced that tile's imagery; the redirect
 *      target is the dedupe key). Recording the canonical of the newest
 *      unprocessed release, then jumping to the release just older than it,
 *      finds every distinct imagery version at that tile in a handful of
 *      requests.
 *   4. Union the canonical releases across all tiles -> the set of MB
 *      change-dates. Rewrite WAYBACK_VERSIONS in lib/wayback.js (newest
 *      first).
 *
 * Modes:
 *   node refresh-wayback.mjs           # rewrite lib/wayback.js in place
 *   node refresh-wayback.mjs --check   # report only; exit 3 if stale, 0 if current
 *
 * Intended to run on the existing semi-annual (Jan/Jul) job so any new MB
 * imagery ships in the same commit + redeploy. Networked; no deps beyond
 * Node's global fetch.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONFIG_URL =
  'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';
const TILE_BASE =
  'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile';

// Zoom to sample at. High enough to catch town/city-scale captures, low
// enough that a handful of points cover the region.
const SAMPLE_ZOOM = 11;

// Sample points across the southern + central Manitoba appraisal region.
// A grid (for coverage) plus a few city anchors (populated areas change
// most often). Deliberately excludes the far north so the dropdown doesn't
// fill with remote-only capture dates. Denser sampling = fewer missed
// change-dates; the union in main() guarantees a curated date is never
// dropped even if a run happens to miss its area. [lng, lat]
export const MB_SAMPLE_POINTS = (() => {
  const pts = [];
  // Grid over the agricultural south + central band.
  for (let lat = 49.1; lat <= 53.5; lat += 0.6) {
    for (let lng = -101.3; lng <= -95.5; lng += 0.7) {
      pts.push([Number(lng.toFixed(3)), Number(lat.toFixed(3))]);
    }
  }
  // City anchors (may duplicate grid tiles; deduped by tile below).
  pts.push(
    [-97.14, 49.90], // Winnipeg
    [-99.95, 49.85], // Brandon
    [-98.29, 49.97], // Portage la Prairie
    [-96.68, 49.53], // Steinbach
    [-97.94, 49.18], // Winkler
    [-100.05, 51.15], // Dauphin
    [-101.27, 52.11], // Swan River
  );
  return pts;
})();

/** Parse the {date, release} pairs out of a WAYBACK_VERSIONS array literal. */
export function parseVersionsLiteral(literal) {
  const out = [];
  const re = /date:\s*'(\d{4}-\d{2}-\d{2})',\s*release:\s*(\d+)/g;
  let m;
  while ((m = re.exec(literal))) out.push({ date: m[1], release: Number(m[2]) });
  return out;
}

/** Merge detected + existing versions: union by date (existing release
 *  wins for a shared date), sorted newest first. Never drops a date. */
export function mergeVersions(existing, detected) {
  const byDate = new Map();
  for (const v of detected) byDate.set(v.date, v.release);
  for (const v of existing) byDate.set(v.date, v.release); // existing wins
  return [...byDate.entries()]
    .map(([date, release]) => ({ date, release }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Web-Mercator slippy tile for a lng/lat at a zoom. */
export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { z, x, y };
}

/** Parse waybackconfig.json into releases sorted newest date first. */
export function parseReleases(config) {
  const out = [];
  for (const [release, v] of Object.entries(config)) {
    const m = /Wayback (\d{4}-\d{2}-\d{2})/.exec(v?.itemTitle || '');
    if (m) out.push({ release: Number(release), date: m[1] });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out;
}

/** Render the WAYBACK_VERSIONS array literal (2-space indent, newest first). */
export function formatVersionsLiteral(versions) {
  const rows = versions
    .map((v) => `  { date: '${v.date}', release: ${v.release} },`)
    .join('\n');
  return `export const WAYBACK_VERSIONS = [\n${rows}\n];`;
}

/** Resolve a release's tile to the canonical release that owns that tile's
 *  imagery, by reading the final URL after following the redirect. */
async function resolveCanonical(release, tile, fetchImpl = fetch) {
  const url = `${TILE_BASE}/${release}/${tile.z}/${tile.y}/${tile.x}`;
  // Retry a couple of times — a single flaky tile shouldn't fail the whole
  // twice-a-year run. The union in main() means a genuinely-unreachable
  // tile can only cause a MISSED add, never a wrong removal.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(url);
      try { await res.arrayBuffer(); } catch { /* drain */ }
      const m = /\/tile\/(\d+)\//.exec(res.url || url);
      return m ? Number(m[1]) : release;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Distinct imagery versions (canonical release numbers) at one tile,
 *  via the newest->oldest walk. */
async function versionsAtTile(tile, releasesDesc, fetchImpl = fetch) {
  const dateByRelease = new Map(releasesDesc.map((r) => [r.release, r.date]));
  const found = new Set();
  let i = 0;
  while (i < releasesDesc.length) {
    const canon = await resolveCanonical(releasesDesc[i].release, tile, fetchImpl);
    found.add(canon);
    const canonDate = dateByRelease.get(canon) || releasesDesc[i].date;
    // Everything from canonDate up to the current release shares this
    // imagery; jump to the first release strictly older than canonDate.
    let j = i + 1;
    while (j < releasesDesc.length && releasesDesc[j].date >= canonDate) j++;
    i = j;
  }
  return found;
}

/** Run tasks with a small concurrency cap. */
async function pool(items, limit, worker) {
  const results = [];
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await worker(items[cur], cur);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Detect the current MB Wayback change-dates. Returns [{date, release}]
 * newest first. `deps` injects fetch for testing.
 */
export async function detectMbVersions(deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const config = deps.config || (await (await fetchImpl(CONFIG_URL)).json());
  const releasesDesc = parseReleases(config);
  const dateByRelease = new Map(releasesDesc.map((r) => [r.release, r.date]));

  // Unique sample tiles.
  const tileKeys = new Map();
  for (const [lng, lat] of MB_SAMPLE_POINTS) {
    const t = lngLatToTile(lng, lat, SAMPLE_ZOOM);
    tileKeys.set(`${t.z}/${t.x}/${t.y}`, t);
  }
  const tiles = [...tileKeys.values()];

  const perTile = await pool(tiles, 6, (t) => versionsAtTile(t, releasesDesc, fetchImpl));

  // Union canonical releases, then dedupe by date (keep the first release
  // seen for a date) and sort newest first.
  const byDate = new Map();
  for (const set of perTile) {
    for (const rel of set) {
      const date = dateByRelease.get(rel);
      if (date && !byDate.has(date)) byDate.set(date, rel);
    }
  }
  return [...byDate.entries()]
    .map(([date, release]) => ({ date, release }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// ---- CLI ----------------------------------------------------------------

async function main() {
  const check = process.argv.includes('--check');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const libPath = path.resolve(here, '../src/lib/wayback.js');

  const source = await readFile(libPath, 'utf8');
  const currentMatch = /export const WAYBACK_VERSIONS = \[[\s\S]*?\];/.exec(source);
  if (!currentMatch) {
    console.error('Could not find WAYBACK_VERSIONS in', libPath);
    process.exit(2);
  }

  const existing = parseVersionsLiteral(currentMatch[0]);
  console.log(`Sampling ${MB_SAMPLE_POINTS.length} MB points at z${SAMPLE_ZOOM}…`);
  const detected = await detectMbVersions();
  console.log(`Detected ${detected.length} MB imagery dates:`);
  for (const v of detected) console.log(`  ${v.date}  (release ${v.release})`);

  // Union — only ever ADD dates, never remove a curated one.
  const merged = mergeVersions(existing, detected);
  const added = merged.filter((m) => !existing.some((e) => e.date === m.date));

  if (added.length === 0) {
    console.log('lib/wayback.js already covers every detected MB date — no change.');
    process.exit(0);
  }

  console.log(`New date(s) to add: ${added.map((a) => a.date).join(', ')}`);

  if (check) {
    console.log('STALE: lib/wayback.js is missing detected MB date(s).');
    process.exit(3);
  }

  const updated = source.replace(currentMatch[0], formatVersionsLiteral(merged));
  await writeFile(libPath, updated);
  console.log(`Updated lib/wayback.js (+${added.length} date(s)).`);
  process.exit(0);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('refresh-wayback failed:', err?.stack || err);
    process.exit(1);
  });
}
