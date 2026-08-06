// Unit tests for lib/salesCharts.js — the sale-level record projection
// and the regression math the Sales Charts tab plots. This arithmetic
// ends up in appraisal exhibits (a $/day market-conditions figure, a
// time-adjusted rate), so it is worth pinning against hand-worked
// numbers rather than trusting the chart to look plausible.
//
// Run: cd web && node test/salesCharts.test.js

import assert from 'node:assert/strict';
import {
  saleRecordsFromRows, fitLinear, fitPoly, fitPower, median, marketConditions,
  timeAdjust, normalizeOverrideRate, topZones, dotRadius, haversineKm,
  msToDays, WINNIPEG_CENTRE,
} from '../src/lib/salesCharts.js';

const parseDate = (s) => (s ? new Date(`${s}T00:00:00Z`) : null);
const centroid = (f) => f?._c ?? null;

/** Minimal grid-row shape: {parcel: {properties}}. */
function row(props, c = null) {
  return { parcel: { properties: props, _c: c } };
}

// ---------- saleRecordsFromRows ------------------------------------

{
  // A 3-parcel sale must collapse to ONE record. This is the whole
  // reason the module exists: three rows in the grid are one
  // transaction, and plotting three dots would triple its weight.
  const shared = {
    _saleGroupId: 7,
    _saleDate: '2024-06-01',
    _saleGroupSize: 3,
    _saleGroupTotalPriceNum: 300000,
    _saleGroupTotalAcres: 30,
    _saleGroupPpl: 100000,
    _saleGroupPpa: 10000,
    _saleGroupPpsf: 0.2296,
    _saleGroupRolls: ['1', '2', '3'],
  };
  const recs = saleRecordsFromRows([
    row({ ...shared, Roll_No_Txt: '1', _zoneCode: 'AG' }, { lat: 50, lng: -97 }),
    row({ ...shared, Roll_No_Txt: '2', _zoneCode: 'AG' }, { lat: 50.2, lng: -97 }),
    row({ ...shared, Roll_No_Txt: '3', _zoneCode: 'AG' }, { lat: 50.4, lng: -97 }),
  ], { parseDate, centroid });

  assert.equal(recs.length, 1, 'three parcels of one sale collapse to one record');
  assert.equal(recs[0].parcelCount, 3);
  assert.equal(recs[0].price, 300000);
  // lotAcres is the PER-PARCEL size — the QMD's LotAcres — not the 30
  // acre group total. A size chart asks how big each lot was.
  assert.equal(recs[0].lotAcres, 10);
  assert.equal(recs[0].lotSf, 10 * 43560);
  // Position is the mean of member centroids, not the first parcel's.
  assert.ok(Math.abs(recs[0].lat - 50.2) < 1e-9, 'sale sits at the mean of its parcels');
}

{
  // Incomplete group acres must not produce a size. Upstream already
  // suppresses the rates in this case; the size has to follow, or the
  // by-size charts would plot a rate against a partial acreage.
  const recs = saleRecordsFromRows([
    row({
      _saleGroupId: 1, _saleDate: '2024-01-01', _saleGroupSize: 2,
      _saleGroupTotalAcres: 5, _saleGroupAcresIncomplete: true,
      _saleGroupTotalPriceNum: 100000, _saleGroupPpl: 50000,
    }),
  ], { parseDate, centroid });
  assert.equal(recs[0].lotAcres, null, 'incomplete acres yields no lot size');
  assert.equal(recs[0].acres, null);
  assert.equal(recs[0].ppl, 50000, 'price/lot survives — it needs no acreage');
}

{
  // Rows with no sale group are skipped: without a group id there is no
  // way to tell one 2-parcel sale from two 1-parcel sales.
  const recs = saleRecordsFromRows([
    row({ Roll_No_Txt: '9', _saleDate: '2024-01-01' }),
  ], { parseDate, centroid });
  assert.equal(recs.length, 0);
}

{
  // Zero and negative money are dropped, not plotted. A $0 consideration
  // is a non-market transfer (gift, estate, correction) and would drag
  // every trendline through the floor.
  const recs = saleRecordsFromRows([
    row({
      _saleGroupId: 1, _saleDate: '2024-01-01', _saleGroupSize: 1,
      _saleGroupTotalPriceNum: 0, _saleGroupPpl: 0, _saleGroupPpa: 0,
    }),
  ], { parseDate, centroid });
  assert.equal(recs[0].price, null);
  assert.equal(recs[0].ppl, null);
  assert.equal(recs[0].ppa, null);
}

