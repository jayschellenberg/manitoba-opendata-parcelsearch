/*
 * Parcel Pack: which result parcels share a set of maps.
 *
 * The pack makes three maps per subject. A subject is normally one parcel
 * (or one multi-roll sale, as lib/snapshotGroups.js groups them), but a
 * sliver beside a quarter section is not worth three maps of its own
 * (Jason, 2026-11-12), so the pack's dialog lets any subject be mapped with
 * another. This module holds the two rules behind that dialog:
 *
 *   suggestMerges — which small subjects the dialog pre-selects for merging;
 *   applyMerges   — turn the dialog's choices into the final member lists.
 *
 * Pure (no map / no DOM) so node can exercise it.
 */

import { snapshotBaseName } from './snapshotGroups.js';

/** A subject is "small" when it is at most this share of a neighbour's area. */
export const PACK_SMALL_FRACTION = 0.1;
/** ...and a neighbour is one whose extent is within this many metres. */
export const PACK_NEAR_M = 50;

const M_PER_DEG_LAT = 111320;

/** Gap in metres between two [minX, minY, maxX, maxY] boxes in degrees;
 *  0 when they touch or overlap. Flat-earth, which is exact enough at the
 *  tens-of-metres scale this is used for. */
export function boxGapMeters(a, b) {
  if (!a || !b) return Infinity;
  const midLat = (Math.min(a[1], b[1]) + Math.max(a[3], b[3])) / 2;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]) * mPerDegLon;
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/**
 * The merges the dialog starts with: a subject no bigger than
 * PACK_SMALL_FRACTION of a subject within PACK_NEAR_M of it goes with that
 * one — the largest such neighbour. A suggestion's target is never itself
 * suggested away, so there are no chains to follow.
 *
 * @param {Array<{id: string, acres: number|null, box: number[]|null}>} frames
 * @returns {Map<string, string>} small subject id -> the id it goes with
 */
export function suggestMerges(frames) {
  const ok = (frames || []).filter((f) => Number.isFinite(f.acres) && f.acres > 0 && f.box);
  const out = new Map();
  // Largest first, so a target is settled before anything smaller looks at it.
  const bySize = [...ok].sort((a, b) => b.acres - a.acres);
  for (const small of bySize) {
    let best = null;
    for (const big of bySize) {
      if (big === small || out.has(big.id)) continue;
      if (small.acres > big.acres * PACK_SMALL_FRACTION) continue;
      if (boxGapMeters(small.box, big.box) > PACK_NEAR_M) continue;
      if (!best || big.acres > best.acres) best = big;
    }
    if (best) out.set(small.id, best.id);
  }
  return out;
}

/**
 * The final subjects: each frame's members, with every merged frame's
 * members added to the frame it ends up in. Choices may chain (A with B,
 * B with C puts all three together); a choice that names an unknown frame,
 * itself, or closes a loop is ignored, so the frame keeps its own maps.
 * Order follows `frames`; members follow chain order, root first.
 *
 * @param {Array<{id: string, members: Array}>} frames
 * @param {Map<string, string>|Object} mergeInto — frame id -> target id
 * @returns {Array<Array>} member lists, one per set of maps
 */
export function applyMerges(frames, mergeInto) {
  const list = frames || [];
  const ids = new Set(list.map((f) => f.id));
  const get = (id) => (mergeInto instanceof Map ? mergeInto.get(id) : mergeInto?.[id]);
  const rootOf = (id) => {
    const seen = new Set([id]);
    let cur = id;
    for (;;) {
      const next = get(cur);
      if (!next || !ids.has(next)) return cur;
      if (seen.has(next)) return id; // a loop: this frame stands alone
      seen.add(next);
      cur = next;
    }
  };
  const byRoot = new Map();
  for (const f of list) {
    const root = rootOf(f.id);
    if (!byRoot.has(root)) byRoot.set(root, { own: [], merged: [] });
    (root === f.id ? byRoot.get(root).own : byRoot.get(root).merged).push(...f.members);
  }
  const out = [];
  for (const f of list) {
    const g = byRoot.get(f.id);
    if (g) out.push([...g.own, ...g.merged]);
  }
  return out;
}

/** The file-name stem for one set of maps — the Parcel Snapshots name
 *  without its extension ("610-225600", "24-610-83100_83200-2p"). The
 *  first member names the municipality; rolls are listed lowest first. */
export function packBaseName(members) {
  const sorted = [...(members || [])].sort((a, b) => rollNum(a) - rollNum(b));
  // Keep the root's municipality by leaving it first when rolls tie or fail.
  return snapshotBaseName(sorted.length ? sorted : members, 'x').replace(/\.x$/, '');
}

function rollNum(f) {
  const n = Number(String(f?.properties?.Roll_No_Txt ?? '').trim());
  return Number.isFinite(n) ? n : Infinity;
}

/** Make `name` unique within `used` by adding "-2", "-3", ... */
export function uniqueName(name, used) {
  let out = name;
  for (let i = 2; used.has(out); i++) out = `${name}-${i}`;
  used.add(out);
  return out;
}
