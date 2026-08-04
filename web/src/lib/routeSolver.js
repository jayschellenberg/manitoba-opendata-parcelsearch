/*
 * Traveling Salesman solver. Pure logic — no I/O, no DOM. Given a
 * cost matrix between N stops and a fixed start index, returns a
 * visit order that minimises the total cost.
 *
 * Algorithm: nearest-neighbour construction (cheap, decent baseline)
 * followed by 2-opt improvement (swaps any pair of edges if doing so
 * shortens the tour). For N ≤ ~50 the 2-opt loop converges in well
 * under 100ms; for our cap of 100 stops it's still effectively
 * instant.
 *
 * "Cost" is whatever the matrix carries — kilometres, seconds, or
 * any metric the caller wants to optimise on. The Mapbox client
 * passes a duration matrix (the appraiser cares about drive time
 * more than raw distance), with a distance matrix supplied alongside
 * so the UI can report km totals once the order is fixed.
 *
 * Round-trip vs open: roundTrip=true closes the loop back to start
 * (TSP); roundTrip=false leaves the last stop dangling (open-TSP /
 * shortest Hamiltonian path from start). The 2-opt swap function
 * respects whichever shape the construction produced.
 */

/**
 * @param {number[][]} cost - NxN symmetric cost matrix (Infinity for
 *   unreachable pairs). cost[i][j] is the cost of going from i to j.
 * @param {Object} [opts]
 * @param {number} [opts.start=0] - index of the fixed start stop.
 * @param {boolean} [opts.roundTrip=true] - close the loop back to start.
 * @param {number} [opts.maxIters=400] - 2-opt iteration cap (safety).
 * @returns {{ order: number[], cost: number, iterations: number }}
 *   `order` is the visit order including the start (and the start
 *   again at the end when roundTrip is true). `cost` is the sum of
 *   leg costs along that order.
 */
export function solveRoute(cost, opts = {}) {
  const n = cost.length;
  const start = opts.start ?? 0;
  const roundTrip = opts.roundTrip !== false;
  const maxIters = opts.maxIters ?? 400;
  // Iterated local search: after the first 2-opt+or-opt local optimum,
  // we kick the tour with a random double-bridge 4-change and re-
  // optimise; keep the best of K runs. K scales loosely with N — for
  // small N the first local optimum is usually optimal so 4 restarts
  // is plenty; for N=50+ more restarts help.
  const restarts = opts.restarts ?? Math.min(20, Math.max(4, Math.floor(n / 4)));
  const rng = opts.rng ?? Math.random;

  if (n === 0) return { order: [], cost: 0, iterations: 0 };
  if (n === 1) return { order: [start], cost: 0, iterations: 0 };

  // Step 1: NN construction + alternating 2-opt / or-opt to first
  // local optimum.
  const nnOrder = nearestNeighbour(cost, start);
  let best = refineToLocalOptimum(nnOrder, cost, { roundTrip, maxIters });
  let totalIters = best.iterations;

  // Step 2: iterated-local-search restarts. Each iteration perturbs
  // the current best with a double-bridge move (a 4-opt swap that
  // 2-opt cannot undo, so it provides genuine escape from local
  // optima) and re-optimises. Tiny enough to skip when n is too small
  // for double-bridge cuts (n < 8 has too few segments to swap).
  if (n >= 8) {
    for (let r = 0; r < restarts; r++) {
      const kicked = doubleBridge(best.order, rng);
      const refined = refineToLocalOptimum(kicked, cost, { roundTrip, maxIters });
      totalIters += refined.iterations;
      if (refined.cost + 1e-9 < best.cost) {
        best = refined;
      }
    }
  }

  // Close the loop on output when round-trip; consumers can trust
  // order[0] === order[length-1] in that case.
  const order = roundTrip ? [...best.order, start] : best.order;
  const totalCost = tourCost(order, cost);

  return { order, cost: totalCost, iterations: totalIters };
}