{
  // Output is chronological regardless of input order.
  const mk = (id, date) => row({
    _saleGroupId: id, _saleDate: date, _saleGroupSize: 1,
    _saleGroupTotalPriceNum: 1000, _saleGroupPpl: 1000,
  });
  const recs = saleRecordsFromRows(
    [mk(1, '2025-01-01'), mk(2, '2023-01-01'), mk(3, '2024-01-01')],
    { parseDate, centroid },
  );
  assert.deepEqual(recs.map((r) => r.saleId), [2, 3, 1]);
}

// ---------- fitLinear ----------------------------------------------

{
  // Exact line: y = 3x + 2. Slope, intercept and r² are all determined.
  const fit = fitLinear([{ x: 0, y: 2 }, { x: 1, y: 5 }, { x: 2, y: 8 }, { x: 3, y: 11 }]);
  assert.ok(Math.abs(fit.slope - 3) < 1e-12);
  assert.ok(Math.abs(fit.intercept - 2) < 1e-12);
  assert.ok(Math.abs(fit.r2 - 1) < 1e-12);
  assert.equal(fit.n, 4);
  assert.ok(Math.abs(fit.predict(10) - 32) < 1e-12);
}

{
  // Hand-worked non-exact case: points (1,2) (2,4) (3,5).
  // mean x = 2, mean y = 11/3. Sxy = 3, Sxx = 2 -> slope 1.5,
  // intercept = 11/3 - 3 = 2/3.
  const fit = fitLinear([{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 5 }]);
  assert.ok(Math.abs(fit.slope - 1.5) < 1e-12);
  assert.ok(Math.abs(fit.intercept - 2 / 3) < 1e-12);
}

assert.equal(fitLinear([{ x: 1, y: 1 }, { x: 2, y: 2 }]), null, 'under 3 points is not a trend');
assert.equal(
  fitLinear([{ x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }]), null,
  'identical x values have no slope — must not divide by zero',
);
{
  // The same case where the arithmetic does NOT land on an exact zero.
  // Summing n copies of an irrational-ish value rounds, so the mean is
  // an ulp off and sxx is ~1e-32 rather than 0 — an `sxx === 0` guard
  // sails straight past it and returns a fabricated slope. Reachable in
  // the app: a filtered set of identically-sized lots, seen through the
  // log-space fit that fitPower uses.
  const x = Math.log(5);
  const pts = Array.from({ length: 8 }, (_, i) => ({ x, y: i + 1 }));
  assert.equal(fitLinear(pts), null, 'near-zero x variance must be rejected too');
}
{
  // ...but a genuinely small spread must still fit. Lot sizes an acre
  // apart are nowhere near the noise floor.
  const pts = [{ x: 10, y: 1 }, { x: 11, y: 2 }, { x: 12, y: 3 }];
  const fit = fitLinear(pts);
  assert.ok(fit, 'a real 1-unit spread is not degenerate');
  assert.ok(Math.abs(fit.slope - 1) < 1e-12);
}
{
  // Large x (epoch days ~20000) with a one-day spread must still fit —
  // the guard scales with x, so it must not swallow real date data.
  const pts = [{ x: 20000, y: 1 }, { x: 20001, y: 3 }, { x: 20002, y: 5 }];
  const fit = fitLinear(pts);
  assert.ok(fit, 'one day apart at epoch-day scale is a real spread');
  assert.ok(Math.abs(fit.slope - 2) < 1e-9);
}
{
  // Flat y: the line fits perfectly but explains nothing. r² must be 0,
  // not NaN, or the stat strip renders "NaN%".
  const fit = fitLinear([{ x: 1, y: 7 }, { x: 2, y: 7 }, { x: 3, y: 7 }]);
  assert.equal(fit.slope, 0);
  assert.equal(fit.r2, 0);
}
{
  // Non-finite points are filtered, not propagated as NaN.
  const fit = fitLinear([
    { x: 0, y: 2 }, { x: 1, y: 5 }, { x: 2, y: 8 },
    { x: NaN, y: 4 }, { x: 3, y: null },
  ]);
  assert.ok(Math.abs(fit.slope - 3) < 1e-12);
  assert.equal(fit.n, 3);
}

// ---------- fitPoly ------------------------------------------------

