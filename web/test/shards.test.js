// Unit tests for assessmentShards.js.
//
// Shims `fetch` to serve a controlled set of shard JSON responses so
// we can exercise:
//   - getShardIndex caching + null on missing
//   - loadShard fetching, caching, in-flight dedup
//   - lookupInShards return-value semantics (undefined / null / row)
//   - prefetchShards parallel-fetching the right set
//   - Graceful degradation when shards aren't built yet
//
// Run: cd web && node test/shards.test.js

import assert from 'node:assert/strict';

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

// Fake-fetch helper. routes is a Map<url-substring, { status, body }>.
function installFakeFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [needle, resp] of routes.entries()) {
      if (u.includes(needle)) {
        return {
          ok: resp.status === 200,
          status: resp.status,
          async json() { return resp.body; },
        };
      }
    }
    return { ok: false, status: 404, async json() { return null; } };
  };
  return calls;
}

function shardIndexBody(muniNos) {
  return {
    version: 1,
    metadata: { generated_at: '2026-05-12T00:00:00Z', shard_count: muniNos.length, row_count: muniNos.length * 3 },
    shards: muniNos.map((m) => ({ muni_no: m, file: `${m}.json`, row_count: 3 })),
  };
}

function shardBody(muniNo, rolls) {
  return {
    version: 1,
    muni_no: muniNo,
    fields: ['muni_no', 'roll_no_txt', 'year', 'land', 'buildings', 'total', 'class', 'tax_status'],
    rows: rolls.map((r) => [muniNo, r.roll, 2026, r.land, r.buildings, r.total, r.class || '', r.tax_status || '']),
  };
}

async function withShardMod() {
  const mod = await import(`../src/assessmentShards.js?t=${Date.now()}-${Math.random()}`);
  mod._resetShards();
  return mod;
}

console.log('assessmentShards.js tests');

await test('getShardIndex — returns null when index 404s', async () => {
  installFakeFetch(new Map([['nothing-here', { status: 200, body: null }]]));
  const mod = await withShardMod();
  const idx = await mod.getShardIndex();
  assert.equal(idx, null);
});

await test('getShardIndex — returns set of muni_nos when index exists', async () => {
  installFakeFetch(new Map([
    ['assessment/_index.json', { status: 200, body: shardIndexBody([100, 200, 300]) }],
  ]));
  const mod = await withShardMod();
  const idx = await mod.getShardIndex();
  assert.ok(idx);
  assert.ok(idx.available.has(100));
  assert.ok(idx.available.has(200));
  assert.ok(idx.available.has(300));
  assert.equal(idx.metadata.shard_count, 3);
});

await test('getShardIndex — caches; second call doesn\'t re-fetch', async () => {
  const calls = installFakeFetch(new Map([
    ['assessment/_index.json', { status: 200, body: shardIndexBody([100]) }],
  ]));
  const mod = await withShardMod();
  await mod.getShardIndex();
  await mod.getShardIndex();
  await mod.getShardIndex();
  assert.equal(calls.filter((c) => c.includes('_index.json')).length, 1);
});

await test('loadShard — fetches and keys rows by roll_no_txt', async () => {
  installFakeFetch(new Map([
    ['100.json', {
      status: 200,
      body: shardBody(100, [
        { roll: '1000.000', land: 50000, buildings: 0,     total: 50000  },
        { roll: '1001.000', land: 80000, buildings: 320000, total: 400000 },
      ]),
    }],
  ]));
  const mod = await withShardMod();
  const shard = await mod.loadShard(100);
  assert.ok(shard);
  assert.equal(shard.size, 2);
  assert.ok(shard.has('1000.000'));
  assert.ok(shard.has('1001.000'));
});

await test('loadShard — concurrent calls share the in-flight Promise', async () => {
  const calls = installFakeFetch(new Map([
    ['100.json', {
      status: 200,
      body: shardBody(100, [{ roll: '1.000', land: 1, buildings: 0, total: 1 }]),
    }],
  ]));
  const mod = await withShardMod();
  const [a, b, c] = await Promise.all([mod.loadShard(100), mod.loadShard(100), mod.loadShard(100)]);
  // Same Map reference returned by all three calls.
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(calls.filter((u) => u.includes('100.json')).length, 1);
});

