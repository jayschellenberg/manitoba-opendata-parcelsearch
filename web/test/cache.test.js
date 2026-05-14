// Unit tests for src/cache.js. Polyfills a tiny in-memory IndexedDB
// + localStorage so the cache wrapper exercises both backends
// without a browser. Run with:
//   cd web && node test/cache.test.js
//
// We're not chasing 100% behavioural fidelity with the real IDB
// (transactions, durability, version upgrades) — the goal is to
// validate the cache wrapper's logic: envelope shape, TTL expiry,
// fallback when IDB throws, and clearAllCache wiping both backends.

import assert from 'node:assert/strict';

// ---------- In-memory IndexedDB shim ----------

class FakeIDBRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
  _resolve(result) {
    this.result = result;
    queueMicrotask(() => this.onsuccess && this.onsuccess({ target: this }));
  }
  _reject(error) {
    this.error = error;
    queueMicrotask(() => this.onerror && this.onerror({ target: this }));
  }
}

class FakeObjectStore {
  constructor(records, txState) {
    this._records = records;
    this._tx = txState;
  }
  get(key) {
    const req = new FakeIDBRequest();
    req._resolve(this._records.has(key) ? this._records.get(key) : undefined);
    return req;
  }
  put(value, key) {
    const req = new FakeIDBRequest();
    this._records.set(key, value);
    req._resolve(undefined);
    return req;
  }
  delete(key) {
    const req = new FakeIDBRequest();
    this._records.delete(key);
    req._resolve(undefined);
    return req;
  }
  getAllKeys() {
    const req = new FakeIDBRequest();
    req._resolve([...this._records.keys()]);
    return req;
  }
}

class FakeTransaction {
  constructor(records, mode) {
    this._records = records;
    this._state = { complete: false, error: null };
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    // setTimeout (not queueMicrotask) so oncomplete fires AFTER all
    // pending request onsuccess microtasks have flushed. Real IDB
    // transactions only complete when their last request resolves;
    // microtask scheduling would deliver oncomplete before the
    // request callbacks, breaking the contract every IDB consumer
    // relies on.
    setTimeout(() => {
      this._state.complete = true;
      this.oncomplete && this.oncomplete();
    }, 0);
  }
  objectStore(/* name */) {
    return new FakeObjectStore(this._records, this._state);
  }
}

class FakeIDBDatabase {
  constructor() {
    this._stores = new Map();
    this._stores.set('cache', new Map());
    this.objectStoreNames = {
      contains: (name) => this._stores.has(name),
    };
  }
  createObjectStore(name) {
    this._stores.set(name, new Map());
  }
  transaction(name /* , mode */) {
    return new FakeTransaction(this._stores.get(name));
  }
}

function makeFakeIndexedDB() {
  let db = null;
  return {
    open(/* name, version */) {
      const req = new FakeIDBRequest();
      // Synchronously create the DB so onupgradeneeded fires first.
      db = new FakeIDBDatabase();
      // Fire upgradeneeded → success.
      queueMicrotask(() => {
        if (req.onupgradeneeded) req.onupgradeneeded({ target: { result: db } });
        req.result = db;
        queueMicrotask(() => req.onsuccess && req.onsuccess({ target: req }));
      });
      return req;
    },
  };
}

// ---------- Minimal localStorage shim ----------

function makeFakeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
}

// ---------- Test harness ----------

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

// ---------- Tests ----------

async function withFreshCache({ idbAvailable = true } = {}) {
  globalThis.indexedDB = idbAvailable ? makeFakeIndexedDB() : undefined;
  globalThis.localStorage = makeFakeStorage();
  globalThis.sessionStorage = makeFakeStorage();
  // Cache module captures `idbAvailable` at module load → bust import cache
  // by appending a unique query string.
  const mod = await import(`../src/cache.js?t=${Date.now()}-${Math.random()}`);
  return mod;
}

console.log('cache.js tests');

