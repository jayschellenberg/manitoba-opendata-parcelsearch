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

/** WHAT THIS SCAN COVERS.
 *
 *  The home repo, plus sibling repos under MBOpenData that run scheduled tasks
 *  and have no test runner of their own to carry this rule. mao-assembly is why
 *  that clause exists: its refresh-monthly-wrapper.ps1 is where the 2026-08-09
 *  failure above actually happened, and nothing had guarded it since.
 *
 *  NOT mao-scrape: it has tests/testthat/test-wrapper-logging.R, the same two
 *  rules in its own runner, so scanning it here would report one finding in two
 *  places. NOT MBFloodMapping: both its scripts deliberately run under
 *  'Continue' (schtasks reports "task not found" on stderr), so they pay a lost
 *  line instead of a lost run and the rule does not apply.
 *
 *  And one level of subdirectories, because a wrapper that moves into r\ is
 *  still a wrapper. r\build_ortho_tiles.ps1 carried two unguarded captures
 *  until 2026-09-18 purely because this scan used to stop at the repo root. */
const SIBLINGS_WITHOUT_A_RUNNER = ['mao-assembly'];

function ps1sIn(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.ps1')) out.push(e.name);
    else if (e.isDirectory() && !['node_modules', '.git', 'logs'].includes(e.name)) {
      try {
        for (const f of fs.readdirSync(path.join(dir, e.name))) {
          if (f.endsWith('.ps1')) out.push(path.join(e.name, f));
        }
      } catch { /* unreadable directory -- not this test's business */ }
    }
  }
  return out;
}

const scripts = [
  { label: '', dir: repo },
  ...SIBLINGS_WITHOUT_A_RUNNER.map((s) => ({ label: `${s}/`, dir: path.join(repo, '..', s) })),
].flatMap(({ label, dir }) => ps1sIn(dir).map((f) => ({
  name: label + f,
  lines: stripPsComments(fs.readFileSync(path.join(dir, f), 'utf8')).split('\n'),
})));

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

// ---------------------------------------------------------------------------
// Second rule, same failure shape: a native command's ordinary progress must
// not be able to kill the run either.
//
// R's message(), tippecanoe's "Read 0.00 million features", curl's meter and
// rclone's --stats all go to STDERR. Under `$ErrorActionPreference = 'Stop'`
// Windows PowerShell 5.1 -- which is what `powershell.exe` in every registered
// task action means -- turns the FIRST such line into a terminating
// NativeCommandError. So `$out = & tool ... 2>&1` ends the script on a run
// where nothing is wrong.
//
// Found on 2026-09-16: with the logging fix above in place, the tile rebuild
// got as far as step 2 and died on tippecanoe's first progress line. The
// scheduled tile rebuild had therefore never once been able to complete. The
// same two calls sit in landfacts-refresh-wrapper.ps1 and du-snapshot-wrapper.ps1.
//
// Guarded means EAP is dropped to 'Continue' around the call and restored after
// -- the house Invoke-Native / Invoke-Step shape. $LASTEXITCODE is what these
// scripts gate on, so nothing is lost by it. Note that `*>> $log` file
// redirection does NOT have this problem (auto-publish-indexes.ps1 has used it
// unattended for months); only the `2>&1` merge does.
function unguardedNativeCaptures(lines) {
  const bad = [];
  lines.forEach((line, i) => {
    if (!/2>&1/.test(line)) return;
    if (!/(^|\s|=)&\s*[$\w'"]/.test(line)) return;      // an invocation, not prose
    if (/Invoke-Native/.test(line)) return;             // routed through the guard
    const before = lines.slice(Math.max(0, i - 12), i).join('\n');
    if (/\$ErrorActionPreference\s*=\s*['"]Continue['"]/.test(before)) return;
    bad.push(i + 1);
  });
  return bad;
}

test('the native-stderr detector flags what it is meant to flag', () => {
  const unguarded = [
    "$ErrorActionPreference = 'Stop'",
    "$out = & Rscript 'r\\export.R' 2>&1",
  ];
  const guarded = [
    "$ErrorActionPreference = 'Stop'",
    '$prevEAP = $ErrorActionPreference',
    "$ErrorActionPreference = 'Continue'",
    'try { & $Exe @Arguments 2>&1 }',
    'finally { $ErrorActionPreference = $prevEAP }',
  ];
  assert.deepEqual(unguardedNativeCaptures(unguarded), [2],
    'the detector missed a bare `& tool ... 2>&1` under Stop -- it would pass anything');
  assert.deepEqual(unguardedNativeCaptures(guarded), [],
    'the detector flagged the house guard -- it would have to be worked around, and would be');
});

test('every native 2>&1 capture in an EAP=Stop wrapper drops the preference', () => {
  const bare = [];
  for (const s of eapStop) {
    for (const n of unguardedNativeCaptures(s.lines)) bare.push(`${s.name}:${n}`);
  }
  assert.deepEqual(bare, [],
    `native command capture(s) under $ErrorActionPreference='Stop' -- the tool's first\n`
    + `    line of progress on STDERR would kill the run:\n      `
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

// The two rules above are only worth as much as the scan's reach, and the reach
// is the part that has silently shrunk before. Pin both widenings.
test('the scan still reaches the siblings and subdirectories it was widened for', () => {
  const covered = eapStop.map((s) => s.name);

  // mao-assembly has no runner of its own. If this stops reaching it, the repo
  // where the 2026-08-09 failure actually happened goes back to being unguarded
  // -- and nothing else in the fleet would notice.
  assert.ok(covered.includes('mao-assembly/refresh-monthly-wrapper.ps1'),
    'mao-assembly/refresh-monthly-wrapper.ps1 is not being scanned. Is mao-assembly still '
    + 'checked out beside this repo? It has no test runner of its own, so this scan is the '
    + 'only thing standing between it and a repeat of 2026-08-09.');

  // One level down, which is exactly where r\build_ortho_tiles.ps1 sat unguarded.
  assert.ok(covered.some((n) => /[\\/]/.test(n) && !n.startsWith('mao-assembly')),
    'the scan is no longer reaching any subdirectory of this repo -- a wrapper moved into '
    + 'r\\ would go unguarded, which is how r\\build_ortho_tiles.ps1 was missed until 2026-09-18.');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