{
  // A cubic recovers an exact cubic. Built on epoch-millisecond x values
  // on purpose: this is the case that motivates the [-1,1] mapping —
  // without it x³ is ~5e36 and the normal matrix loses every digit.
  const base = Date.UTC(2020, 0, 1);
  const day = 86400000;
  const f = (t) => 1 + 2 * t + 3 * t * t + 4 * t * t * t; // t in years-ish
  const pts = [];
  for (let i = 0; i < 12; i++) {
    const x = base + i * 90 * day;
    pts.push({ x, y: f((x - base) / (365 * day)) });
  }
  const fit = fitPoly(pts, 3);
  assert.ok(fit, 'cubic fit over ms-scale x must not collapse');
  for (const p of pts) {
    const rel = Math.abs(fit.predict(p.x) - p.y) / Math.abs(p.y);
    assert.ok(rel < 1e-6, `cubic recovers y within 1e-6 relative (got ${fit.predict(p.x)} vs ${p.y})`);
  }
}

{
  // A degree-1 poly must agree with the OLS line.
  const pts = [{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 5 }, { x: 4, y: 9 },
    { x: 5, y: 10 }, { x: 6, y: 13 }];
  const lin = fitLinear(pts);
  const poly = fitPoly(pts, 1);
  for (const x of [0, 3.5, 12]) {
    assert.ok(Math.abs(poly.predict(x) - lin.predict(x)) < 1e-9,
      'degree-1 poly and OLS are the same line');
  }
}

assert.equal(fitPoly([{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], 3), null,
  'a cubic through 3 points is interpolation, not a trend — refuse it');
{
  // 7 points is still below the degree+5 floor for a cubic.
  const pts = Array.from({ length: 7 }, (_, i) => ({ x: i, y: i * 2 }));
  assert.equal(fitPoly(pts, 3), null, 'cubic needs at least 8 points');
  assert.ok(fitPoly(pts, 1), 'a line needs only 6');
}
{
  // All-identical x is singular: no polynomial is determined.
  const pts = Array.from({ length: 10 }, (_, i) => ({ x: 4, y: i }));
  assert.equal(fitPoly(pts, 3), null);
}

// ---------- fitPower -----------------------------------------------

{
  // Exact power law: y = 26000 * x^-0.45, the shape a $/acre-vs-size
  // curve actually takes. Both parameters must come back.
  const A = 26000, B = -0.45;
  const pts = [1, 2, 3, 5, 8, 13, 21, 34].map((x) => ({ x, y: A * Math.pow(x, B) }));
  const fit = fitPower(pts);
  assert.ok(fit, 'a clean power law must fit');
  assert.ok(Math.abs(fit.a - A) / A < 1e-9, `a: got ${fit.a}`);
  assert.ok(Math.abs(fit.b - B) < 1e-9, `b: got ${fit.b}`);
  assert.ok(Math.abs(fit.r2 - 1) < 1e-9, 'exact law fits perfectly in log space');
  for (const p of pts) {
    assert.ok(Math.abs(fit.predict(p.x) - p.y) / p.y < 1e-9);
  }
  // The exponent is the size adjustment: doubling size multiplies the
  // rate by 2^b. This is the number an appraiser actually quotes.
  assert.ok(Math.abs(fit.predict(20) / fit.predict(10) - Math.pow(2, B)) < 1e-9);
}

{
  // Monotonic decay with noise: the fitted exponent must stay negative,
  // i.e. the curve still says "bigger parcels sell for less per acre".
  const pts = [];
  let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 40; i++) {
    const x = 1 + i * 0.5;
    pts.push({ x, y: 26000 * Math.pow(x, -0.45) * (0.85 + rnd() * 0.3) });
  }
  const fit = fitPower(pts);
  assert.ok(fit.b < -0.3 && fit.b > -0.6, `noisy decay should recover b near -0.45, got ${fit.b}`);
}

// Non-positive x or y can't be logged and must be dropped, not turned
// into NaN that poisons the whole fit.
{
  const good = [1, 2, 4, 8, 16].map((x) => ({ x, y: 1000 * Math.pow(x, -0.5) }));
  const fit = fitPower([...good, { x: 0, y: 500 }, { x: 4, y: 0 }, { x: -2, y: 100 }]);
  assert.ok(fit, 'a zero-acre or zero-dollar comp must not sink the fit');
  assert.equal(fit.n, 5, 'only the positive points are used');
  assert.ok(Math.abs(fit.b + 0.5) < 1e-9);
  assert.ok(Number.isFinite(fit.predict(3)));
}

