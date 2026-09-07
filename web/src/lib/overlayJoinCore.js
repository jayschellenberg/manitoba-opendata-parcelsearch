/*
 * The area-weighted parcel↔overlay join, extracted so the main thread
 * and the Web Worker run the SAME code rather than two implementations
 * that could drift apart.
 *
 * Returns overlay INDICES rather than overlay features, which is what
 * makes the worker viable: the result of a 500-parcel join is a few
 * thousand small {i, ratio} records instead of a few megabytes of
 * cloned polygon geometry. The caller maps indices back to its own
 * feature objects, which it still holds.
 *
 * Everything expensive lives here:
 *   - a uniform grid over overlay bboxes (broad phase)
 *   - lazy tiling of the few huge overlay polygons that dominate cost
 *   - turf.intersect for the precise clip
 *
 * See lib/spatialIndex.js for why the grid exists, and tilePolygon
 * below for why tiling stays exact.
 */

import area from '@turf/area';
import bbox from '@turf/bbox';
import intersect from '@turf/intersect';
import { buildBboxIndex, queryBboxIndex, bboxesOverlap, gridCellBboxes } from './spatialIndex.js';

// Vertex count past which an overlay polygon is tiled before use, and
// the size a tile is subdivided down to. Polygons under the threshold
// clip in well under a millisecond; the ones above it dominated the
// join entirely (on Manitoba zoning, two polygons of 2893 and 1199
// vertices took 95% of the time across 514 clips).
const TILE_VERTEX_THRESHOLD = 500;
// Subdivide until a piece is at or under this, or MAX_TILE_DEPTH is
// reached. 800 measured marginally better than 400 — smaller tiles cost
// more to build than they save at query time.
const TILE_TARGET_VERTICES = 800;
// Quadtree depth cap: 4 levels is up to 256 tiles, far past what any
// real polygon needs, and stops a pathological geometry (one that never
// simplifies as it's cut) from subdividing forever.
const MAX_TILE_DEPTH = 4;

// ---- Stacked-blanket correction -------------------------------------------
//
// Manitoba's zoning layer does not always carve its municipality-wide
// background zone around the specific zones inside it. In the RM of
// Woodlands the "RA" — Rural Area Zone — polygon is 117,638 ha of solid
// coverage with the town's RG / MG / CH / GD polygons stacked ON TOP of it,
// not cut out of it. Ranking purely by share of parcel area then reports the
// backdrop: on roll 15650 (9 Ed Peltz Dr) RA covers 100.00% of the parcel and
// the real zone, MG — Industrial General — covers 98.91%, so the app said RA
// while the province's own map said MG (Jason, 2026-09-07).
//
// The correction is deliberately narrow. Among candidates whose share is
// within BLANKET_TIE_EPS of the best, the smallest polygon is promoted — but
// ONLY when the polygon it displaces is at least BLANKET_AREA_RATIO times
// larger, which is the signature of a municipal backdrop rather than of two
// ordinary neighbouring zones.
//
// Measured over the 15 municipalities that publish a stacked blanket
// (2026-09-07): at 100x this corrects 641 parcels, 478 of them in Woodlands
// (12.5% of that RM). Municipalities that merely have two adjacent zones
// meeting on a lot line are untouched — Brandon 0 changes of 17,322
// parcels, Deloraine-Winchester 0 of 2,262, whose tie cases sit at 1.3x-4.8x.
//
// 100x is a judgement line, NOT a gap in the data. About 117 further tie
// cases sit between 6x and 87x — Westlake-Gladstone at 26x, Rockwood at
// 34x, Stanley at 46x, Gimli at 52x, and one Woodlands parcel at 87x. Those
// are mid-sized polygons, not municipal backdrops, and a smaller polygon
// sitting inside a merely-larger one is also what a legitimate overlay
// district looks like — so they are deliberately LEFT ALONE. This fix is
// conservative on purpose and does not claim to catch every stacked case;
// lowering the ratio would catch more of them and start risking the
// base-zone/overlay-district inversion this threshold exists to avoid.
//
// Genuinely split-zoned parcels are untouched too: the shares there differ by
// far more than the epsilon (in Woodlands, 686 stacked parcels sit at a <=1%
// share gap and 121 real splits at >20%, with almost nothing between).

// Share-of-parcel difference within which two overlays are "the same coverage".
const BLANKET_TIE_EPS = 0.02;
// How much bigger the displaced polygon must be before it counts as a blanket.
const BLANKET_AREA_RATIO = 100;