/**
 * Drive a tour to a 2-opt + or-opt local optimum. Alternates the two
 * neighbourhoods until both fail to find an improving move — this is
 * the standard "Lin-Kernighan-lite" pattern. Each neighbourhood is
 * complementary: 2-opt removes crossings; or-opt relocates stops
 * that got stranded in the wrong cluster. Either alone leaves
 * obvious back-and-forth on irregular instances.
 */
export function refineToLocalOptimum(order, cost, { roundTrip = true, maxIters = 400 } = {}) {
  let current = order.slice();
  let currentCost = tourCost(closeIfRoundTrip(current, roundTrip), cost);
  let improved = true;
  let iters = 0;
  while (improved && iters < maxIters) {
    iters++;
    improved = false;
    // 2-opt pass.
    const twoR = twoOpt(current, cost, { roundTrip, maxIters: 1 });
    const twoCost = tourCost(closeIfRoundTrip(twoR.order, roundTrip), cost);
    if (twoCost + 1e-9 < currentCost) {
      current = twoR.order;
      currentCost = twoCost;
      improved = true;
    }
    // or-opt pass.
    const orR = orOpt(current, cost, { roundTrip });
    const orCost = tourCost(closeIfRoundTrip(orR.order, roundTrip), cost);
    if (orCost + 1e-9 < currentCost) {
      current = orR.order;
      currentCost = orCost;
      improved = true;
    }
  }
  return { order: current, cost: currentCost, iterations: iters };
}

function closeIfRoundTrip(order, roundTrip) {
  if (!roundTrip || order.length === 0) return order;
  if (order[0] === order[order.length - 1]) return order;
  return [...order, order[0]];
}

/**
 * Greedy NN tour starting at `start`. At each step pick the unvisited
 * city with the lowest cost from the current city.
 */
export function nearestNeighbour(cost, start = 0) {
  const n = cost.length;
  if (n === 0) return [];
  const visited = new Array(n).fill(false);
  const order = [start];
  visited[start] = true;
  let current = start;
  for (let step = 1; step < n; step++) {
    let best = -1;
    let bestCost = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited[j]) continue;
      if (cost[current][j] < bestCost) {
        bestCost = cost[current][j];
        best = j;
      }
    }
    if (best === -1) {
      // Disconnected matrix (Infinity cost from current to every
      // remaining node). Append the rest in index order — TSP isn't
      // solvable here but we don't want to crash; the caller can
      // surface the warning.
      for (let j = 0; j < n; j++) if (!visited[j]) { visited[j] = true; order.push(j); }
      break;
    }
    visited[best] = true;
    order.push(best);
    current = best;
  }
  return order;
}

/**
 * 2-opt: repeatedly swap any pair of edges (i,i+1) and (j,j+1) when
 * doing so shortens the tour. Stops when no improving swap is found
 * (or the safety iteration cap fires).
 *
 * The first node (index 0 in `order`, i.e. start) is held fixed so
 * the tour keeps starting where the caller asked.
 *
 * When roundTrip is false we don't form an edge back from last → first,
 * so the swap range stops one short.
 */
export function twoOpt(order, cost, { roundTrip = true, maxIters = 400 } = {}) {
  const tour = order.slice();
  const n = tour.length;
  if (n < 4) return { order: tour, iterations: 0 };

  let improved = true;
  let iter = 0;
  while (improved && iter < maxIters) {
    improved = false;
    iter++;
    // i ranges over 1..n-2 (skip start; the segment [i+1..j] reverses).
    // j ranges over i+1..n-1; the closing edge (j → next) wraps when
    // roundTrip is true.
    const jMax = roundTrip ? n - 1 : n - 2;
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j <= jMax; j++) {
        const a = tour[i - 1];
        const b = tour[i];
        const c = tour[j];
        const d = roundTrip ? tour[(j + 1) % n] : tour[j + 1];
        // Skip illegal cases (would null the tour).
        if (d === undefined) continue;
        // Adjacent swap is a no-op for the metric — saves work but
        // not correctness.
        if (a === c || b === d) continue;
        const before = cost[a][b] + cost[c][d];
        const after  = cost[a][c] + cost[b][d];
        if (after + 1e-9 < before) {
          // Reverse the segment between i and j (inclusive).
          reverseSegment(tour, i, j);
          improved = true;
        }
      }
    }
  }
  return { order: tour, iterations: iter };
}