// predict is undefined at and below zero — the axis never samples there
// for a size chart, but it must not return a bogus number if it did.
{
  const fit = fitPower([1, 2, 4, 8, 16].map((x) => ({ x, y: 100 * Math.pow(x, -0.4) })));
  assert.ok(Number.isNaN(fit.predict(0)));
  assert.ok(Number.isNaN(fit.predict(-5)));
  assert.ok(Number.isNaN(fit.predict(NaN)));
}

assert.equal(fitPower([{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 4, y: 4 }, { x: 8, y: 8 }]), null,
  'four points is not enough authority for a drawn curve');
assert.equal(fitPower([]), null);
{
  // Identical x throughout is singular in log space too.
  const pts = Array.from({ length: 8 }, (_, i) => ({ x: 5, y: i + 1 }));
  assert.equal(fitPower(pts), null);
}
{
  // Flat y: b is 0, the curve is a horizontal line, and r2 is 0 not NaN.
  const fit = fitPower([1, 2, 4, 8, 16].map((x) => ({ x, y: 5000 })));
  assert.equal(fit.b, 0);
  assert.ok(Math.abs(fit.a - 5000) < 1e-9);
  assert.equal(fit.r2, 0);
}

// ---------- median -------------------------------------------------

assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 1, 3, 2]), 2.5);
assert.equal(median([]), null);
assert.equal(median([1, NaN, 3, null]), 2, 'non-finite values are excluded, not counted');

// ---------- marketConditions ---------------------------------------

{
  // $10/acre per day, exactly: 4 sales 100 days apart rising $1000 each.
  const day = 86400000;
  const t0 = Date.UTC(2023, 0, 1);
  const recs = [0, 1, 2, 3].map((i) => ({
    dateMs: t0 + i * 100 * day,
    ppa: 10000 + i * 1000,
  }));
  const mc = marketConditions(recs, 'ppa');
  assert.ok(Math.abs(mc.perDay - 10) < 1e-9, 'slope reads as dollars per DAY');
  assert.ok(Math.abs(mc.perYear - 3650) < 1e-6);
  assert.equal(mc.median, 11500);
  // Percentage is over the median, not the mean, so one outlier can't
  // set the headline rate.
  assert.ok(Math.abs(mc.pctPerYear - 3650 / 11500) < 1e-12);
  assert.equal(mc.n, 4);
}

{
  // Sales missing the metric or the date are excluded from the fit.
  const day = 86400000;
  const t0 = Date.UTC(2023, 0, 1);
  const mc = marketConditions([
    { dateMs: t0, ppa: 100 },
    { dateMs: t0 + 100 * day, ppa: 200 },
    { dateMs: t0 + 200 * day, ppa: 300 },
    { dateMs: null, ppa: 9999 },
    { dateMs: t0 + 300 * day, ppa: null },
  ], 'ppa');
  assert.equal(mc.n, 3);
  assert.ok(Math.abs(mc.perDay - 1) < 1e-9);
}

assert.equal(marketConditions([{ dateMs: 1, ppa: 1 }], 'ppa'), null, 'one sale is not a market');

// ---------- timeAdjust ---------------------------------------------

{
  const day = 86400000;
  const saleMs = Date.UTC(2023, 0, 1);
  const effMs = saleMs + 365 * day;
  const rec = { dateMs: saleMs, ppa: 10000 };
  // A year forward at $10/day adds $3650 — the QMD's
  // AdjPrice = MktCondAdj * ChgInDays + Price.
  assert.ok(Math.abs(timeAdjust(rec, 'ppa', 10, effMs) - 13650) < 1e-9);
  // Effective date BEFORE the sale walks the rate backwards.
  assert.ok(Math.abs(timeAdjust(rec, 'ppa', 10, saleMs - 365 * day) - 6350) < 1e-9);
  // A steep decline over a long gap must not produce a negative $/acre.
  assert.equal(timeAdjust(rec, 'ppa', -100, effMs), 0, 'adjusted rates clamp at zero');
  // No trend, or no date: fall back to the raw rate rather than dropping
  // the comp off the chart entirely.
  assert.equal(timeAdjust(rec, 'ppa', NaN, effMs), 10000);
  assert.equal(timeAdjust({ dateMs: null, ppa: 10000 }, 'ppa', 10, effMs), 10000);
  assert.equal(timeAdjust({ ppa: null }, 'ppa', 10, effMs), null);
}

// ---------- timeAdjust: the judgement-override basis -----------------

