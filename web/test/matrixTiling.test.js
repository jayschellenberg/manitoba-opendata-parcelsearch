// Unit tests for the tiled Mapbox Matrix plan + fetch orchestration.
// Pure logic with a fake fetcher — no token, no network. Run:
//   cd web && node test/matrixTiling.test.js

import assert from 'node:assert/strict';
import {
  planMatrixTiles,
  tileElements,
  fetchTiledMatrix,
  createRateLimiter,
  MatrixTileError,
  MATRIX_MAX_COORDS,
} from '../src/lib/matrixTiling.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

// ---- helpers --------------------------------------------------

function pointsGrid(n) {
  // Spread over southern Manitoba; exact values don't matter.
  return Array.from({ length: n }, (_, i) => ({ lng: -98 + (i % 8) * 0.07, lat: 49.5 + Math.floor(i / 8) * 0.05 }));
}

// Fake "road" cost the fake Matrix API answers with: deterministic and
// asymmetric, so a transposed or misplaced cell is caught.
const fakeDur = (a, b) => 1000 * Math.abs(a.lng - b.lng) + 700 * Math.abs(a.lat - b.lat) + (a.lng < b.lng ? 3 : 1);
const fakeDis = (a, b) => fakeDur(a, b) * 20;

/** Fake Matrix endpoint honouring sources/destinations like Mapbox does. */
function fakeFetch(log = []) {
  return async ({ coords, sources, destinations }) => {
    assert.ok(coords.length <= MATRIX_MAX_COORDS, `call has ${coords.length} coords`);
    const src = sources || coords.map((_, i) => i);
    const dst = destinations || coords.map((_, i) => i);
    const elements = src.length * dst.length;
    assert.ok(elements >= 2 && elements <= 625, `call has ${elements} elements`);
    log.push({ coords: coords.length, elements });
    return {
      durations: src.map((s) => dst.map((d) => (s === d ? 0 : fakeDur(coords[s], coords[d])))),
      distances: src.map((s) => dst.map((d) => (s === d ? 0 : fakeDis(coords[s], coords[d])))),
    };
  };
}

function coverageCounts(n, tiles) {
  const seen = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const t of tiles) for (const i of t.rows) for (const j of t.cols) seen[i][j]++;
  return seen;
}

const noSleep = async () => {};

// ---- plan -----------------------------------------------------

await test('n < 2 needs no request', () => {
  assert.equal(planMatrixTiles(0).length, 0);
  assert.equal(planMatrixTiles(1).length, 0);
});

await test('n ≤ 25 is one full-matrix request', () => {
  for (const n of [2, 10, 25]) {
    const tiles = planMatrixTiles(n);
    assert.equal(tiles.length, 1);
    assert.equal(tiles[0].sources, null);
    assert.equal(tiles[0].coords.length, n);
  }
});

await test('every n from 26 to 61 covers each cell exactly once within the caps', () => {
  for (let n = 26; n <= 61; n++) {
    const tiles = planMatrixTiles(n);
    assert.ok(tiles && tiles.length > 1, `n=${n} has a plan`);
    const seen = coverageCounts(n, tiles);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        assert.equal(seen[i][j], 1, `n=${n}: cell ${i},${j} covered ${seen[i][j]}×`);
      }
    }
    for (const t of tiles) {
      assert.ok(t.coords.length <= MATRIX_MAX_COORDS, `n=${n}: ${t.coords.length} coords`);
      assert.equal(new Set(t.coords).size, t.coords.length, `n=${n}: duplicate coordinate`);
      const e = tileElements(t);
      assert.ok(e >= 2 && e <= 625, `n=${n}: ${e} elements`);
      // rows/cols must be what sources/destinations select from coords.
      const rows = (t.sources || t.coords.map((_, k) => k)).map((k) => t.coords[k]);
      const cols = (t.destinations || t.coords.map((_, k) => k)).map((k) => t.coords[k]);
      assert.deepEqual(rows, t.rows);
      assert.deepEqual(cols, t.cols);
    }
    // Billing: exactly n² elements, never more.
    assert.equal(tiles.reduce((a, t) => a + tileElements(t), 0), n * n);
  }
});

