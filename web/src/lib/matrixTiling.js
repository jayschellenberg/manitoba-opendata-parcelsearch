/*
 * Tiled Mapbox Matrix requests. Pure logic plus an injectable fetcher, so
 * the node tests can drive it without a token or the network.
 *
 * Mapbox Matrix v1 (driving) takes at most 25 coordinates per call, but a
 * call can ask for a subset of rows (`sources`) and columns
 * (`destinations`) of the matrix over those coordinates. Billing is per
 * ELEMENT — sources × destinations — not per request (100,000 elements a
 * month on the free tier, October 2026 pricing page). So the plan below
 * covers every cell of the N×N matrix exactly once: the bill for a route
 * is N² elements however it is tiled, and the tiling only decides how many
 * HTTP requests that takes.
 *
 * Shape of a plan for N > 25:
 *   1. Split the indices into near-equal blocks.
 *   2. Diagonal groups: consecutive blocks whose union fits in one call get
 *      a full matrix over that union (covers the within-group cells).
 *   3. Rectangles: every remaining ordered (source block → destination
 *      block) pair, packed so a call takes r source blocks and as many
 *      destination blocks as still fit in the 25-coordinate cap.
 * The block size and r are searched to minimise the request count; for
 * 51 points (50 stops + start) that is 16 requests, 2,601 elements.
 */

export const MATRIX_MAX_COORDS = 25;

/**
 * @typedef {Object} MatrixTile
 * @property {number[]} coords        - global point indices sent in the URL, in order.
 * @property {number[]|null} sources  - positions WITHIN coords used as rows (null = all).
 * @property {number[]|null} destinations - positions within coords used as columns.
 * @property {number[]} rows          - global indices of the result rows.
 * @property {number[]} cols          - global indices of the result columns.
 */

/**
 * Plan the Matrix requests that cover an n×n matrix exactly once.
 * @param {number} n
 * @param {{maxCoords?: number}} [opts]
 * @returns {MatrixTile[]}
 */
export function planMatrixTiles(n, { maxCoords = MATRIX_MAX_COORDS } = {}) {
  if (n < 2) return [];
  if (n <= maxCoords) {
    const all = range(0, n);
    return [{ coords: all, sources: null, destinations: null, rows: all, cols: all }];
  }
  let best = null;
  for (let b = 2; b <= Math.floor(maxCoords / 2); b++) {
    const blocks = splitBlocks(n, Math.ceil(n / b));
    for (let r = 1; r * b < maxCoords; r++) {
      const plan = planWithBlocks(blocks, r, maxCoords);
      if (plan && (!best || plan.length < best.length)) best = plan;
    }
  }
  return best;
}

/** Split 0..n-1 into k consecutive blocks whose sizes differ by at most 1. */
function splitBlocks(n, k) {
  const out = [];
  const base = Math.floor(n / k);
  const extra = n % k;
  let cursor = 0;
  for (let i = 0; i < k; i++) {
    const size = base + (i < extra ? 1 : 0);
    out.push(range(cursor, cursor + size));
    cursor += size;
  }
  return out;
}

function planWithBlocks(blocks, r, maxCoords) {
  const tiles = [];
  // 1. Diagonal groups: as many consecutive blocks as fit in one call.
  const groupOf = new Array(blocks.length);
  let g = 0;
  for (let i = 0; i < blocks.length;) {
    let union = [];
    let j = i;
    while (j < blocks.length && union.length + blocks[j].length <= maxCoords) {
      union = union.concat(blocks[j]);
      groupOf[j] = g;
      j++;
    }
    if (j === i) return null;            // a single block over the cap
    tiles.push({ coords: union, sources: null, destinations: null, rows: union, cols: union });
    g++;
    i = j;
  }
  // 2. Off-group rectangles. Source blocks are taken r at a time (all from
  //    one group, so their destination lists match); destinations are the
  //    blocks of every other group, packed into the space left.
  for (let i = 0; i < blocks.length;) {
    const srcBlocks = [blocks[i]];
    let k = i + 1;
    while (k < blocks.length && srcBlocks.length < r && groupOf[k] === groupOf[i]) {
      srcBlocks.push(blocks[k]);
      k++;
    }
    const rows = srcBlocks.flat();
    const room = maxCoords - rows.length;
    if (room < 1) return null;
    const dstBlocks = blocks.filter((_, d) => groupOf[d] !== groupOf[i]);
    let pending = [];
    const flush = () => {
      if (pending.length === 0) return;
      const coords = rows.concat(pending);
      tiles.push({
        coords,
        sources: range(0, rows.length),
        destinations: range(rows.length, coords.length),
        rows,
        cols: pending,
      });
      pending = [];
    };
    for (const dst of dstBlocks) {
      if (dst.length > room) return null;
      if (pending.length + dst.length > room) flush();
      pending = pending.concat(dst);
    }
    flush();
    i = k;
  }
  // Mapbox rejects a request with fewer than 2 elements.
  if (tiles.some((t) => tileElements(t) < 2)) return null;
  return tiles;
}

