// Unit tests for the pure parts of lib/chartRender.js — axis tick
// generation and the number formatters. The drawing itself needs a DOM
// and is verified in the browser; these are the bits that quietly
// produce wrong-looking axes (drifting float ticks, a date axis that
// breaks at arbitrary places) without ever throwing.
//
// Run: cd web && node test/chartRender.test.js

import assert from 'node:assert/strict';
import {
  niceTicks, dateTicks, fmtAxisMoney, fmtAxisNum, fmtMoney0, fmtMoney2, fmtDate,
} from '../src/lib/chartRender.js';

// ---------- niceTicks ----------------------------------------------

{
  const { ticks, lo, hi } = niceTicks(0, 100, 5);
  assert.equal(lo, 0);
  assert.equal(hi, 100);
  assert.deepEqual(ticks, [0, 20, 40, 60, 80, 100]);
}
{
  // Bounds widen OUT to round numbers so the axis starts and ends on one.
  const { ticks, lo, hi } = niceTicks(3, 97, 5);
  assert.ok(lo <= 3 && hi >= 97);
  assert.equal(lo % 20, 0);
}
{
  // Sub-dollar domain — the $/SF case. Ticks must be exact decimals, not
  // 0.30000000000000004: accumulating `t += step` drifts on steps like
  // 0.05 and the drift lands straight in the axis labels.
  const { ticks } = niceTicks(0, 0.25, 5);
  for (const t of ticks) {
    assert.equal(t, Number(t.toFixed(10)), `tick ${t} carries float drift`);
  }
  assert.ok(ticks.length >= 3 && ticks.length <= 12);
}
{
  // A single-valued domain must still produce a usable axis rather than
  // a zero-width span that divides by zero downstream.
  const { ticks, lo, hi } = niceTicks(500, 500);
  assert.ok(hi > lo);
  assert.ok(ticks.length >= 2);
}
{
  const { ticks } = niceTicks(NaN, 10);
  assert.deepEqual(ticks, []);
}
{
  // Large money domain stays on the 1/2/2.5/5 ladder.
  const { ticks } = niceTicks(0, 1_850_000, 6);
  const step = ticks[1] - ticks[0];
  const mag = 10 ** Math.floor(Math.log10(step));
  assert.ok([1, 2, 2.5, 5, 10].some((m) => Math.abs(step / mag - m) < 1e-9),
    `step ${step} is not a nice number`);
}

// ---------- dateTicks ----------------------------------------------

{
  // Under 1.5 years -> quarterly, labelled with the month. Matches the
  // QMD's date_break_interval ladder so both charts break alike.
  const lo = Date.UTC(2024, 0, 15);
  const hi = Date.UTC(2025, 0, 15);
  const { ticks, format } = dateTicks(lo, hi);
  const months = ticks.map((t) => new Date(t).getUTCMonth());
  for (const m of months) assert.equal(m % 3, 0, 'quarterly ticks sit on quarter boundaries');
  assert.match(format(ticks[0]), /[A-Za-z]{3}/, 'month is shown under 3 years of span');
}
{
  // Over 6 years -> 24-month steps, year-only labels.
  const lo = Date.UTC(2014, 5, 1);
  const hi = Date.UTC(2025, 5, 1);
  const { ticks, format } = dateTicks(lo, hi);
  const gapMonths = Math.round(
    (new Date(ticks[1]).getTime() - new Date(ticks[0]).getTime()) / (30.44 * 86400000),
  );
  assert.ok(gapMonths >= 23 && gapMonths <= 25, `expected ~24 months, got ${gapMonths}`);
  assert.match(format(ticks[0]), /^\d{4}$/, 'year-only labels past 6 years');
}
{
  // Ticks must bracket the data on both sides.
  const lo = Date.UTC(2022, 3, 7);
  const hi = Date.UTC(2024, 8, 22);
  const { ticks } = dateTicks(lo, hi);
  assert.ok(ticks[0] <= lo, 'first tick is at or before the earliest sale');
  assert.ok(ticks[ticks.length - 1] >= hi, 'last tick is at or after the latest sale');
}
{
  // A corrupt pair of dates must terminate, not spin. Two centuries at
  // 24-month steps would be ~100 ticks; the cap holds it at 201.
  const { ticks } = dateTicks(Date.UTC(1900, 0, 1), Date.UTC(2400, 0, 1));
  assert.ok(ticks.length <= 201, `runaway tick loop: ${ticks.length}`);
}
{
  const { ticks } = dateTicks(NaN, Date.UTC(2024, 0, 1));
  assert.deepEqual(ticks, []);
}

// ---------- formatters ---------------------------------------------

assert.equal(fmtAxisMoney(1_500_000), '$1.5M');
assert.equal(fmtAxisMoney(450_000), '$450K');
// Under $10K stays exact: abbreviating an $8,500 tick to "$9K" would
// misstate the gridline it labels.
assert.equal(fmtAxisMoney(8500), '$8,500');
assert.equal(fmtAxisMoney(850), '$850');
assert.equal(fmtAxisMoney(0.25), '$0.25');
assert.equal(fmtAxisMoney(0), '$0');
assert.equal(fmtAxisMoney(NaN), '');

assert.equal(fmtAxisNum(2_400_000), '2.4M');
assert.equal(fmtAxisNum(43_560), '44K');
assert.equal(fmtAxisNum(160), '160');
assert.equal(fmtAxisNum(4.87), '4.87');

assert.equal(fmtMoney0(1234.6), '$1,235');
assert.equal(fmtMoney2(0.078), '$0.08');
assert.equal(fmtMoney0(null), '—');
assert.equal(fmtDate(Date.UTC(2024, 5, 1)), '2024-06-01');
assert.equal(fmtDate(null), '—');

console.log('chartRender.test.js: all assertions passed');