function reverseSegment(arr, i, j) {
  while (i < j) {
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    i++; j--;
  }
}

/**
 * Or-opt: tries removing each contiguous segment of length 1, 2, or 3
 * from the tour and re-inserting it at every other position. Keeps
 * any move that shortens the tour. Complements 2-opt — together they
 * cover both "edge swap" and "relocate stop(s)" moves, which is the
 * pair that catches the user-reported back-and-forth (a single stop
 * stranded in the wrong cluster, which 2-opt alone can't extract).
 *
 * Start index (position 0) is held fixed throughout.
 */
export function orOpt(order, cost, { roundTrip = true } = {}) {
  const tour = order.slice();
  const n = tour.length;
  if (n < 5) return { order: tour, iterations: 0 };

  let improved = true;
  let iter = 0;
  while (improved) {
    improved = false;
    iter++;
    // Tour length we treat the cost over — closed loop or open path.
    for (const segLen of [1, 2, 3]) {
      // i = start of the segment to relocate. Hold start (index 0)
      // fixed, so segments must start at i ≥ 1 and end at i+segLen-1
      // ≤ n-1.
      for (let i = 1; i + segLen <= n; i++) {
        // Edges around the segment in the CURRENT tour:
        //   prev → segHead ... segTail → next
        const prev = tour[i - 1];
        const segHead = tour[i];
        const segTail = tour[i + segLen - 1];
        // `next` wraps in round-trip; in open mode it's undefined past
        // the end so we treat its removal/closure as zero cost.
        let next;
        if (i + segLen < n) {
          next = tour[i + segLen];
        } else if (roundTrip) {
          next = tour[0];
        } else {
          next = null;
        }
        const removeCost = (cost[prev][segHead] || 0) +
                           (next != null ? (cost[segTail][next] || 0) : 0) -
                           (next != null ? (cost[prev][next] || 0) : 0);

        let bestDelta = 0;
        let bestJ = -1;
        // Try inserting the segment after position j. j ranges over
        // valid insertion gaps EXCLUDING the segment's current
        // position (which would be a no-op) and the very start
        // (since start is fixed).
        for (let j = 0; j < n; j++) {
          // Skip if the insertion point falls inside the segment
          // we're about to lift, or right at the boundary (no-op).
          if (j >= i - 1 && j <= i + segLen - 1) continue;
          const here = tour[j];
          let after;
          if (j + 1 < n) {
            after = tour[j + 1];
          } else if (roundTrip) {
            after = tour[0];
          } else {
            after = null;
          }
          if (after === null) continue;  // open-mode end gap can't take an insertion
          const insertCost = (cost[here][segHead] || 0) +
                             (cost[segTail][after] || 0) -
                             (cost[here][after] || 0);
          const delta = insertCost - removeCost;
          if (delta + 1e-9 < bestDelta) {
            bestDelta = delta;
            bestJ = j;
          }
        }
        if (bestJ >= 0) {
          relocateSegment(tour, i, segLen, bestJ);
          improved = true;
        }
      }
    }
  }
  return { order: tour, iterations: iter };
}

/**
 * Lift `segLen` elements starting at index `i` and reinsert them
 * after index `j`. Treats `j` as the index in the ORIGINAL tour
 * before removal; adjusts for the shift if `j > i`. Mutates `arr`.
 */
