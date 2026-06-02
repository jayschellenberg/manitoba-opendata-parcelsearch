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

  if (n === 0) return { order: [], cost: 0, iterations: 0 };
  if (n === 1) return { order: [start], cost: 0, iterations: 0 };

  // Step 1: nearest-neighbour construction.
  const nnOrder = nearestNeighbour(cost, start);

  // Step 2: 2-opt refinement.
  const refined = twoOpt(nnOrder, cost, { roundTrip, maxIters });

  // Close the loop on output when round-trip; consumers can trust
  // order[0] === order[length-1] in that case.
  const order = roundTrip ? [...refined.order, start] : refined.order;
  const totalCost = tourCost(order, cost, roundTrip ? false : false);
  // ^ roundTrip is already baked into `order` by appending start, so
  //   tourCost doesn't need to close it again.

  return { order, cost: totalCost, iterations: refined.iterations };
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
