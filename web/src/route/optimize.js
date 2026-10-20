/*
 * Stop-order optimizer for the Route Optimizer page (route.html).
 *
 * Port of D:\Dropbox\ClaudeCode\route-optimizer\solver.py. One vehicle, a
 * fixed start, and either a fixed finish (which may be the start: a round
 * trip) or none (one-way: the solver also picks the last stop).
 *
 * - Up to EXACT_MAX stops: exact optimum by Held-Karp dynamic programming.
 * - Above that: nearest neighbour, then 2-opt + Or-opt local search inside
 *   an iterated local search with double-bridge kicks, for up to
 *   `timeLimitMs`.
 *
 * The cost matrix may be ASYMMETRIC (one-way streets, divided highways), so
 * every move delta below prices a reversed segment with its own reversed
 * edges rather than assuming d(a,b) = d(b,a).
 *
 * Deliberately separate from lib/routeSolver.js (the main page's route
 * planner) so the two can evolve independently.
 */

export const BIG = 1e12;      // cost used for unroutable pairs
export const EXACT_MAX = 12;  // stop counts up to this are solved exactly

export function pathCost(p, C) {
  let s = 0;
  for (let k = 0; k < p.length - 1; k++) s += C[p[k]][p[k + 1]];
  return s;
}

/** Seeded PRNG (mulberry32) so a given input always gives the same route. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nearestNeighbour(start, end, nodes, C) {
  const left = new Set(nodes);
  const p = [start];
  while (left.size) {
    const cur = p[p.length - 1];
    let best = null;
    let bestC = Infinity;
    for (const j of left) {
      if (C[cur][j] < bestC) { bestC = C[cur][j]; best = j; }
    }
    p.push(best);
    left.delete(best);
  }
  p.push(end);
  return p;
}

/** Apply the best segment reversal. Returns true if the path improved. */
function twoOptPass(p, C) {
  const n = p.length;
  const F = new Float64Array(n); // forward cost prefix
  const B = new Float64Array(n); // cost prefix with every edge traversed backwards
  for (let k = 1; k < n; k++) {
    F[k] = F[k - 1] + C[p[k - 1]][p[k]];
    B[k] = B[k - 1] + C[p[k]][p[k - 1]];
  }
  let best = -1e-9;
  let move = null;
  for (let i = 1; i < n - 2; i++) {
    const a = p[i - 1];
    const s = p[i];
    for (let j = i + 1; j < n - 1; j++) {
      const e = p[j];
      const b = p[j + 1];
      const oldC = C[a][s] + (F[j] - F[i]) + C[e][b];
      const newC = C[a][e] + (B[j] - B[i]) + C[s][b];
      if (newC - oldC < best) { best = newC - oldC; move = [i, j]; }
    }
  }
  if (!move) return false;
  const [i, j] = move;
  const seg = p.slice(i, j + 1).reverse();
  p.splice(i, seg.length, ...seg);
  return true;
}

/** Move the best segment of 1-3 stops elsewhere, optionally reversed. */
function orOptPass(p, C) {
  const n = p.length;
  let best = -1e-9;
  let move = null;
  for (const L of [1, 2, 3]) {
    for (let i = 1; i < n - L; i++) { // segment p[i..i+L-1]; never the fixed last node
      const a = p[i - 1];
      const s = p[i];
      const e = p[i + L - 1];
      const b = p[i + L];
      let fwd = 0;
      let rev = 0;
      for (let k = i; k < i + L - 1; k++) {
        fwd += C[p[k]][p[k + 1]];
        rev += C[p[k + 1]][p[k]];
      }
      const gain = C[a][s] + fwd + C[e][b] - C[a][b];
      for (let k = 0; k < n - 1; k++) {
        if (k >= i - 1 && k <= i + L - 1) continue;
        const x = p[k];
        const y = p[k + 1];
        const base = C[x][y];
        let d = C[x][s] + fwd + C[e][y] - base - gain;
        if (d < best) { best = d; move = [i, L, k, false]; }
        d = C[x][e] + rev + C[s][y] - base - gain;
        if (d < best) { best = d; move = [i, L, k, true]; }
      }
    }
  }
  if (!move) return false;
  const [i, L, k, flip] = move;
  const seg = p.slice(i, i + L);
  if (flip) seg.reverse();
  const rest = p.slice(0, i).concat(p.slice(i + L));
  const pos = k < i ? k + 1 : k + 1 - L;
  const out = rest.slice(0, pos).concat(seg, rest.slice(pos));
  p.splice(0, p.length, ...out);
  return true;
}