/**
 * Overlay bboxes, grid and tile cache, memoised per overlay FEATURES
 * ARRAY. enrichOverlays reuses the same collection across joins, so
 * recomputing turf.bbox over the whole overlay set each time is waste.
 *
 * Weak keys mean no invalidation logic and no retention once a new
 * search replaces the array. Mutating an array's features in place
 * after a join would serve a stale index, but nothing does that:
 * overlay collections are built by a fetch and thereafter only read.
 */
const overlayCache = new WeakMap();

function countVertices(geometry) {
  if (!geometry || !geometry.coordinates) return 0;
  let n = 0;
  const walk = (c) => {
    if (typeof c[0] === 'number') { n++; return; }
    for (const sub of c) walk(sub);
  };
  walk(geometry.coordinates);
  return n;
}

/** A bbox as a rectangular clip Feature. */
function bboxFeature([x0, y0, x1, y1]) {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
    },
  };
}

/**
 * Tile one huge overlay polygon into smaller pieces, by RECURSIVE
 * QUADRANT SUBDIVISION.
 *
 * The join uses only the AREA of each parcel∩overlay clip, never its
 * geometry, and area is additive over a partition — so summing a
 * parcel's clips against the tiles it touches is the same quantity as
 * one clip against the whole polygon, for a fraction of the work.
 * Measured difference on real data is ~3e-7 relative, floating-point
 * noise from clipping at tile edges.
 *
 * Why recursive rather than a flat N×N lattice, which is what this did
 * first: a flat grid clips the FULL polygon once per cell, so build cost
 * is cells × full-complexity. On Manitoba's development-plan layer,
 * whose largest polygon carries 35,729 vertices, a 6×6 grid meant 36
 * clips of that monster — and measured SLOWER than not tiling at all
 * (39.0 s vs 34.1 s across 984 candidate pairs; a 16×16 grid took
 * 263 s). Subdividing instead clips 4 quadrants of the whole, then 4 of
 * each surviving quarter, so every level works on geometry a quarter the
 * size. Same data, hierarchical: 12.6 s, with identical areas.
 *
 * Recursion stops when a piece is simple enough to clip directly, or at
 * MAX_TILE_DEPTH. Returns null when tiling produced nothing usable, so
 * the caller falls back to clipping the original polygon.
 */
function tilePolygon(feature, featureBbox, depth = 0) {
  const out = [];
  for (const cell of gridCellBboxes(featureBbox, 2)) {
    let piece = null;
    try {
      piece = intersect({ type: 'FeatureCollection', features: [feature, bboxFeature(cell)] });
    } catch { continue; }
    if (!piece) continue;
    let pb;
    try { pb = bbox(piece); } catch { continue; }
    // Only keep descending while a quadrant is still complex enough to
    // be worth another round of clipping.
    if (depth + 1 < MAX_TILE_DEPTH && countVertices(piece.geometry) > TILE_TARGET_VERTICES) {
      const sub = tilePolygon(piece, pb, depth + 1);
      if (sub) { out.push(...sub); continue; }
    }
    out.push({ feature: piece, bbox: pb });
  }
  return out.length > 0 ? out : null;
}

/**
 * Area of parcel ∩ overlay, taking the tiled path for polygons complex
 * enough to be worth it. Tiles are built on FIRST USE and cached, so a
 * big polygon no parcel touches is never tiled at all.
 */
function intersectionArea(parcel, parcelBbox, entry, i) {
  const overlay = entry.features[i];
  let tiles = entry.tiles.get(i);
  if (tiles === undefined) {
    tiles = countVertices(overlay.geometry) >= TILE_VERTEX_THRESHOLD
      ? tilePolygon(overlay, entry.bboxes[i])
      : null;
    entry.tiles.set(i, tiles);
  }
  if (!tiles) {
    let inter;
    try {
      inter = intersect({ type: 'FeatureCollection', features: [parcel, overlay] });
    } catch { return 0; }
    if (!inter) return 0;
    try { return area(inter); } catch { return 0; }
  }
  let total = 0;
  for (const tile of tiles) {
    if (!bboxesOverlap(parcelBbox, tile.bbox)) continue;
    let inter;
    try {
      inter = intersect({ type: 'FeatureCollection', features: [parcel, tile.feature] });
    } catch { continue; }
    if (!inter) continue;
    try { total += area(inter); } catch { /* skip this tile only */ }
  }
  return total;
}