/** Elements a tile is billed for (rows × columns). */
export function tileElements(tile) {
  return tile.rows.length * tile.cols.length;
}

/**
 * Sliding-window request limiter. Mapbox allows 60 Matrix requests a
 * minute on the driving profile; staying a little under leaves room for
 * a Recalculate in the same minute without a 429.
 */
export function createRateLimiter({
  limit = 50,
  windowMs = 60_000,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  const stamps = [];
  return async function acquire() {
    for (;;) {
      const t = now();
      while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length < limit) {
        stamps.push(t);
        return;
      }
      await sleep(windowMs - (t - stamps[0]) + 5);
    }
  };
}

export class MatrixTileError extends Error {
  constructor(message, { cause, stats } = {}) {
    super(message);
    this.name = 'MatrixTileError';
    this.cause = cause;
    this.stats = stats;
  }
}

/**
 * Build the full n×n duration + distance matrices by running the tile plan
 * through `fetchTile`. Fails as a whole — the caller falls back to its
 * haversine ordering — when any tile still fails after retries; the tiles
 * not yet started are skipped so a dead token doesn't burn the quota.
 *
 * @param {Object} args
 * @param {Array<{lng:number,lat:number}>} args.points
 * @param {(req: {coords: Array<{lng,lat}>, sources: number[]|null,
 *   destinations: number[]|null}) => Promise<{durations: any[][],
 *   distances: any[][]}>} args.fetchTile - one Matrix HTTP call. Errors
 *   should carry `status` (HTTP code) and optionally `retryAfterMs`.
 * @param {number} [args.concurrency=4]
 * @param {number} [args.maxRetries=3] - retries per tile on 429 / 5xx / network errors.
 * @param {() => Promise<void>} [args.acquire] - rate limiter; called before every HTTP attempt.
 * @param {(ms:number) => Promise<void>} [args.sleep]
 * @param {number} [args.maxCoords]
 * @returns {Promise<{ duration: number[][], distance: number[][],
 *   stats: { tiles: number, requests: number, elements: number, retries: number } }>}
 */
export async function fetchTiledMatrix({
  points,
  fetchTile,
  concurrency = 4,
  maxRetries = 3,
  acquire = async () => {},
  sleep = defaultSleep,
  maxCoords = MATRIX_MAX_COORDS,
}) {
  const n = points.length;
  const duration = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  const distance = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) { duration[i][i] = 0; distance[i][i] = 0; }
  const tiles = planMatrixTiles(n, { maxCoords });
  const stats = { tiles: tiles.length, requests: 0, elements: 0, retries: 0 };
  if (tiles.length === 0) return { duration, distance, stats };

  let next = 0;
  let failure = null;

  async function runTile(tile) {
    const req = {
      coords: tile.coords.map((i) => points[i]),
      sources: tile.sources,
      destinations: tile.destinations,
    };
    for (let attempt = 0; ; attempt++) {
      if (failure) return;
      await acquire();
      if (failure) return;
      stats.requests++;
      stats.elements += tileElements(tile);
      try {
        const data = await fetchTile(req);
        stamp(tile, data, duration, distance);
        return;
      } catch (err) {
        if (attempt >= maxRetries || !isRetryable(err)) throw err;
        stats.retries++;
        const backoff = Number.isFinite(err?.retryAfterMs)
          ? err.retryAfterMs
          : 1000 * 2 ** attempt;
        await sleep(backoff);
      }
    }
  }

  async function worker() {
    while (!failure && next < tiles.length) {
      const tile = tiles[next++];
      try {
        await runTile(tile);
      } catch (err) {
        failure = failure || err;
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, tiles.length); w++) workers.push(worker());
  await Promise.all(workers);
  if (failure) {
    throw new MatrixTileError(
      `Mapbox Matrix tile failed: ${failure.message || failure}`,
      { cause: failure, stats },
    );
  }
  return { duration, distance, stats };
}

function stamp(tile, data, duration, distance) {
  const dur = data?.durations || [];
  const dis = data?.distances || [];
  tile.rows.forEach((gi, r) => {
    tile.cols.forEach((gj, c) => {
      if (gi === gj) return;
      if (dur[r] && dur[r][c] != null) duration[gi][gj] = dur[r][c];
      if (dis[r] && dis[r][c] != null) distance[gi][gj] = dis[r][c];
    });
  });
}

function isRetryable(err) {
  const s = err?.status;
  if (s == null) return true;           // network error / CORS-blocked 429
  return s === 429 || s >= 500;
}

function range(a, b) {
  const out = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