function relocateSegment(arr, i, segLen, j) {
  const seg = arr.splice(i, segLen);
  // After the splice, indices >= i have shifted left by segLen. If j
  // was past the lifted segment, it shifts too.
  const insertAt = j >= i ? j - segLen + 1 : j + 1;
  arr.splice(insertAt, 0, ...seg);
}

/**
 * Double-bridge perturbation. Cuts the tour into 4 non-empty
 * segments [A | B | C | D] at three random cut positions and
 * reconnects as [A | D | C | B]. This is a 4-opt move that NO
 * single 2-opt swap can undo, which is what makes it the standard
 * iterated-local-search kick — it forces the next 2-opt+or-opt pass
 * into a different basin of attraction.
 *
 * Start (index 0) stays fixed: the first cut is always ≥ 1 so
 * segment A includes tour[0].
 *
 * @param {number[]} tour
 * @param {() => number} rng - [0,1) random source (injectable for tests).
 * @returns {number[]}
 */
export function doubleBridge(tour, rng = Math.random) {
  const n = tour.length;
  if (n < 8) return tour.slice();  // not enough segments to split cleanly
  // Three cut positions p1 < p2 < p3 with p1 ≥ 1 (preserve start),
  // p3 ≤ n - 1 (leave at least one element after the last cut), and
  // every segment ≥ 1 element wide.
  const p1 = 1 + Math.floor(rng() * (n - 4));
  const p2 = p1 + 1 + Math.floor(rng() * (n - p1 - 3));
  const p3 = p2 + 1 + Math.floor(rng() * (n - p2 - 2));
  const A = tour.slice(0, p1);
  const B = tour.slice(p1, p2);
  const C = tour.slice(p2, p3);
  const D = tour.slice(p3);
  return [...A, ...D, ...C, ...B];
}

/**
 * Sum the leg costs of a tour. When `closeLoop` is true, also adds
 * the cost from the last index back to the first.
 */
export function tourCost(order, cost, closeLoop = false) {
  let total = 0;
  for (let k = 0; k < order.length - 1; k++) {
    total += cost[order[k]][order[k + 1]];
  }
  if (closeLoop && order.length > 1) {
    total += cost[order[order.length - 1]][order[0]];
  }
  return total;
}

/**
 * Build a haversine distance matrix (km) for an array of {lng, lat}
 * points. Used as the offline fallback when the Mapbox Matrix API
 * is unreachable — much rougher than real driving distance, but
 * always available and good enough to surface a sensible visit
 * order. Drive-time estimates from the haversine fallback are
 * intentionally NOT shown to the user because they'd be misleading.
 */
export function haversineMatrix(points) {
  const n = points.length;
  const out = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversineKm(points[i], points[j]);
      out[i][j] = d;
      out[j][i] = d;
    }
  }
  return out;
}

/**
 * Index of the point farthest from the rest of the set — the "most
 * outlying" stop, used as the auto-picked start for the starred-comps
 * route (start at the edge of the cluster and sweep across once,
 * instead of starting mid-cluster and backtracking).
 *
 * "Farthest" is the greatest SUM of great-circle distances to every
 * other point, not farthest-from-centroid: with two distant clusters
 * the centroid sits in the empty middle where no parcel is, and
 * distance-from-centroid can then crown a mid-cluster point. The sum
 * formulation always lands on an extreme edge. O(n²), n = starred
 * comps — tens at most.
 */
export function mostOutlyingIndex(points) {
  if (!Array.isArray(points) || points.length === 0) return -1;
  let bestIdx = 0;
  let bestSum = -Infinity;
  for (let i = 0; i < points.length; i++) {
    let sum = 0;
    for (let j = 0; j < points.length; j++) {
      if (j !== i) sum += haversineKm(points[i], points[j]);
    }
    if (sum > bestSum) { bestSum = sum; bestIdx = i; }
  }
  return bestIdx;
}

/** Great-circle distance in kilometres between two {lng, lat} pts. */
export function haversineKm(a, b) {
  const R = 6371; // mean Earth radius in km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
