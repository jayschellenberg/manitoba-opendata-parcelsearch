// The HPI download parser: run its PowerShell contract tests as part of
// `npm test`, and pin the wiring that keeps there being exactly ONE parser.
//
// WHY THIS EXISTS. The CREA MLS HPI download has broken twice by rename --
// 2026-09-04 (MLS_HPI-July-2026_EN.zip -> MLS_HPI_Aug_2026.zip) and 2026-09-15
// (-> MLS_HPI_Sept_2026.zip). The second one is the instructive one. The
// downloader and its backstop watchdog each carried a hand-copied regex and a
// hand-built month table, and a comment in hpi-staleness-check.ps1 called that
// duplication deliberate, "so the two scripts can never disagree about what
// 'newest on the page' means". They did not disagree. They were both wrong in
// the same way, at the same moment, and the backstop reported the page as empty
// instead of raising the alarm the situation called for.
//
// So the parser now lives once, in hpi-lib.ps1, and hpi-lib.tests.ps1 pins its
// behaviour. Those tests are the real ones; this file exists because a suite
// nothing runs is a suite that rots -- `npm test` is what actually gets run
// here, and PowerShell tests sitting outside it would be tested by nobody.
//
// The source assertions below guard the other half: that the two scripts
// actually CALL the shared lib and have not quietly regrown a private month
// table. That is the recurring bug in this repo -- code that exists and is
// never called -- and it is invisible to any behavioural test of the lib
// itself, because the lib passes just fine while nothing uses it.
//
// Run: cd web && node test/hpiParsing.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
 *  fontStacks.test.js / mfDuLabels.test.js, minus the JS string handling --
 *  PowerShell comments run from an unquoted # to end of line. */
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

const read = (f) => stripPsComments(fs.readFileSync(path.join(repo, f), 'utf8'));
const downloader = read('hpi-download.ps1');
const watchdog   = read('hpi-staleness-check.ps1');

// ---- 1. The shared parser is actually wired in -------------------------------

for (const [name, src] of [['hpi-download.ps1', downloader], ['hpi-staleness-check.ps1', watchdog]]) {
  test(`${name} dot-sources hpi-lib.ps1`, () => {
    assert.match(src, /\.\s+\(Join-Path\s+\$root\s+'hpi-lib\.ps1'\)/,
      `${name} must dot-source the shared parser`);
  });

  test(`${name} calls the shared parser rather than its own`, () => {
    assert.ok(/Get-Hpi(ZipLinks|MonthNumber)/.test(src),
      `${name} dot-sources hpi-lib.ps1 but never calls it -- dead wiring`);
  });

  // The specific regression: both scripts grew a private
  // month-name -> number table, and both tables omitted 'Sept'.
  test(`${name} does not rebuild a private month table`, () => {
    assert.ok(!/GetAbbreviatedMonthName/.test(src),
      `${name} is enumerating month spellings again -- that is hpi-lib.ps1's job, ` +
      'and a second copy is how Sept went unread in both scripts at once');
  });
}

// ---- 2. The watchdog can outlive the parser being wrong ----------------------

test('the watchdog treats unreadable links as their own actionable state', () => {
  assert.ok(/ParserBroken/.test(watchdog),
    'hpi-staleness-check.ps1 must detect "CREA published a zip we cannot parse"');
  assert.ok(/parser-broken/.test(watchdog),
    'that detection needs its own alert reason, or it collapses into upstream-unknown');
});

test('parser-broken is not gated behind the grace day', () => {
  const gate = watchdog.match(/if \(-not \$staleByCalendar[^)]*\)/);
  assert.ok(gate, 'could not find the no-reminder gate');
  assert.ok(/-not \$parserBroken/.test(gate[0]),
    'a stopped download must alert immediately, not wait for GraceDay');
});

test('a hard failure invalidates the cached upstream answer from the log', () => {
  assert.ok(/HARD FAIL:/.test(watchdog),
    'the log fast-path must notice the downloader failing after its last good ' +
    'read, or it reports a pre-outage month as current');
});

// ---- 3. Hard-failure alerts dedupe per reason, not per month -----------------

test('hpi-download.ps1 stamps the reason alongside the month', () => {
  assert.ok(/\$stamp\s*=\s*"\$ym \$reason"/.test(downloader),
    'a month-only stamp lets the first failure of the month silence every later one');
  assert.match(downloader, /function Send-HardFailure\(\[string\]\$reason/,
    'Send-HardFailure must take a reason as its first parameter');
});

test('every Send-HardFailure call passes a reason', () => {
  const calls = downloader.match(/Send-HardFailure\s+[^\n]+/g) || [];
  assert.ok(calls.length >= 2, `expected the page-parse and extract calls, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /Send-HardFailure\s+(\$reason|'[a-z-]+')\s+'/,
      `call passes no reason, so the title lands in the stamp: ${call.trim()}`);
  }
});

test('the two page-parse failures are distinguishable', () => {
  assert.ok(/'links-unreadable'/.test(downloader) && /'no-links'/.test(downloader),
    '"CREA renamed the file" and "CREA moved the page" need different reasons, ' +
    'or the second is suppressed by the first');
});

// ---- 4. The PowerShell contract tests themselves -----------------------------

test('hpi-lib.tests.ps1 passes', () => {
  const res = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'hpi-lib.tests.ps1')],
    { encoding: 'utf8' });
  if (res.error && res.error.code === 'ENOENT') {
    console.log('    (powershell.exe not available -- PowerShell suite not run)');
    return;
  }
  assert.equal(res.status, 0, `hpi-lib.tests.ps1 failed:\n${res.stdout}\n${res.stderr}`);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
