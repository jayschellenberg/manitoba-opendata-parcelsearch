// Test runner — executes every test/*.test.js in its own node process,
// sequentially, and reports a summary at the end. Unlike the previous
// `a && b && c` chain in package.json, a failing file no longer hides
// the files after it: everything always runs, and the process exits
// nonzero if any file failed.
//
// Run: cd web && npm test            (live-network tests self-skip)
//      RUN_LIVE_TESTS=1 npm test     (include the ArcGIS integration test)

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

const failures = [];
for (const file of files) {
  console.log(`\n── ${file} ${'─'.repeat(Math.max(2, 52 - file.length))}`);
  const res = spawnSync(process.execPath, [path.join(dir, file)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (res.status !== 0) failures.push(file);
}

console.log(`\n${'═'.repeat(56)}`);
if (failures.length === 0) {
  console.log(`All ${files.length} test files passed.`);
} else {
  console.log(`${files.length - failures.length}/${files.length} test files passed. FAILED:`);
  for (const file of failures) console.log(`  ✗ ${file}`);
  process.exit(1);
}
