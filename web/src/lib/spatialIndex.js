/*
 * Uniform-grid spatial index over bounding boxes.
 *
 * Exists for joinTopNByArea, whose original comment stated its own
 * breaking point:
 *
 *   "at our result-set sizes (≤1000 parcels × ~10-50 overlays each) the
 *    O(P×O) bbox check is fast enough"
 *
 * True for a single-municipality search. A multi-muni sales upload
 * violates it badly: ~500 parcels against every zoning polygon in 15
 * whole municipalities is millions of bbox tests, run four times over
 * (zoning top-2, dev-plan top-2, and the two changed-polygon passes),
 * all synchronous on the main thread. The tab stops responding.
 *
 * The grid turns "test every overlay" into "test the overlays in the
 * cells this parcel touches". Because parcels are tiny relative to a
 * province-wide overlay set, that candidate list is a handful of
 * polygons regardless of how many municipalities were loaded.
 *
 * Pure — bboxes in, indices out. No turf, no geometry, no DOM.
 *
 * A note on why a uniform grid rather than an R-tree: the inputs are
 * parcel and zoning polygons, which are roughly evenly spread over the
 * populated parts of a municipality rather than clustered pathologically.
 * A grid gets essentially R-tree query performance here for a fraction
 * of the code, and has no rebalancing to get wrong.
 */

// Bbox layout is [minX, minY, maxX, maxY] throughout — the same order
// @turf/bbox returns, so callers can hand turf output straight in.

/** Grid axis resolution is ~sqrt(itemCount), so cell occupancy stays
 *  near-constant as the overlay set grows. Clamped: below 1 there's no
 *  grid at all, and above this a sparse set would allocate far more
 *  cells than it has items. */
const MIN_AXIS_CELLS = 1;
const MAX_AXIS_CELLS = 256;

/**
 * Build an index over `bboxes`. Entries that are null/undefined (a
 * geometry whose bbox couldn't be computed) are skipped — they can
 * never match anything, and dropping them here keeps every caller from
 * having to special-case them.
 *
 * Returns an opaque object for queryBboxIndex, or null when there is
 * nothing to index — callers should treat null as "no index available"
 * and fall back to a linear scan.
 */
export function buildBboxIndex(bboxes) {
  const list = bboxes || [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let count = 0;
  for (const b of list) {
    if (!b) continue;
    if (!Number.isFinite(b[0]) || !Number.isFinite(b[1])
     || !Number.isFinite(b[2]) || !Number.isFinite(b[3])) continue;
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
    if (b[2] > maxX) maxX = b[2];
    if (b[3] > maxY) maxY = b[3];
    count++;
  }
  if (count === 0) return null;

  const axis = Math.max(
    MIN_AXIS_CELLS,
    Math.min(MAX_AXIS_CELLS, Math.round(Math.sqrt(count))),
  );
  // A zero-width or zero-height extent (every item on one line, or a
  // single item) would divide by zero; give it a nominal span so every
  // item lands in one column/row instead.
  const spanX = maxX - minX || 1e-9;
  const spanY = maxY - minY || 1e-9;
  const cells = new Array(axis * axis);

  const colOf = (x) => {
    const c = Math.floor(((x - minX) / spanX) * axis);
    return c < 0 ? 0 : (c >= axis ? axis - 1 : c);
  };
  const rowOf = (y) => {
    const r = Math.floor(((y - minY) / spanY) * axis);
    return r < 0 ? 0 : (r >= axis ? axis - 1 : r);
  };

  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b) continue;
    if (!Number.isFinite(b[0]) || !Number.isFinite(b[1])
     || !Number.isFinite(b[2]) || !Number.isFinite(b[3])) continue;
    // An item spanning several cells is registered in each of them, so
    // a query anywhere over it finds it. Large items therefore cost
    // more memory — acceptable, since overlay polygons are small
    // relative to the full extent.
    const c0 = colOf(b[0]), c1 = colOf(b[2]);
    const r0 = rowOf(b[1]), r1 = rowOf(b[3]);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * axis + c;
        (cells[k] || (cells[k] = [])).push(i);
      }
    }
  }

  return {
    axis, minX, minY, spanX, spanY, cells,
    itemCount: count,
    // Reused across queries so a hit-set doesn't have to be allocated
    // per parcel. `stampSeq` rising each query is what invalidates the
    // previous query's marks without clearing the array.
    stamps: new Int32Array(list.length),
    stampSeq: 0,
    colOf,
    rowOf,
  };
}

/**
 * Indices of every item whose bbox may overlap `queryBbox`.
 *
 * This is a BROAD PHASE: results are candidates whose cells intersect,
 * not confirmed overlaps. Callers still run their own precise test —
 * for joinTopNByArea that's the existing bbox check followed by
 * turf.intersect, both unchanged.
 *
 * Returns [] for a null index or an unusable query box.
 */
export function queryBboxIndex(index, queryBbox) {
  if (!index || !queryBbox) return [];
  const [qx0, qy0, qx1, qy1] = queryBbox;
  if (!Number.isFinite(qx0) || !Number.isFinite(qy0)
   || !Number.isFinite(qx1) || !Number.isFinite(qy1)) return [];

  const { axis, cells, stamps } = index;
  const seq = ++index.stampSeq;
  const out = [];
  const c0 = index.colOf(qx0), c1 = index.colOf(qx1);
  const r0 = index.rowOf(qy0), r1 = index.rowOf(qy1);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const bucket = cells[r * axis + c];
      if (!bucket) continue;
      for (let j = 0; j < bucket.length; j++) {
        const idx = bucket[j];
        // An item registered in several cells would otherwise be
        // returned once per cell the query touches.
        if (stamps[idx] === seq) continue;
        stamps[idx] = seq;
        out.push(idx);
      }
    }
  }
  return out;
}

/** Do two bboxes overlap? Edge-touching counts, matching the behaviour
 *  joinTopNByArea already relied on. */
export function bboxesOverlap(a, b) {
  if (!a || !b) return false;
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Split a bbox into an n×n lattice of cell bboxes, row-major.
 *
 * Used to tile the handful of enormous overlay polygons that dominate
 * joinTopNByArea's cost. Clipping a 2900-vertex zoning district against
 * every parcel is ~17 ms a time; clipping it ONCE into tiles and then
 * clipping parcels against the one or two tiles they touch is far
 * cheaper, and because area is additive over a partition the summed
 * result is the same number.
 *
 * Cells share edges exactly (each boundary is computed from the same
 * interpolation), so tiling neither double-counts nor loses slivers
 * beyond floating-point noise.
 */
export function gridCellBboxes(box, n) {
  if (!box || !Number.isFinite(n) || n < 1) return [];
  const [x0, y0, x1, y1] = box;
  if (!Number.isFinite(x0) || !Number.isFinite(y0)
   || !Number.isFinite(x1) || !Number.isFinite(y1)) return [];
  const cells = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      cells.push([
        x0 + ((x1 - x0) * c) / n,
        y0 + ((y1 - y0) * r) / n,
        x0 + ((x1 - x0) * (c + 1)) / n,
        y0 + ((y1 - y0) * (r + 1)) / n,
      ]);
    }
  }
  return cells;
}
