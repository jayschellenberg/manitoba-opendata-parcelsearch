// Per-municipality assessment shards. The full assessment-index is
// ~30 MB / 430K rows; the typical sales-CSV upload only needs the
// 5-50 rows for one or two munis. The R build script (after item #4
// of the architecture review) emits one small JSON file per muni_no
// in the mb-parcel-data repo at assessment/<muni_no>.json plus a
// tiny _index.json listing every shard. This module fetches and
// caches those shards on demand.
//
// Shard-mode is opt-in and degraded-gracefully: when the index is
// missing or unreachable, every caller falls back to the legacy
// full-index path in assessmentIndex.js. So the legacy fetches keep
// working even when shards haven't been built yet.

import { MB_PARCEL_DATA_CDN } from './arcgis.js';

const ASSESSMENT_SHARD_DIR = `${MB_PARCEL_DATA_CDN}/assessment/`;
const ASSESSMENT_SHARD_INDEX_URL = `${ASSESSMENT_SHARD_DIR}_index.json`;

// Lazy: created on first call, never created when shards aren't
// available so we don't pay the fetch on every page load.
let shardIndexPromise = null;
// muni_no → Promise<Map<roll_no_txt, row[]>>. One in-flight fetch
// per muni — concurrent lookupAssessment() calls share it.
const shardCache = new Map();

/**
 * Try to load the shard registry. Returns a Set of muni_no values
 * that have a shard available, or null when the registry is missing
 * (callers should treat null as "shard mode unavailable, fall back").
 */
export async function getShardIndex() {
  if (shardIndexPromise) return shardIndexPromise;
  shardIndexPromise = (async () => {
    try {
      const res = await fetch(ASSESSMENT_SHARD_INDEX_URL);
      if (!res.ok) return null;
      const json = await res.json();
      if (!json || !Array.isArray(json.shards)) return null;
      const available = new Set();
      for (const s of json.shards) {
        if (Number.isFinite(s.muni_no)) available.add(s.muni_no);
      }
      return { available, metadata: json.metadata || null };
    } catch {
      return null;
    }
  })();
  return shardIndexPromise;
}

/**
 * Fetch + parse + key one muni's shard. Returns a `Map<roll_no_txt, row>`
 * or null when the shard 404s. Concurrent calls share the in-flight
 * fetch (one Promise per muni_no).
 */
export function loadShard(muniNo) {
  const key = Number(muniNo);
  if (!Number.isFinite(key)) return Promise.resolve(null);
  if (shardCache.has(key)) return shardCache.get(key);
  const promise = (async () => {
    try {
      const res = await fetch(`${ASSESSMENT_SHARD_DIR}${key}.json`);
      if (!res.ok) return null;
      const json = await res.json();
      if (!json || !Array.isArray(json.rows)) return null;
      const map = new Map();
      for (const row of json.rows) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const roll = String(row[1] || '').trim();
        if (!roll) continue;
        map.set(roll, row);
      }
      return map;
    } catch {
      return null;
    }
  })();
  shardCache.set(key, promise);
  return promise;
}

/**
 * Eager-fetch every shard for the supplied muni list. Used by the
 * sales-CSV upload to warm the per-muni caches up front so each
 * subsequent lookupAssessment is an in-memory hit. Best-effort —
 * shards that 404 are silently skipped.
 */
export async function prefetchShards(muniNos = []) {
  const idx = await getShardIndex();
  if (!idx) return;
  const wanted = [];
  for (const m of muniNos) {
    const n = Number(m);
    if (Number.isFinite(n) && idx.available.has(n)) wanted.push(n);
  }
  await Promise.all(wanted.map((m) => loadShard(m)));
}

/**
 * Look up a single (muni_no, roll_no_txt) tuple in the shard cache.
 * Returns the packed-row array when found, undefined when the shard
 * for this muni isn't available (caller should fall back to the
 * full-index path), or null when the shard exists but the roll
 * isn't in it.
 */
export async function lookupInShards({ muni_no, roll_no_txt }) {
  const idx = await getShardIndex();
  if (!idx) return undefined; // shard mode unavailable
  const muni = Number(muni_no);
  if (!Number.isFinite(muni)) return undefined;
  if (!idx.available.has(muni)) return null; // shard mode active but no shard for this muni
  const shard = await loadShard(muni);
  if (!shard) return null;
  const roll = String(roll_no_txt || '').trim();
  return shard.get(roll) || null;
}

// Test-only reset.
export function _resetShards() {
  shardIndexPromise = null;
  shardCache.clear();
}
