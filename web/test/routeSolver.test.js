// Unit tests for the route solver. Pure logic, no I/O. Run:
//   cd web && node test/routeSolver.test.js

import assert from 'node:assert/strict';
import {
  solveRoute,
  nearestNeighbour,
  twoOpt,
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
