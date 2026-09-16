// Scheduled wrappers: a log write must never be able to kill the job.
//
// WHY THIS EXISTS. Every wrapper in this repo writes its log to a `logs\`
// directory under D:\Dropbox, and something on this machine briefly opens a
// file it has just seen -- Dropbox's hasher, or Defender's real-time scan.
// Under `$ErrorActionPreference = 'Stop'` an unprotected `Add-Content` is then
// not a lost log line, it is a dead run.
//
// That is not hypothetical, and the retry is not belt-and-braces:
//   * 2026-08-09  mao-assembly's refresh-monthly-wrapper.ps1 died on its
//                 SECOND log line. Two days of refreshes silently did nothing.
//   * 2026-09-16  mb-parcelsearch-parcel-tiles died FOUR lines in, on the
//                 first run that actually had a new gpkg to tile. The task
//                 reported "exit 1" and nothing else; the alert path never
//                 ran, because Fail() logs before it alerts. The month's tile
//                 rebuild was lost and the archive stayed a month stale.
//
// MAINTENANCE.md ("Scheduled tasks: logs live inside Dropbox") records the
// other mitigation -- marking `logs\` with the com.dropbox.ignored stream.
// The 2026-09-16 failure happened WITH that flag set and verified, so the
// ignore flag does not remove the cause, and the retry is the only protection
// that travels with the code.
//
// Five wrappers were fixed one at a time as they each failed. This test is
// what stops the sixth from being found the same way: it fails on any
// EAP=Stop script that writes a log line without a retry around it.
//
// Run: cd web && node test/wrapperLogging.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** Comments stripped before asserting on source: a test that matches the prose
 *  explaining the fix proves only that someone wrote the prose. Same helper as
 *  hpiParsing.test.js -- PowerShell comments run from an unquoted # to end of
 *  line. */
function stripPsComments(text) {
  return text.split('\n').map((line) => {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '`') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '#') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

const scripts = fs.readdirSync(repo)
  .filter((f) => f.endsWith('.ps1'))
  .map((f) => ({ name: f, lines: stripPsComments(fs.readFileSync(path.join(repo, f), 'utf8')).split('\n') }));

/** A wrapper is in scope when a failed log write would be TERMINATING for it.
 *  Scripts running under 'Continue' pay a lost line instead of a lost run --
 *  semiannual-publish-wrapper.ps1 is deliberately one of those. */
const eapStop = scripts.filter((s) =>
  s.lines.some((l) => /\$ErrorActionPreference\s*=\s*['"]Stop['"]/.test(l)));

/** An Add-Content is protected when it sits inside a try whose catch sleeps
 *  and loops -- i.e. the house retry, not a bare try/catch that swallows the
 *  first failure and moves on. Window is deliberately tight: the retry idiom
 *  used across this repo is five lines long. */
function isProtected(lines, i) {
  const before = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
  const after = lines.slice(i, i + 7).join('\n');
  return /\btry\b\s*\{/.test(before)
    && /\bcatch\b/.test(after)
    && /Start-Sleep/.test(after)
    && /\b(for|while|do)\b/.test(lines.slice(Math.max(0, i - 6), i + 1).join('\n'));
}

test('every Add-Content in an EAP=Stop wrapper is inside a retry', () => {
  const bare = [];
  for (const s of eapStop) {
    s.lines.forEach((line, i) => {
      if (!/\bAdd-Content\b/.test(line)) return;
      if (!isProtected(s.lines, i)) bare.push(`${s.name}:${i + 1}`);
    });
  }
  assert.deepEqual(bare, [],
    `unprotected log write(s) under $ErrorActionPreference='Stop' -- a Dropbox or\n`
    + `    antivirus lock on the log file would kill the whole run:\n      `
    + bare.join('\n      '));
});

// The scan above passes trivially if it finds nothing, and a renamed wrapper or
// a logger rewritten onto Out-File would empty it silently. Pin the two scripts
// whose unattended runs this test was written for, and the shape of the scan.
test('the scan actually covers the wrappers it was written for', () => {
  const covered = eapStop.map((s) => s.name);
  for (const f of ['rebuild-parcel-tiles.ps1', 'landfacts-refresh-wrapper.ps1',
    'auto-publish-indexes.ps1', 'hpi-download.ps1']) {
    assert.ok(covered.includes(f),
      `${f} is no longer scanned -- did it lose $ErrorActionPreference='Stop', or get renamed?`);
    const s = eapStop.find((x) => x.name === f);
    assert.ok(s.lines.some((l) => /\bAdd-Content\b/.test(l)),
      `${f} no longer writes its log with Add-Content -- if it moved to a redirection or `
      + `Out-File, this test no longer guards it and the rule above needs to cover that form.`);
  }
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
