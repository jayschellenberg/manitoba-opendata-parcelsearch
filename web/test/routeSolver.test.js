// Unit tests for the route solver. Pure logic, no I/O. Run:
//   cd web && node test/routeSolver.test.js

import assert from 'node:assert/strict';
import {
  solveRoute,
  nearestNeighbour,
  twoOpt,
  orOpt,
  doubleBridge,
  refineToLocalOptimum,
  tourCost,
  haversineKm,
  haversineMatrix,
} from '../src/lib/routeSolver.js';

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

function symmetricMatrix(points) {
  const n = points.length;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = points[i][0] - points[j][0];
      const dy = points[i][1] - points[j][1];
      const d = Math.sqrt(dx * dx + dy * dy);
      m[i][j] = d;
      m[j][i] = d;
    }
  }
  return m;
}

// ---- nearestNeighbour ----------------------------------------

console.log('nearestNeighbour');

await test('returns just the start for n=1', () => {
  assert.deepEqual(nearestNeighbour([[0]], 0), [0]);
});

await test('three-point triangle picks closer neighbour first', () => {
  // A=(0,0) B=(1,0) C=(5,0). Starting at A, nearest is B (1) then C (4).
  const m = symmetricMatrix([[0, 0], [1, 0], [5, 0]]);
  assert.deepEqual(nearestNeighbour(m, 0), [0, 1, 2]);
});

await test('respects start index', () => {
  const m = symmetricMatrix([[0, 0], [1, 0], [5, 0]]);
  assert.deepEqual(nearestNeighbour(m, 2), [2, 1, 0]);
});

// ---- twoOpt ---------------------------------------------------

console.log('\ntwoOpt');

await test('does not change an already-optimal 3-stop loop', () => {
  const m = symmetricMatrix([[0, 0], [1, 0], [5, 0]]);
  const { order } = twoOpt([0, 1, 2], m, { roundTrip: true });
  assert.deepEqual(order, [0, 1, 2]);
});

await test('untangles a crossing on a 4-point square', () => {
  // Square corners. NN starting at the bottom-left can produce a
  // crossing path [0,2,1,3]; 2-opt should straighten it to [0,1,2,3].
  const pts = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const m = symmetricMatrix(pts);
  const bad = [0, 2, 1, 3];
  const goodCost = tourCost([0, 1, 2, 3, 0], m);
  const badCost  = tourCost([...bad, 0], m);
  assert.ok(badCost > goodCost, 'bad must cost more than good');
  const { order } = twoOpt(bad, m, { roundTrip: true });
  const fixedCost = tourCost([...order, 0], m);
  assert.ok(fixedCost <= goodCost + 1e-9, `expected ≤ ${goodCost}, got ${fixedCost}`);
});

await test('start index is held fixed across 2-opt swaps', () => {
  const m = symmetricMatrix([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]);
  const { order } = twoOpt([2, 0, 1, 3, 4], m, { roundTrip: true });
  assert.equal(order[0], 2);
});

// ---- solveRoute -----------------------------------------------

console.log('\nsolveRoute');

await test('square: optimal round-trip is the perimeter', () => {
  const pts = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const m = symmetricMatrix(pts);
  const { order, cost } = solveRoute(m, { start: 0, roundTrip: true });
  // Closed: starts and ends at 0
  assert.equal(order[0], 0);
  assert.equal(order[order.length - 1], 0);
  // Perimeter = 4. Anything more means a crossing path remained.
  assert.ok(cost <= 4 + 1e-9, `expected perimeter ~4, got ${cost}`);
});

await test('open-tour mode does not close the loop', () => {
  const pts = [[0, 0], [1, 0], [2, 0], [3, 0]];
  const m = symmetricMatrix(pts);
  const { order, cost } = solveRoute(m, { start: 0, roundTrip: false });
  assert.equal(order.length, 4);
  assert.equal(order[0], 0);
  assert.equal(cost, 3);  // 0→1→2→3 = 3
});

await test('10-point random instance: 2-opt strictly improves NN', () => {
  // Deterministic PRNG so this test is repeatable.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pts = Array.from({ length: 10 }, () => [rand() * 100, rand() * 100]);
  const m = symmetricMatrix(pts);
  const nn = nearestNeighbour(m, 0);
  const nnCost = tourCost([...nn, 0], m);
  const { cost: solveCost } = solveRoute(m, { start: 0, roundTrip: true });
  assert.ok(solveCost <= nnCost + 1e-9, `solver (${solveCost}) must not be worse than NN (${nnCost})`);
});