{
  const day = 86400000;
  const saleMs = Date.UTC(2023, 0, 1);
  const effMs = saleMs + 365 * day;

  // 5% a year, proportional — the R engine's
  // `price * (1 + ovr_rate * days/365)` branch, NOT dollars per day.
  const cheap = { dateMs: saleMs, ppa: 10000 };
  const dear = { dateMs: saleMs, ppa: 40000 };
  assert.ok(Math.abs(timeAdjust(cheap, 'ppa', 999, effMs, { overrideRate: 0.05 }) - 10500) < 1e-6);
  assert.ok(Math.abs(timeAdjust(dear, 'ppa', 999, effMs, { overrideRate: 0.05 }) - 42000) < 1e-6);

  // The override REPLACES the fitted rate rather than stacking on it —
  // note perDay: 999 above would have swamped the result if it applied.
  // The two bases differ in kind: percent scales with the comp's own
  // value, dollars-per-day does not.
  const halfYear = saleMs + 182.5 * day;
  assert.ok(Math.abs(timeAdjust(cheap, 'ppa', null, halfYear, { overrideRate: 0.05 }) - 10250) < 1e-6);

  // Backwards in time reduces.
  assert.ok(timeAdjust(cheap, 'ppa', null, saleMs - 365 * day, { overrideRate: 0.05 }) < 10000);
  // A large negative override still cannot produce a negative rate.
  assert.equal(timeAdjust(cheap, 'ppa', null, effMs + 3650 * day, { overrideRate: -0.5 }), 0);
  // Zero / null override falls back to the fitted rate.
  assert.ok(Math.abs(timeAdjust(cheap, 'ppa', 10, effMs, { overrideRate: 0 }) - 13650) < 1e-9);
  assert.ok(Math.abs(timeAdjust(cheap, 'ppa', 10, effMs, { overrideRate: null }) - 13650) < 1e-9);
}

// ---------- normalizeOverrideRate -----------------------------------

// "5" and "0.05" both mean five percent, matching the R engine's
// `if (abs(raw) > 1) raw/100 else raw` — so a rate typed either way
// behaves identically in the app and in the report.
assert.equal(normalizeOverrideRate(5), 0.05);
assert.equal(normalizeOverrideRate(0.05), 0.05);
assert.equal(normalizeOverrideRate(-3), -0.03);
assert.equal(normalizeOverrideRate(100), 1);
assert.equal(normalizeOverrideRate(0), null, 'zero means "no override"');
assert.equal(normalizeOverrideRate(''), null);
assert.equal(normalizeOverrideRate('abc'), null);
assert.equal(normalizeOverrideRate(null), null);

// ---------- topZones -----------------------------------------------

{
  const recs = [
    ...Array(5).fill({ zone: 'AG' }),
    ...Array(4).fill({ zone: 'RR' }),
    ...Array(3).fill({ zone: 'RS' }),
    ...Array(2).fill({ zone: 'CG' }),
    { zone: '' },
  ];
  const top = topZones(recs);
  // Capped at 3 by the palette: a scatter puts every pair of series
  // adjacent, and only the first three slots clear the CVD floor under
  // that all-pairs test. A 4th would be yellow beside orange.
  assert.equal(top.length, 3);
  assert.deepEqual(top.map((t) => t.key), ['AG', 'RR', 'RS']);
  assert.equal(top[0].count, 5);
}
{
  // Ties break alphabetically so the same set always gets the same
  // colours — colour must follow the entity, never its rank-by-luck.
  const top = topZones([{ zone: 'RR' }, { zone: 'AG' }], 3);
  assert.deepEqual(top.map((t) => t.key), ['AG', 'RR']);
}

// ---------- dotRadius ----------------------------------------------

assert.equal(dotRadius(1), 4, 'single-parcel sale sits at the 8px mark floor');
assert.ok(dotRadius(3) > dotRadius(1), 'assemblies read larger');
assert.ok(dotRadius(200) <= 7, 'one portfolio sale cannot dominate the plot');
assert.equal(dotRadius(undefined), 4);

// ---------- haversineKm / misc -------------------------------------

{
  // Portage & Main to the Rosser subject in the QMD params: ~24 km.
  const d = haversineKm(WINNIPEG_CENTRE, { lat: 49.98050582958988, lng: -97.41445676918163 });
  assert.ok(d > 20 && d < 28, `expected ~24 km, got ${d}`);
  assert.equal(haversineKm(WINNIPEG_CENTRE, WINNIPEG_CENTRE), 0);
  assert.ok(Number.isNaN(haversineKm(null, WINNIPEG_CENTRE)));
}
assert.equal(msToDays(86400000), 1);

console.log('salesCharts.test.js: all assertions passed');
