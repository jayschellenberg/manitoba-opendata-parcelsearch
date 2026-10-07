// Tests for the recent-jobs list (2026-10-07): the pure ordering and cap,
// the job identity, and that a browser without IndexedDB degrades to an
// empty list rather than throwing (node has no IndexedDB, which is exactly
// that case). Plus the charts maps' outline start zoom.
//
// Run: cd web && node test/recentJobs.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  orderAndCap, recentJobId, RECENT_JOBS_CAP, recentJobsAvailable, listRecentJobs, getRecentJob, addRecentJob,
} from '../src/lib/recentJobs.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('newest-used first, capped, and the rest handed back to delete', () => {
  const recs = Array.from({ length: 11 }, (_, i) => ({ id: `j${i}`, usedAt: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
  const { keep, drop } = orderAndCap(recs);
  assert.equal(RECENT_JOBS_CAP, 8);
  assert.deepEqual(keep.map((r) => r.id), ['j10', 'j9', 'j8', 'j7', 'j6', 'j5', 'j4', 'j3']);
  assert.deepEqual(drop.map((r) => r.id).sort(), ['j0', 'j1', 'j2']);
  assert.deepEqual(orderAndCap([null, { usedAt: 'x' }]).keep, [], 'records without an id are ignored');
});
await test('a reopened job keeps its identity (saved time + name)', () => {
  assert.equal(recentJobId({ savedAt: '2026-10-07T12:00:00Z', name: 'Subject roll 300' }), '2026-10-07T12:00:00Z|Subject roll 300');
  assert.equal(recentJobId({}), '|');
});
await test('no IndexedDB: an empty list, never a throw', async () => {
  assert.equal(recentJobsAvailable(), false);
  assert.deepEqual(await listRecentJobs(), []);
  assert.equal(await getRecentJob('x'), null);
  await addRecentJob({ name: 'a', savedAt: 'b' }, '{}');
});
await test('the charts maps start their outlines at zoom 10', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const map = readFileSync(path.join(here, '..', 'src', 'charts', 'chartMap.js'), 'utf8');
  assert.match(map, /export const OUTLINE_MINZOOM = 10;/);
  assert.equal((map.match(/minzoom: OUTLINE_MINZOOM, filter: OUTLINE_NONE,/g) || []).length, 2);
});

console.log(`\n${passed} passed`);