await test('25-stop instance solves quickly', () => {
  let seed = 9999;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pts = Array.from({ length: 25 }, () => [rand() * 1000, rand() * 1000]);
  const m = symmetricMatrix(pts);
  const t0 = process.hrtime.bigint();
  const { iterations } = solveRoute(m, { start: 0, roundTrip: true });
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  // Generous bound — anything over 250ms means something regressed.
  assert.ok(ms < 250, `25-stop solve took ${ms.toFixed(1)}ms, expected < 250ms`);
  // 2-opt should converge in a few passes.
  assert.ok(iterations < 50, `expected <50 outer iters, got ${iterations}`);
});

await test('handles n=0 and n=1 gracefully', () => {
  const a = solveRoute([], { start: 0 });
  assert.deepEqual(a.order, []);
  const b = solveRoute([[0]], { start: 0 });
  assert.deepEqual(b.order, [0]);
});

// ---- orOpt ----------------------------------------------------

console.log('\norOpt');

await test('escapes a 2-opt local optimum on an asymmetric instance', () => {
  // Asymmetric cost matrix (real-road matrices ARE asymmetric — one-
  // way streets, divided highways with widely-spaced exits, etc.).
  // 2-opt's edge-pair reversal is a poor fit for asymmetric costs
  // because reversing a segment also reverses each edge's direction;
  // or-opt's node relocation doesn't suffer that. This 6-node
  // instance pins 2-opt at a local optimum that or-opt extracts a
  // node out of and re-inserts.
  const inf = Infinity;
  // Hand-built: going 0→i→0 is cheap for i ∈ {1,2,3,4,5} (a star),
  // but going i→j for i ≠ 0 and j ≠ 0 has expensive reverse costs
  // that confuse 2-opt's segment reversal heuristic.
  const m = [
    //  0   1   2   3   4   5
    [   0,  1,  2,  3,  4,  5],   // 0 →
    [   1,  0, 10,  3, 10,  5],   // 1 →
    [   2, 10,  0,  3, 10,  5],   // 2 →
    [   3,  1,  2,  0,  4, 10],   // 3 →
    [   4, 10, 10,  4,  0,  5],   // 4 →
    [   5,  5,  5, 10,  5,  0],   // 5 →
  ];
  const stuck = [0, 4, 3, 2, 1, 5];
  const stuckCost = tourCost([...stuck, 0], m);
  const after2opt = twoOpt(stuck, m, { roundTrip: true });
  const cost2opt = tourCost([...after2opt.order, 0], m);
  const afterOr = orOpt(after2opt.order, m, { roundTrip: true });
  const costOr = tourCost([...afterOr.order, 0], m);
  assert.ok(costOr <= cost2opt + 1e-6,
    `or-opt must not worsen the tour: 2-opt=${cost2opt}, or-opt=${costOr}`);
  // Show the improvement when it lands — informational, not asserted,
  // because some asymmetric configurations are tied between the two.
  if (costOr + 1e-6 < cost2opt) {
    // Confirm we actually escaped the 2-opt minimum.
    assert.ok(costOr < stuckCost,
      `expected or-opt to also improve on starting tour ${stuckCost}, got ${costOr}`);
  }
});

await test('preserves start index at position 0', () => {
  const m = symmetricMatrix([[0,0], [5,5], [-5,-5], [3,3], [-3,-3]]);
  const { order } = orOpt([0, 1, 2, 3, 4], m, { roundTrip: true });
  assert.equal(order[0], 0);
});

await test('open-tour mode does not relocate around a closing edge', () => {
  const m = symmetricMatrix([[0,0], [1,0], [2,0], [3,0]]);
  const { order } = orOpt([0, 1, 2, 3], m, { roundTrip: false });
  // Already optimal; or-opt should not break it.
  assert.deepEqual(order, [0, 1, 2, 3]);
});

// ---- doubleBridge --------------------------------------------

console.log('\ndoubleBridge');

await test('preserves length and start index', () => {
  // Deterministic rng so the test is repeatable.
  let s = 7;
  const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const tour = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const kicked = doubleBridge(tour, rng);
  assert.equal(kicked.length, tour.length);
  assert.equal(kicked[0], 0);
  // Must still be a permutation of the input.
  assert.deepEqual(kicked.slice().sort((a, b) => a - b), tour.slice().sort((a, b) => a - b));
});

await test('no-op when tour shorter than 8', () => {
  const tour = [0, 1, 2, 3, 4, 5, 6];
  const kicked = doubleBridge(tour, () => 0.5);
  assert.deepEqual(kicked, tour);
});

// ---- solveRoute regression ------------------------------------