function localSearch(p, C) {
  while (twoOptPass(p, C) || orOptPass(p, C)) { /* keep improving */ }
  return p;
}

function doubleBridge(p, rand) {
  const inner = p.slice(1, -1);
  const m = inner.length;
  // three distinct cut points in 1..m-1, sorted
  const picks = new Set();
  while (picks.size < 3) picks.add(1 + Math.floor(rand() * (m - 1)));
  const [a, b, c] = [...picks].sort((x, y) => x - y);
  const out = inner.slice(0, a).concat(inner.slice(b, c), inner.slice(a, b), inner.slice(c));
  return [p[0], ...out, p[p.length - 1]];
}

/** Exact dynamic-programming solution; fine up to ~14 stops. Exported for tests. */
export function heldKarp(C, start, nodes, end) {
  const m = nodes.length;
  const full = (1 << m) - 1;
  const INF = BIG * 10;
  const size = 1 << m;
  const dp = new Float64Array(size * m).fill(INF);
  const parent = new Int8Array(size * m).fill(-1);
  for (let j = 0; j < m; j++) dp[(1 << j) * m + j] = C[start][nodes[j]];
  for (let mask = 1; mask < size; mask++) {
    for (let j = 0; j < m; j++) {
      if (!((mask >> j) & 1)) continue;
      const v0 = dp[mask * m + j];
      if (v0 >= INF) continue;
      const cj = C[nodes[j]];
      for (let k = 0; k < m; k++) {
        if ((mask >> k) & 1) continue;
        const nm = mask | (1 << k);
        const v = v0 + cj[nodes[k]];
        if (v < dp[nm * m + k]) {
          dp[nm * m + k] = v;
          parent[nm * m + k] = j;
        }
      }
    }
  }
  let last = 0;
  let bestV = Infinity;
  for (let j = 0; j < m; j++) {
    const v = dp[full * m + j] + C[nodes[j]][end];
    if (v < bestV) { bestV = v; last = j; }
  }
  const order = [];
  let mask = full;
  let j = last;
  while (j !== -1) {
    order.push(nodes[j]);
    const pj = parent[mask * m + j];
    mask ^= 1 << j;
    j = pj;
  }
  return order.reverse();
}

/**
 * Order `nodes` to minimise the cost of start -> nodes... -> end.
 *
 * @param {number[][]} C  square cost matrix, may be asymmetric
 * @param {number} start  index of the start point
 * @param {number[]} nodes  indexes of the stops to visit
 * @param {number|null} end  finish index; may equal start (round trip) or be
 *                           null (finish wherever the last stop is)
 * @returns {number[]} the stop indexes in visiting order (no start/end)
 */
export function solve(C, start, nodes, end = null, { timeLimitMs = 3000, seed = 1 } = {}) {
  nodes = [...nodes];
  if (nodes.length <= 1) return nodes;

  if (end === null || end === undefined) {
    // Open path: a dummy finish reachable from anywhere for free.
    const n = C.length;
    C = C.map((row) => [...row, 0]);
    C.push(new Array(n + 1).fill(0));
    end = n;
  }

  if (nodes.length <= EXACT_MAX) return heldKarp(C, start, nodes, end);

  const rand = rng(seed);
  let best = localSearch(nearestNeighbour(start, end, nodes, C), C);
  let bestCost = pathCost(best, C);
  const deadline = Date.now() + timeLimitMs;
  let stale = 0;
  const maxStale = 400 + 20 * nodes.length;
  while (Date.now() < deadline && stale < maxStale) {
    const cand = localSearch(doubleBridge(best, rand), C);
    const cost = pathCost(cand, C);
    if (cost < bestCost - 1e-9) {
      best = cand;
      bestCost = cost;
      stale = 0;
    } else {
      stale += 1;
    }
  }
  return best.slice(1, -1);
}
