// Unit tests for versionedUrl in src/manifest.js — the build-stamp query that
// stops a long immutable browser cache from pinning a stale index.
//
// Run: cd web && node test/versionedUrl.test.js

import assert from 'node:assert/strict';
import { versionedUrl } from '../src/manifest.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

test('appends the build stamp, encoded', () => {
  assert.equal(versionedUrl('/api/legal-index', { generated_at: '2026-10-05T15:48:00Z' }),
    '/api/legal-index?v=2026-10-05T15%3A48%3A00Z');
});

test('each build is a different URL', () => {
  const a = versionedUrl('/api/legal-index', { generated_at: '2026-09-15T09:00:00Z' });
  const b = versionedUrl('/api/legal-index', { generated_at: '2026-10-05T15:48:00Z' });
  assert.notEqual(a, b);
});

test('falls back to modified_at, then to the bare URL', () => {
  assert.equal(versionedUrl('/x', { modified_at: 'm1' }), '/x?v=m1');
  assert.equal(versionedUrl('/x', null), '/x');
  assert.equal(versionedUrl('/x', {}), '/x');
});

test('keeps an existing query string', () => {
  assert.equal(versionedUrl('/x?a=1', { generated_at: 'g' }), '/x?a=1&v=g');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