await test('lookupInShards — undefined when shard mode unavailable', async () => {
  installFakeFetch(new Map());  // every fetch 404s
  const mod = await withShardMod();
  const got = await mod.lookupInShards({ muni_no: 100, roll_no_txt: '1000.000' });
  assert.equal(got, undefined);
});

await test('lookupInShards — null when shard exists but row doesn\'t', async () => {
  installFakeFetch(new Map([
    ['assessment/_index.json', { status: 200, body: shardIndexBody([100]) }],
    ['100.json', { status: 200, body: shardBody(100, [{ roll: '1000.000', land: 50000, buildings: 0, total: 50000 }]) }],
  ]));
  const mod = await withShardMod();
  const got = await mod.lookupInShards({ muni_no: 100, roll_no_txt: '9999.000' });
  assert.equal(got, null);
});

await test('lookupInShards — returns row for hit', async () => {
  installFakeFetch(new Map([
    ['assessment/_index.json', { status: 200, body: shardIndexBody([100]) }],
    ['100.json', { status: 200, body: shardBody(100, [{ roll: '1000.000', land: 50000, buildings: 0, total: 50000 }]) }],
  ]));
  const mod = await withShardMod();
  const got = await mod.lookupInShards({ muni_no: 100, roll_no_txt: '1000.000' });
  assert.ok(Array.isArray(got));
  assert.equal(got[0], 100);
  assert.equal(got[1], '1000.000');
  assert.equal(got[5], 50000);
});

await test('lookupInShards — null when muni not in index (no shard for it)', async () => {
  installFakeFetch(new Map([
    ['assessment/_index.json', { status: 200, body: shardIndexBody([100]) }],
  ]));
  const mod = await withShardMod();
  const got = await mod.lookupInShards({ muni_no: 999, roll_no_txt: '1000.000' });
  assert.equal(got, null);
});

await test('prefetchShards — warms multiple munis in parallel', async () => {
  const calls = installFakeFetch(new Map([
    ['assessment/_index.json', { status: 200, body: shardIndexBody([100, 200, 300]) }],
    ['100.json', { status: 200, body: shardBody(100, [{ roll: '1.000', land: 1, buildings: 0, total: 1 }]) }],
    ['200.json', { status: 200, body: shardBody(200, [{ roll: '2.000', land: 1, buildings: 0, total: 1 }]) }],
    ['300.json', { status: 200, body: shardBody(300, [{ roll: '3.000', land: 1, buildings: 0, total: 1 }]) }],
  ]));
  const mod = await withShardMod();
  await mod.prefetchShards([100, 200, 300]);
  // Each shard fetched exactly once.
  assert.equal(calls.filter((u) => u.includes('100.json')).length, 1);
  assert.equal(calls.filter((u) => u.includes('200.json')).length, 1);
  assert.equal(calls.filter((u) => u.includes('300.json')).length, 1);
});

await test('prefetchShards — no-op when shard mode unavailable', async () => {
  installFakeFetch(new Map());
  const mod = await withShardMod();
  // Should resolve without throwing.
  await mod.prefetchShards([100, 200]);
});

await test('prefetchShards — silently skips munis without a shard registered', async () => {
  const calls = installFakeFetch(new Map([
    ['assessment/_index.json', { status: 200, body: shardIndexBody([100, 200]) }],
    ['100.json', { status: 200, body: shardBody(100, [{ roll: '1.000', land: 1, buildings: 0, total: 1 }]) }],
    ['200.json', { status: 200, body: shardBody(200, [{ roll: '2.000', land: 1, buildings: 0, total: 1 }]) }],
  ]));
  const mod = await withShardMod();
  await mod.prefetchShards([100, 200, 999]);
  assert.equal(calls.filter((u) => u.includes('999.json')).length, 0);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