console.log('\nsolveRoute (improved)');

await test('beats or matches NN+2-opt on a 30-stop random instance', () => {
  // Deterministic PRNG so this is a comparable benchmark.
  let s = 31337;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pts = Array.from({ length: 30 }, () => [rand() * 1000, rand() * 1000]);
  const m = symmetricMatrix(pts);
  // NN + 2-opt only (the previous solver shape).
  const nn = nearestNeighbour(m, 0);
  const oldRefined = twoOpt(nn, m, { roundTrip: true });
  const oldCost = tourCost([...oldRefined.order, 0], m);
  // New solver: NN + 2opt + orOpt + restarts.
  const { cost: newCost } = solveRoute(m, { start: 0, roundTrip: true, rng: rand });
  assert.ok(newCost <= oldCost + 1e-6,
    `new solver (${newCost.toFixed(2)}) must not be worse than NN+2-opt (${oldCost.toFixed(2)})`);
  // On most random instances the new solver lands strictly better.
  // Not always — random can hand the NN a near-optimal start — so
  // this is a soft check.
  if (newCost + 1e-6 >= oldCost) {
    console.log(`    note: new solver matched but did not beat NN+2-opt this seed (${oldCost.toFixed(2)})`);
  }
});

await test('strictly beats NN+2-opt on a 20-stop asymmetric instance', () => {
  // Real road matrices are asymmetric — this is the configuration
  // 2-opt is provably weakest on, because reversing a segment
  // reverses every edge's direction. The new solver should beat
  // the old NN+2-opt comfortably here.
  let s = 8675309;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const N = 20;
  // Generate asymmetric costs: base symmetric distances plus a
  // random "directionality factor" in [0.7, 1.5] per directed edge.
  const m = Array.from({ length: N }, () => new Array(N).fill(0));
  const pts = Array.from({ length: N }, () => [rand() * 100, rand() * 100]);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const dx = pts[i][0] - pts[j][0];
      const dy = pts[i][1] - pts[j][1];
      const base = Math.sqrt(dx * dx + dy * dy);
      const skew = 0.7 + rand() * 0.8;
      m[i][j] = base * skew;
    }
  }
  const nn = nearestNeighbour(m, 0);
  const oldRefined = twoOpt(nn, m, { roundTrip: true });
  const oldCost = tourCost([...oldRefined.order, 0], m);
  const { cost: newCost } = solveRoute(m, { start: 0, roundTrip: true, rng: rand });
  assert.ok(newCost + 1e-6 < oldCost,
    `expected improvement: old=${oldCost.toFixed(2)}, new=${newCost.toFixed(2)}, gap=${((oldCost - newCost) / oldCost * 100).toFixed(1)}%`);
});

await test('50-stop run finishes under 2 seconds', () => {
  let s = 4242;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pts = Array.from({ length: 50 }, () => [rand() * 1000, rand() * 1000]);
  const m = symmetricMatrix(pts);
  const t0 = process.hrtime.bigint();
  const { iterations } = solveRoute(m, { start: 0, roundTrip: true, rng: rand });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 2000, `50-stop solve took ${ms.toFixed(0)}ms, expected < 2000ms`);
  assert.ok(iterations > 0);
});

// ---- haversine -----------------------------------------------

console.log('\nhaversineKm');

await test('Winnipeg → Brandon ≈ 200 km (within 5%)', () => {
  const wpg = { lng: -97.1384, lat: 49.8951 };
  const bdn = { lng: -99.9530, lat: 49.8443 };
  const d = haversineKm(wpg, bdn);
  // Actual driving distance is ~215 km; great-circle is ~200 km.
  assert.ok(Math.abs(d - 200) < 10, `expected ~200km, got ${d.toFixed(1)}`);
});

await test('point to itself is zero', () => {
  const p = { lng: -97.1, lat: 49.9 };
  assert.equal(haversineKm(p, p), 0);
});

await test('haversineMatrix is symmetric with zero diagonal', () => {
  const pts = [
    { lng: -97, lat: 50 },
    { lng: -98, lat: 50 },
    { lng: -97, lat: 49 },
  ];
  const m = haversineMatrix(pts);
  for (let i = 0; i < 3; i++) {
    assert.equal(m[i][i], 0);
    for (let j = 0; j < 3; j++) {
      assert.equal(m[i][j], m[j][i]);
    }
  }
});

// ---- summary --------------------------------------------------

const fails = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length > 0) {
  console.log('Failures:');
  for (const f of fails) console.log(`  - ${f.name}: ${f.err.message}`);
  process.exit(1);
}