await test('request budget: 50 stops + start = 16 requests, 2,601 elements', () => {
  const budget = { 26: 6, 31: 6, 41: 10, 51: 16 };
  for (const [n, max] of Object.entries(budget)) {
    const tiles = planMatrixTiles(Number(n));
    assert.ok(tiles.length <= max, `n=${n}: ${tiles.length} requests (budget ${max})`);
  }
  const t51 = planMatrixTiles(51);
  assert.equal(t51.length, 16);
  assert.equal(t51.reduce((a, t) => a + tileElements(t), 0), 2601);
});

// ---- fetch orchestration ---------------------------------------

await test('tiled fetch assembles the same matrix as one big call would', async () => {
  for (const n of [5, 25, 26, 37, 51]) {
    const points = pointsGrid(n);
    const log = [];
    const { duration, distance, stats } = await fetchTiledMatrix({ points, fetchTile: fakeFetch(log), sleep: noSleep });
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const want = i === j ? 0 : fakeDur(points[i], points[j]);
        assert.equal(duration[i][j], want, `n=${n} dur ${i},${j}`);
        assert.equal(distance[i][j], i === j ? 0 : fakeDis(points[i], points[j]), `n=${n} dis ${i},${j}`);
      }
    }
    assert.equal(stats.requests, planMatrixTiles(n).length);
    assert.equal(stats.elements, n * n);
    assert.equal(log.length, stats.requests);
  }
});

await test('null cells stay Infinity (unroutable pair)', async () => {
  const points = pointsGrid(4);
  const { duration } = await fetchTiledMatrix({
    points,
    sleep: noSleep,
    fetchTile: async ({ coords }) => ({
      durations: coords.map((_, i) => coords.map((__, j) => (i === 1 && j === 2 ? null : 5))),
      distances: coords.map(() => coords.map(() => 9)),
    }),
  });
  assert.equal(duration[1][2], Infinity);
  assert.equal(duration[2][1], 5);
  assert.equal(duration[1][1], 0);
});

await test('429 is retried with backoff, then succeeds', async () => {
  const points = pointsGrid(30);
  const inner = fakeFetch();
  let calls = 0;
  const sleeps = [];
  const { stats, duration } = await fetchTiledMatrix({
    points,
    concurrency: 1,
    sleep: async (ms) => { sleeps.push(ms); },
    fetchTile: async (req) => {
      calls++;
      if (calls === 2 || calls === 3) {
        const err = new Error('rate limit');
        err.status = 429;
        if (calls === 3) err.retryAfterMs = 1500;
        throw err;
      }
      return inner(req);
    },
  });
  assert.equal(stats.retries, 2);
  assert.equal(stats.requests, planMatrixTiles(30).length + 2);
  assert.deepEqual(sleeps, [1000, 1500]);   // exponential default, then Retry-After
  assert.equal(duration[0][29], fakeDur(points[0], points[29]));
});

await test('non-retryable error fails the whole matrix and skips unstarted tiles', async () => {
  const points = pointsGrid(51);
  let calls = 0;
  await assert.rejects(
    fetchTiledMatrix({
      points,
      concurrency: 2,
      sleep: noSleep,
      fetchTile: async () => {
        calls++;
        const err = new Error('Mapbox auth failed (401).');
        err.status = 401;
        throw err;
      },
    }),
    (err) => err instanceof MatrixTileError && err.cause.status === 401,
  );
  assert.ok(calls <= 2, `stopped after ${calls} calls, not all 16`);
});

await test('persistent 5xx gives up after maxRetries', async () => {
  let calls = 0;
  await assert.rejects(
    fetchTiledMatrix({
      points: pointsGrid(3),
      maxRetries: 3,
      sleep: noSleep,
      fetchTile: async () => { calls++; const e = new Error('boom'); e.status = 503; throw e; },
    }),
    MatrixTileError,
  );
  assert.equal(calls, 4);   // first try + 3 retries
});

await test('rate limiter holds the 51st request until the window frees up', async () => {
  let t = 0;
  const waits = [];
  const acquire = createRateLimiter({
    limit: 50,
    windowMs: 60_000,
    now: () => t,
    sleep: async (ms) => { waits.push(ms); t += ms; },
  });
  for (let i = 0; i < 50; i++) { await acquire(); t += 100; }
  assert.equal(waits.length, 0);
  await acquire();
  assert.equal(waits.length, 1);
  assert.ok(t >= 60_000, `51st request went out at ${t} ms`);
});

// ---- summary --------------------------------------------------

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
