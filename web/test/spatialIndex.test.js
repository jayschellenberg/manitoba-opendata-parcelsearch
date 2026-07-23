// Unit tests for lib/spatialIndex.js — the uniform-grid broad phase
// behind joinTopNByArea. The critical property is COMPLETENESS: the
// index may return extra candidates, but it must never omit a real
// overlap, or parcels would silently lose their zoning.
//
// Run: cd web && node test/spatialIndex.test.js

import assert from 'node:assert/strict';
import { buildBboxIndex, queryBboxIndex, bboxesOverlap } from '../src/lib/spatialIndex.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const bx = (minX, minY, maxX, maxY) => [minX, minY, maxX, maxY];
const sortNum = (a) => a.slice().sort((x, y) => x - y);

/** Brute-force truth: every index whose bbox really overlaps. */
function linearMatches(bboxes, q) {
  const out = [];
  for (let i = 0; i < bboxes.length; i++) {
    if (bboxes[i] && bboxesOverlap(bboxes[i], q)) out.push(i);
  }
  return out;
}

console.log('bboxesOverlap');

test('overlapping, touching and disjoint boxes', () => {
  assert.equal(bboxesOverlap(bx(0, 0, 2, 2), bx(1, 1, 3, 3)), true);
  assert.equal(bboxesOverlap(bx(0, 0, 1, 1), bx(1, 1, 2, 2)), true);   // edge touch
  assert.equal(bboxesOverlap(bx(0, 0, 1, 1), bx(2, 2, 3, 3)), false);
  assert.equal(bboxesOverlap(null, bx(0, 0, 1, 1)), false);
});

console.log('\nbuildBboxIndex');

test('an empty or all-null set yields no index', () => {
  assert.equal(buildBboxIndex([]), null);
  assert.equal(buildBboxIndex(null), null);
  assert.equal(buildBboxIndex([null, undefined]), null);
});

test('null and non-finite entries are skipped, not indexed', () => {
  const boxes = [bx(0, 0, 1, 1), null, bx(NaN, 0, 1, 1), bx(2, 2, 3, 3)];
  const idx = buildBboxIndex(boxes);
  assert.equal(idx.itemCount, 2);
  const hits = queryBboxIndex(idx, bx(-10, -10, 10, 10));
  assert.deepEqual(sortNum(hits), [0, 3]);
});

test('a single item indexes without dividing by zero', () => {
  const idx = buildBboxIndex([bx(5, 5, 5, 5)]);
  assert.deepEqual(queryBboxIndex(idx, bx(4, 4, 6, 6)), [0]);
});

test('collinear items (zero-height extent) still index', () => {
  // Broad phase: the contract is "contains every true overlap", not
  // "contains only true overlaps". A degenerate extent collapses the
  // grid, so extra candidates here are expected and harmless.
  const boxes = [bx(0, 0, 1, 0), bx(2, 0, 3, 0), bx(4, 0, 5, 0)];
  const idx = buildBboxIndex(boxes);
  const q = bx(1.9, -1, 3.1, 1);
  const hits = new Set(queryBboxIndex(idx, q));
  for (const t of linearMatches(boxes, q)) assert.ok(hits.has(t), `missed ${t}`);
});

console.log('\nqueryBboxIndex');

test('finds an item that spans many cells from any point over it', () => {
  // A large item is registered in every cell it covers; querying any
  // part of it must find it.
  const boxes = [];
  for (let i = 0; i < 200; i++) boxes.push(bx(i, i, i + 0.5, i + 0.5));
  boxes.push(bx(0, 0, 200, 200));            // spans the whole grid
  const idx = buildBboxIndex(boxes);
  const big = boxes.length - 1;
  for (const q of [bx(1, 1, 1.1, 1.1), bx(99, 99, 99.1, 99.1), bx(199, 199, 199.1, 199.1)]) {
    assert.ok(queryBboxIndex(idx, q).includes(big), `missed the spanning item at ${q}`);
  }
});