function overlayEntryFor(overlayFeatures) {
  const hit = overlayCache.get(overlayFeatures);
  if (hit) return hit;
  const bboxes = overlayFeatures.map((f) => {
    try { return bbox(f); } catch { return null; }
  });
  const entry = {
    features: overlayFeatures,
    bboxes,
    index: buildBboxIndex(bboxes),
    // overlay index -> tile list, or null for "not worth tiling".
    tiles: new Map(),
    // overlay index -> the polygon's OWN area, filled lazily by
    // overlayArea(). Only the handful of overlays that actually tie for a
    // parcel are ever measured, so this costs nothing on the common path.
    areas: new Map(),
  };
  overlayCache.set(overlayFeatures, entry);
  return entry;
}

/**
 * An overlay polygon's own area in m2, memoised on the entry. NaN when the
 * geometry cannot be measured, which the caller treats as "cannot judge".
 */
function overlayArea(entry, i) {
  const hit = entry.areas.get(i);
  if (hit !== undefined) return hit;
  let a;
  try { a = area(entry.features[i]); } catch { a = NaN; }
  if (!Number.isFinite(a) || a <= 0) a = NaN;
  entry.areas.set(i, a);
  return a;
}

/**
 * Promote the most SPECIFIC of a set of overlays that all cover essentially
 * the same parcel, when the one currently winning is a municipal blanket.
 *
 * `matches` must already be sorted by ratio descending. Mutates in place and
 * returns nothing; a no-op unless the blanket signature is present, which is
 * why every correctly-built municipality is left exactly as it was.
 */
function promoteSpecificOverBlanket(matches, entry) {
  if (matches.length < 2) return;
  const best = matches[0];
  const cutoff = best.ratio - BLANKET_TIE_EPS;
  const bestArea = overlayArea(entry, best.i);
  if (!Number.isFinite(bestArea)) return;

  let winner = -1;
  let winnerArea = bestArea;
  for (let k = 1; k < matches.length; k++) {
    if (matches[k].ratio < cutoff) break;          // sorted: no later one qualifies
    const a = overlayArea(entry, matches[k].i);
    if (!Number.isFinite(a) || a >= winnerArea) continue;
    winner = k;
    winnerArea = a;
  }
  if (winner < 0) return;
  // Only a backdrop, not an ordinary neighbour, gets displaced.
  if (bestArea / winnerArea < BLANKET_AREA_RATIO) return;
  const [promoted] = matches.splice(winner, 1);
  matches.unshift(promoted);
}

/**
 * For each parcel, the top `n` overlays by share of parcel area.
 *
 * Returns a plain array of [parcelObjectId, [{ i, ratio }, …]] entries —
 * structured-cloneable, so it crosses the worker boundary cheaply. `i`
 * indexes into `overlayFeatures`.
 *
 * A parcel with a valid OBJECTID and positive area always gets an entry,
 * even when nothing overlapped it, matching the original behaviour that
 * callers rely on to distinguish "joined, no match" from "not joined".
 */
export function computeTopNMatches(parcelFeatures, overlayFeatures, n = 2) {
  const out = [];
  if (!parcelFeatures?.length || !overlayFeatures?.length) return out;

  const entry = overlayEntryFor(overlayFeatures);
  const { bboxes: overlayBboxes, index: overlayIndex } = entry;

  for (const parcel of parcelFeatures) {
    const oid = parcel.properties?.OBJECTID;
    if (oid == null) continue;
    let parcelBbox;
    let parcelArea;
    try {
      parcelBbox = bbox(parcel);
      parcelArea = area(parcel);
    } catch {
      continue;
    }
    if (!Number.isFinite(parcelArea) || parcelArea <= 0) continue;

    const matches = [];
    // Candidates from the grid when we have one; otherwise the full
    // scan, so a degenerate overlay set still joins correctly.
    const candidates = overlayIndex ? queryBboxIndex(overlayIndex, parcelBbox) : null;
    const candidateCount = candidates ? candidates.length : overlayFeatures.length;
    for (let ci = 0; ci < candidateCount; ci++) {
      const i = candidates ? candidates[ci] : ci;
      const ob = overlayBboxes[i];
      if (!ob) continue;
      if (!bboxesOverlap(parcelBbox, ob)) continue;
      const interArea = intersectionArea(parcel, parcelBbox, entry, i);
      if (!Number.isFinite(interArea) || interArea <= 0) continue;
      matches.push({ i, ratio: Math.min(1, interArea / parcelArea) });
    }

    matches.sort((a, b) => b.ratio - a.ratio);
    // A municipality-wide backdrop can cover a parcel more completely than
    // the zone that actually applies to it. Runs BEFORE the truncation so a
    // displaced blanket keeps its place as the secondary match.
    promoteSpecificOverBlanket(matches, entry);
    if (matches.length > n) matches.length = n;
    out.push([oid, matches]);
  }
  return out;
}