await test('IDB round-trip — write then read returns value', async () => {
  const { writeCache, readCache } = await withFreshCache();
  await writeCache('roundtrip', { hello: 'world' });
  const got = await readCache('roundtrip', 60_000);
  assert.deepEqual(got, { hello: 'world' });
});

await test('IDB round-trip — preserves arrays', async () => {
  const { writeCache, readCache } = await withFreshCache();
  await writeCache('arr', [1, 2, 3]);
  const got = await readCache('arr', 60_000);
  assert.deepEqual(got, [1, 2, 3]);
});

await test('TTL expiry — returns null for stale entry', async () => {
  const { writeCache, readCache } = await withFreshCache();
  await writeCache('expiring', { v: 1 });
  // Wait a bit, then read with a 1-ms TTL.
  await new Promise((r) => setTimeout(r, 5));
  const got = await readCache('expiring', 1);
  assert.equal(got, null);
});

await test('Missing key returns null', async () => {
  const { readCache } = await withFreshCache();
  const got = await readCache('does-not-exist', 60_000);
  assert.equal(got, null);
});

await test('Fallback to localStorage when IDB unavailable', async () => {
  const { writeCache, readCache } = await withFreshCache({ idbAvailable: false });
  await writeCache('fallback', { ok: true });
  const got = await readCache('fallback', 60_000);
  assert.deepEqual(got, { ok: true });
  // Verify it actually landed in localStorage with the namespace prefix.
  assert.ok(globalThis.localStorage.getItem('mbpsCache.fallback'));
});

await test('Reads legacy localStorage entries written by older code', async () => {
  const { readCache } = await withFreshCache({ idbAvailable: false });
  // Pre-seed localStorage with a legacy entry under the same namespace.
  globalThis.localStorage.setItem(
    'mbpsCache.legacy',
    JSON.stringify({ v: { from: 'localStorage' }, t: Date.now() }),
  );
  const got = await readCache('legacy', 60_000);
  assert.deepEqual(got, { from: 'localStorage' });
});

await test('clearAllCache wipes both backends', async () => {
  const { writeCache, readCache, clearAllCache } = await withFreshCache();
  await writeCache('a', { n: 1 });
  await writeCache('b', { n: 2 });
  // Also seed a value directly in localStorage (legacy entry).
  globalThis.localStorage.setItem(
    'mbpsCache.c',
    JSON.stringify({ v: { n: 3 }, t: Date.now() }),
  );
  await clearAllCache();
  assert.equal(await readCache('a', 60_000), null);
  assert.equal(await readCache('b', 60_000), null);
  assert.equal(await readCache('c', 60_000), null);
  // Non-namespaced key stays untouched.
  globalThis.localStorage.setItem('unrelated', 'keep me');
  const { clearAllCache: clearAgain } = await import(`../src/cache.js?t=${Date.now()}-${Math.random()}`);
  await clearAgain();
  assert.equal(globalThis.localStorage.getItem('unrelated'), 'keep me');
});

await test('Overwriting a key updates the value', async () => {
  const { writeCache, readCache } = await withFreshCache();
  await writeCache('overwrite', { v: 1 });
  await writeCache('overwrite', { v: 2 });
  const got = await readCache('overwrite', 60_000);
  assert.deepEqual(got, { v: 2 });
});

await test('Large GeoJSON-ish payload round-trips through IDB', async () => {
  const { writeCache, readCache } = await withFreshCache();
  const big = {
    type: 'FeatureCollection',
    features: Array.from({ length: 2000 }, (_, i) => ({
      type: 'Feature',
      properties: { OBJECTID: i, Roll_No_Txt: `${1000 + i}.000` },
      geometry: { type: 'Point', coordinates: [-97 + i * 0.001, 49 + i * 0.001] },
    })),
  };
  await writeCache('big', big);
  const got = await readCache('big', 60_000);
  assert.equal(got.features.length, 2000);
  assert.equal(got.features[1999].properties.OBJECTID, 1999);
});

// ---------- Summary ----------

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  process.exit(1);
}