test('returns each item at most once even when it spans the query', () => {
  const boxes = [bx(0, 0, 10, 10), bx(1, 1, 2, 2)];
  const idx = buildBboxIndex(boxes);
  const hits = queryBboxIndex(idx, bx(0, 0, 10, 10));
  assert.equal(new Set(hits).size, hits.length, 'duplicate indices returned');
});

test('successive queries do not leak state into each other', () => {
  // The stamp array is reused across queries; a stale mark would make a
  // later query silently drop items. Uses enough items to get a real
  // multi-cell grid — with 2 items the grid is 1x1 and every query
  // trivially returns everything, which would prove nothing.
  const boxes = [];
  for (let i = 0; i < 400; i++) boxes.push(bx(i, i, i + 0.5, i + 0.5));
  const idx = buildBboxIndex(boxes);
  const probe = (i) => new Set(queryBboxIndex(idx, boxes[i]));
  // Same probe repeated, and interleaved with others, must be stable.
  for (const i of [0, 137, 399, 0, 137, 0, 399]) {
    assert.ok(probe(i).has(i), `query for item ${i} lost itself`);
  }
  // A wide query after narrow ones must still see everything it covers.
  const wide = new Set(queryBboxIndex(idx, bx(-1, -1, 401, 401)));
  for (let i = 0; i < 400; i++) assert.ok(wide.has(i), `wide query missed ${i}`);
});

test('a query outside the indexed extent still behaves', () => {
  const idx = buildBboxIndex([bx(0, 0, 1, 1)]);
  // Clamping puts a far-away query in an edge cell; it may return the
  // candidate, but callers re-test precisely, so the contract is only
  // that it must not throw.
  assert.doesNotThrow(() => queryBboxIndex(idx, bx(1000, 1000, 1001, 1001)));
});

test('null index / null query are safe', () => {
  assert.deepEqual(queryBboxIndex(null, bx(0, 0, 1, 1)), []);
  assert.deepEqual(queryBboxIndex(buildBboxIndex([bx(0, 0, 1, 1)]), null), []);
  assert.deepEqual(queryBboxIndex(buildBboxIndex([bx(0, 0, 1, 1)]), bx(NaN, 0, 1, 1)), []);
});

console.log('\ncompleteness vs brute force');

test('never misses a real overlap across 2000 randomised queries', () => {
  // THE property that matters. A miss here means a parcel silently
  // loses its zoning, which looks like data rather than like a bug.
  // Deterministic LCG so a failure is reproducible.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const boxes = [];
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * 1000, y = rnd() * 1000;
    // Mixed sizes, including a few very large ones.
    const w = rnd() < 0.02 ? rnd() * 300 : rnd() * 5;
    const h = rnd() < 0.02 ? rnd() * 300 : rnd() * 5;
    boxes.push(bx(x, y, x + w, y + h));
  }
  const idx = buildBboxIndex(boxes);

  for (let q = 0; q < 2000; q++) {
    const x = rnd() * 1000, y = rnd() * 1000;
    const qb = bx(x, y, x + rnd() * 8, y + rnd() * 8);
    const truth = linearMatches(boxes, qb);
    const candidates = new Set(queryBboxIndex(idx, qb));
    for (const t of truth) {
      assert.ok(candidates.has(t),
        `query ${q} missed item ${t}: query=${JSON.stringify(qb)} item=${JSON.stringify(boxes[t])}`);
    }
  }
});

test('prunes hard enough to be worth having', () => {
  // Not a timing assertion (flaky in CI); a work-ratio assertion.
  let seed = 999;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const boxes = [];
  for (let i = 0; i < 5000; i++) {
    const x = rnd() * 1000, y = rnd() * 1000;
    boxes.push(bx(x, y, x + 1, y + 1));
  }
  const idx = buildBboxIndex(boxes);
  let candidates = 0;
  const QUERIES = 500;
  for (let q = 0; q < QUERIES; q++) {
    const x = rnd() * 1000, y = rnd() * 1000;
    candidates += queryBboxIndex(idx, bx(x, y, x + 1, y + 1)).length;
  }
  const perQuery = candidates / QUERIES;
  // Linear scan would test all 5000 every time.
  assert.ok(perQuery < 100, `expected heavy pruning, got ${perQuery.toFixed(1)} candidates/query`);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
