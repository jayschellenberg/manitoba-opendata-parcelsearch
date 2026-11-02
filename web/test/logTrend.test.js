// The percent-per-year market trend (lib/salesCharts.js logTrend, 2026-11-01)
// that the Sales Charts page now adjusts with by default. Pinned against
// hand-built sets whose rate is known, and against the failure that made it
// the default: a dollar trend carrying cheap sales to $0.
//
// Run: cd web && node test/logTrend.test.js

import assert from 'node:assert/strict';
import { logTrend, timeAdjustLog, logTrendWords, timeAdjust, marketConditions, t975 } from '../src/lib/salesCharts.js';

const DAY = 86400000;
const base = Date.UTC(2022, 0, 1);
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

{
  // Exactly +10% a year, no noise: the fit recovers it, the range is tight.
  const recs = Array.from({ length: 12 }, (_, i) => ({ dateMs: base + i * 120 * DAY, ppa: 1000 * 1.1 ** ((i * 120) / 365) }));
  const lt = logTrend(recs, 'ppa');
  ok(Math.abs(lt.pctPerYear - 0.1) < 1e-9, 'a clean +10% a year is recovered');
  ok(lt.significant, 'a clean trend is significant');
  ok(Math.abs(lt.predict(base) - 1000) < 1e-6, 'the curve passes through the data');
  ok(/^\+10\.0% per year \(95%: \+10\.0% to \+10\.0%\)$/.test(logTrendWords(lt)), 'the words state the rate and its range');
}
{
  // Noise around a flat market: the range spans zero and the words say so.
  let seed = 5;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const recs = Array.from({ length: 30 }, (_, i) => ({ dateMs: base + i * 30 * DAY, ppa: 1000 * Math.exp((rnd() - 0.5) * 0.8) }));
  const lt = logTrend(recs, 'ppa');
  ok(lt.lo < 0 && lt.hi > 0, 'a flat noisy market has a range spanning zero');
  ok(!lt.significant, 'and is not significant');
  ok(logTrendWords(lt).startsWith('no measurable trend'), 'the words refuse to call it a trend');
}
{
  // The motivating failure: bare land at $5,000/ac and house lots at
  // $2,000,000/ac in one set, falling. The dollar trend carries the cheap
  // sales to zero; the percent trend cannot.
  const recs = [];
  for (let i = 0; i < 20; i++) {
    const d = base + i * 60 * DAY;
    recs.push({ dateMs: d, ppa: 5000 * (1 - i * 0.01) });
    recs.push({ dateMs: d, ppa: 2000000 * (1 - i * 0.03) });
  }
  const eff = base + 1300 * DAY;
  const mc = marketConditions(recs, 'ppa');
  const zeroedDollar = recs.filter((r) => !(timeAdjust(r, 'ppa', mc.perDay, eff) > 0)).length;
  ok(zeroedDollar > 0, `the dollar trend carries ${zeroedDollar} cheap sales to $0`);
  const lt = logTrend(recs, 'ppa');
  ok(recs.every((r) => timeAdjustLog(r, 'ppa', lt.perDay, eff) > 0), 'the percent trend carries none to $0');
}
ok(logTrend([{ dateMs: base, ppa: 1 }, { dateMs: base, ppa: 2 }, { dateMs: base, ppa: 3 }], 'ppa') === null, 'one sale date is not a trend');
ok(logTrend([{ dateMs: base, ppa: 1 }], 'ppa') === null, 'fewer than three sales is not a trend');
ok(Math.abs(t975(10) - 2.228) < 1e-9 && t975(1000) < 1.97, 't quantiles');

console.log(`logTrend: ${n} assertions passed`);
