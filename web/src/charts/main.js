/*
 * Sales Charts tab.
 *
 * A second page (charts.html) that plots whatever the Sales Analysis
 * grid is currently showing. The main window projects its filtered rows
 * down to one record per SALE and posts them over a BroadcastChannel on
 * every render, so this tab tracks the filters live rather than holding
 * a snapshot from whenever it was opened. "Freeze" stops it accepting
 * updates, for reading or screenshotting a chart while the filters keep
 * moving next door.
 *
 * The chart recipe follows Jason's ImportMAOSales QMD: scatter, an OLS
 * line, a cubic, and — on the by-size and by-distance charts — rates
 * carried to an effective date at the measured market rate. What it
 * deliberately does NOT reproduce yet is the report chrome (the criteria
 * subtitle block, the full caption, PNG export at 7x3.5in): this is the
 * screening pass, and the QMD stays the report producer.
 */

import './charts.css';
import {
  median, marketConditions, timeAdjust, fitLinear, fitPoly, fitPower,
  normalizeOverrideRate, topZones, dotRadius, haversineKm, WINNIPEG_CENTRE,
} from '../lib/salesCharts.js';
import {
  drawChart, SERIES_COLORS, OTHER_COLOR, INK,
  fmtMoney0, fmtMoney2, fmtNum, fmtDate, fmtAxisMoney, fmtAxisNum,
} from '../lib/chartRender.js';

export const CHANNEL_NAME = 'mbps-sales-charts';
const OPTS_KEY = 'mbps_charts_opts_v2';
const OPTS_KEY_V1 = 'mbps_charts_opts_v1';
const MS_PER_DAY = 86400000;

const $ = (id) => document.getElementById(id);

const els = {
  status: $('charts-status'),
  empty: $('charts-empty'),
  grid: $('charts-grid'),
  unitAcres: $('unit-acres'),
  unitSf: $('unit-sf'),
  ctlUnit: $('ctl-unit'),
  ratesHint: $('rates-hint'),
  tabRates: $('tab-rates'),
  tabTotal: $('tab-total'),
  effDate: $('eff-date'),
  ratesNominal: $('rates-nominal'),
  ratesAdjusted: $('rates-adjusted'),
  adjBasis: $('adj-basis'),
  adjRate: $('adj-rate'),
  adjHint: $('adj-hint'),
  distRef: $('dist-ref'),
  freeze: $('freeze'),
  showTable: $('show-table'),
  tablePanel: $('table-panel'),
  table: $('sales-table'),
};

/** Latest payload from the main window: {records, meta}. */
let data = { records: [], meta: null };
let receivedAt = null;

/**
 * Today as YYYY-MM-DD in LOCAL time.
 *
 * toISOString() was used here and is wrong for this: it renders UTC, and
 * Manitoba runs 5-6 hours behind it, so from early evening onward the default
 * effective date was TOMORROW. effectiveMs() parses the string back as local
 * midnight (see its own note), so the two halves have to agree on local.
 */
function todayLocal() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

const opts = {
  unit: 'acres',
  // Which chart set is showing: 'rates' (per acre/SF/lot) or 'total'
  // (the whole consideration). Persisted — it is a way of working, not a
  // transient view, and an appraiser doing land-and-building work wants
  // the same tab back tomorrow.
  tab: 'rates',
  effDate: todayLocal(),
  // Whether the by-size / by-distance charts plot adjusted rates. The
  // two over-time charts ignore this entirely — they always plot rates
  // as sold, because carrying them to one date is precisely what would
  // destroy the trend they exist to show.
  adjusted: true,
  // How the adjustment (and the over-time trend line) is computed:
  //   'fitted'   — the regression's own dollars per day, as the R engine does
  //   'override' — a judgement percent per year, applied proportionally
  adjBasis: 'fitted',
  adjRate: 3,
  distRef: 'subject',
  frozen: false,
  showTable: false,
  ...readOpts(),
};

function readOpts() {
  try {
    const raw = localStorage.getItem(OPTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      // Freeze is deliberately NOT restored: a tab that opens already
      // frozen looks broken — it shows stale numbers and ignores the
      // filters until you find the checkbox.
      // effDate joins frozen in NOT being restored: comps are carried to
      // "today" by default, and a date stored on some earlier visit is stale
      // the next morning while still looking deliberate (Jason, 2026-08-18).
      // Type one by hand and it holds for that session.
      const { frozen, effDate, ...rest } = parsed;
      return rest;
    }
    // Migrate the v1 shape, which folded "don't adjust" into the basis
    // select as a third option. Dropping the old settings on the floor
    // would silently reset someone's effective date and judgement rate.
    const legacy = JSON.parse(localStorage.getItem(OPTS_KEY_V1) || 'null');
    if (!legacy || typeof legacy !== 'object') return {};
    const { frozen, adjMode, effDate, ...rest } = legacy;
    return {
      ...rest,
      adjusted: adjMode !== 'none',
      adjBasis: adjMode === 'override' ? 'override' : 'fitted',
    };
  } catch { return {}; }
}

function writeOpts() {
  try { localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); } catch { /* private mode */ }
}

// ---------- derived helpers ----------------------------------------

/**
 * Effective date as epoch ms, or null when the input is empty or
 * nonsense.
 *
 * LOCAL midnight, not UTC: the main window's parseSaleDate builds sale
 * dates with `new Date(y, m, d)`, which is local. Parsing this one as
 * UTC would put every gap out by the timezone offset — small, but it
 * would make the app and the report disagree on a figure that is
 * supposed to be reproducible.
 */
function effectiveMs() {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(opts.effDate || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(d.valueOf()) ? d.getTime() : null;
}

const isAcres = () => opts.unit === 'acres';
/** The per-area rate field and the size field move together — plotting
 *  $/acre against a square-foot x-axis would be unreadable. */
const areaMetric = () => (isAcres() ? 'ppa' : 'ppsf');
const sizeField = () => (isAcres() ? 'lotAcres' : 'lotSf');
const areaUnitLabel = () => (isAcres() ? 'Acre' : 'SF');
const sizeAxisLabel = () => (isAcres() ? 'Lot size (acres)' : 'Lot size (sq ft)');
/** $/SF runs to cents; $/acre and $/lot are whole dollars. */
const areaMoneyFmt = () => (isAcres() ? fmtMoney0 : fmtMoney2);

/** Which reference point the distance chart measures from, falling back
 *  to Winnipeg when no subject roll is set in the main window. */
function activeDistRef() {
  const hasSubject = Number.isFinite(data.meta?.subject?.lat);
  return (opts.distRef === 'subject' && hasSubject) ? 'subject' : 'winnipeg';
}

function distanceFor(rec) {
  if (activeDistRef() === 'subject') {
    // Already stamped by the main window against the subject centroid.
    return Number.isFinite(rec.distanceKm) ? rec.distanceKm : null;
  }
  if (!Number.isFinite(rec.lat) || !Number.isFinite(rec.lng)) return null;
  const d = haversineKm(WINNIPEG_CENTRE, { lat: rec.lat, lng: rec.lng });
  return Number.isFinite(d) ? d : null;
}

/** Tooltip rows, shared by every chart. Values lead, labels follow. */
function tooltipRows(rec) {
  if (!rec) return [];
  const rows = [
    [rec.parcelCount > 1 ? `${rec.parcelCount}-parcel sale` : 'Sale', fmtMoney0(rec.price)],
    ['Sold', rec.dateText || fmtDate(rec.dateMs)],
  ];
  if (rec.lotAcres != null) {
    rows.push(['Lot size', isAcres()
      ? `${fmtNum(rec.lotAcres)} ac`
      : `${fmtNum(rec.lotSf)} sf`]);
  }
  if (rec.ppl != null) rows.push(['$/Lot', fmtMoney0(rec.ppl)]);
  if (rec.ppa != null) rows.push(['$/Acre', fmtMoney0(rec.ppa)]);
  if (rec.ppsf != null) rows.push(['$/SF', fmtMoney2(rec.ppsf)]);
  const d = distanceFor(rec);
  if (d != null) {
    rows.push([activeDistRef() === 'subject' ? 'From subject' : 'From Winnipeg',
      `${fmtNum(d)} km`]);
  }
  if (rec.zone) rows.push(['Zoning', rec.zone]);
  const who = rec.address || (rec.rolls || []).join(', ');
  if (who) rows.push([rec.muni || 'Parcel', who]);
  return rows;
}

// ---------- chart builders -----------------------------------------

/**
 * The distance-axis wording and stats, shared by both chart sets.
 *
 * Lifted out of the rate builder when the total-price tab arrived: the two
 * sets must describe the same reference point in the same words, and a
 * second copy is a second thing to forget when the subject picker changes.
 */
function distContext() {
  const ref = activeDistRef();
  return {
    refName: ref === 'subject' ? 'the subject parcel' : 'Portage & Main',
    distLabel: `Distance from ${ref === 'subject' ? 'subject' : 'Winnipeg'} (km)`,
    distEmpty: ref === 'subject'
      ? 'No subject distance available. Set a subject roll in the main window, or measure from Winnipeg.'
      : 'No sales in the current filter have usable parcel geometry to measure from.',
    distStats: (pts, adjusted, yFormat) => spreadStats(pts, {
      xName: 'Median distance',
      xFormat: (v) => `${fmtNum(v)} km`,
      adjusted,
      yFormat,
    }),
  };
}

/** Dispatch to the active tab's builder. */
function buildCharts() {
  return opts.tab === 'total' ? buildTotalCharts() : buildRateCharts();
}

/** A sale contributes to a chart only when both axes resolve. */
function pointsFor(records, xOf, yOf, colorOf) {
  const out = [];
  for (const rec of records) {
    const x = xOf(rec);
    const y = yOf(rec);
    if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) continue;
    out.push({
      x, y, rec,
      r: dotRadius(rec.parcelCount),
      color: colorOf ? colorOf(rec) : SERIES_COLORS[0],
    });
  }
  return out;
}

const LINEAR_FIT = { color: INK.primary, label: 'Linear trend' };
const CUBIC_FIT = { color: SERIES_COLORS[1], dash: '6 4', label: 'Cubic trend' };
const POWER_FIT = { color: SERIES_COLORS[1], dash: '6 4', label: 'Power trend' };

/**
 * Fit the trend lines a chart shows.
 *
 * `curve` picks the second line beside the straight one:
 *   'cubic' — ggplot's `y ~ poly(x,3)`, for the time and distance charts.
 *             Both can genuinely turn: markets reverse, and distance
 *             carries secondary influences — a lake, or a second urban
 *             centre further out — that put real humps in the curve. A
 *             cubic can express those; a power curve cannot.
 *   'power' — y = a*x^b, for the by-size charts only. Price against size
 *             decays and flattens with no inflections, so a cubic there
 *             just chases noise and then swings at whichever end runs
 *             out of comps, showing a bend that isn't in the market.
 *   'none'  — the zoning chart, where colour is already the variable and
 *             the curve's hue would collide with a zone's.
 *
 * Both fitPoly and fitPower refuse small samples, and when they do the
 * legend must not advertise a line that was never drawn — hence building
 * the legend from this return value rather than from the request.
 */
function fitsFor(points, { curve = 'cubic' } = {}) {
  const xy = points.map((p) => ({ x: p.x, y: p.y }));
  const out = [];
  const lin = fitLinear(xy);
  if (lin) out.push({ ...LINEAR_FIT, predict: lin.predict });
  if (curve === 'cubic') {
    const cub = fitPoly(xy, 3);
    if (cub) out.push({ ...CUBIC_FIT, predict: cub.predict });
  } else if (curve === 'power') {
    const pw = fitPower(xy);
    if (pw) out.push({ ...POWER_FIT, predict: pw.predict, exponent: pw.b });
  }
  return out;
}

/**
 * The power curve's exponent, as a stat. This is the size adjustment
 * itself, not decoration: b = -0.45 means each doubling of size takes
 * 2^-0.45, about 27%, off the rate.
 */
function powerStat(fits) {
  const pw = fits.find((f) => Number.isFinite(f.exponent));
  if (!pw) return [];
  const perDouble = Math.pow(2, pw.exponent) - 1;
  return [{
    label: 'Size exponent',
    value: pw.exponent.toFixed(2),
    title: `y = a·x^${pw.exponent.toFixed(3)} — each doubling of size changes the rate by `
      + `${(perDouble * 100).toFixed(0)}%.`,
  }];
}

function legendFor(fits, extra = []) {
  const items = [...extra, ...fits.map((f) => ({
    label: f.label, color: f.color, dash: !!f.dash,
  }))];
  return items.length > 1 ? items : null;
}

/** n / median / trend figures — the numbers the QMD puts in its caption. */
function trendStats(points, mc, fmt) {
  const stats = [{ label: 'Sales', value: String(points.length) }];
  const med = median(points.map((p) => p.y));
  if (med != null) stats.push({ label: 'Median', value: fmt(med) });
  if (mc) {
    stats.push({
      label: 'Per day',
      value: `${mc.perDay >= 0 ? '+' : '−'}${fmtRate(Math.abs(mc.perDay))}`,
      title: 'Slope of the price-vs-date regression — the market-conditions rate.',
    });
    if (mc.pctPerYear != null) {
      stats.push({
        label: 'Per year',
        value: `${(mc.pctPerYear * 100).toFixed(1)}%`,
        title: `${fmt(mc.perYear)} per year over the median of ${fmt(mc.median)}.`,
      });
    }
    stats.push({ label: 'R²', value: mc.r2.toFixed(2) });
  }
  return stats;
}

/**
 * n plus the median of each axis, for the charts whose x isn't time.
 *
 * `xName`/`xFormat` are required rather than defaulted to size: the
 * distance chart shares this function, and a stat strip that called a
 * 29 km median "Median size 29 ac" would be stating something false in
 * a tool people quote in reports.
 */
function spreadStats(points, { xName, xFormat, adjusted, yFormat }) {
  const stats = [{ label: 'Sales', value: String(points.length) }];
  const medX = median(points.map((p) => p.x));
  if (medX != null) stats.push({ label: xName, value: xFormat(medX) });
  const medY = median(points.map((p) => p.y));
  if (medY != null) stats.push({ label: adjusted ? 'Median (adj.)' : 'Median', value: yFormat(medY) });
  return stats;
}

const STATED_FIT = { color: INK.primary };

/**
 * The market path a stated (judgement) rate asserts, as a curve over
 * time — so the over-time charts can draw what the user declared
 * instead of a regression the user has overridden.
 *
 * Derived from the override itself rather than approximated. The
 * override says adjusted = P(t) * (1 + r * days/365); a comp sitting
 * exactly on trend adjusts to the same value C whenever it sold, so the
 * asserted path is P(t) = C / (1 + r * days/365). Note that is a
 * hyperbola, not a straight line — the proportional basis compounds
 * against the gap, and drawing a straight line here would quietly
 * disagree with the adjusted figures on the other charts.
 *
 * C is the median adjusted value, which puts the curve through the
 * middle of the comps the same way an OLS line passes through the mean.
 *
 * Returns null when the denominator can go non-positive across the data
 * range: a steep negative rate over a long span implies a price that
 * passed through zero, which is not a curve worth drawing.
 */
function statedRateFit(records, metric, ovr, effMs) {
  const adjusted = (records || [])
    .map((r) => timeAdjust(r, metric, null, effMs, { overrideRate: ovr }))
    .filter((v) => v != null && Number.isFinite(v));
  const C = median(adjusted);
  if (C == null || !(C > 0)) return null;

  const factor = (ms) => 1 + ovr * ((effMs - ms) / MS_PER_DAY / 365);
  const dated = (records || []).map((r) => r.dateMs).filter(Number.isFinite);
  if (!dated.length) return null;
  if (Math.min(...dated.map(factor)) <= 0) return null;

  return { predict: (ms) => (factor(ms) > 0 ? C / factor(ms) : NaN) };
}

/**
 * What the two over-time charts draw and report.
 *
 * With a stated rate in force the fitted lines are dropped entirely, not
 * shown alongside: the user has declared the market's movement, and a
 * regression drawn next to it invites reading the chart as though the
 * data still decided. The stat strip drops R² for the same reason —
 * there is no regression to report the fit of.
 */
function timeTrend(records, points, metric, mc, fmt) {
  const ovr = overrideRate();
  const effMs = effectiveMs();

  if (ovr != null && effMs != null) {
    const stated = statedRateFit(records, metric, ovr, effMs);
    const pct = `${(ovr * 100).toFixed(1)}%`;
    const stats = [{ label: 'Sales', value: String(points.length) }];
    const med = median(points.map((p) => p.y));
    if (med != null) stats.push({ label: 'Median', value: fmt(med) });
    stats.push({
      label: 'Per year (stated)',
      value: pct,
      title: 'Your judgement rate, not measured from these sales.',
    });
    return {
      fits: stated ? [{ ...STATED_FIT, predict: stated.predict, label: `Stated ${pct}/yr` }] : [],
      stats,
      note: stated
        ? `Trend line is your stated ${pct} per year, not a fit to these sales.`
        : `Stated ${pct} per year implies a price crossing zero across this date range — no trend drawn.`,
    };
  }

  return {
    fits: fitsFor(points, { curve: 'cubic' }),
    stats: trendStats(points, mc, fmt),
    note: '',
  };
}

/** Median-size stats for the three by-size charts. */
function sizeStats(points, adjusted, yFormat) {
  return spreadStats(points, {
    xName: 'Median size',
    xFormat: (v) => (isAcres() ? `${fmtNum(v)} ac` : `${fmtNum(v)} sf`),
    adjusted,
    yFormat,
  });
}

/** Subject size as a vertical reference, when the main window knows it. */
function subjectRef() {
  const ac = Number(data.meta?.subject?.acres);
  if (!Number.isFinite(ac) || ac <= 0) return [];
  return [{
    x: isAcres() ? ac : ac * 43560,
    label: 'Subject',
    color: SERIES_COLORS[0],
  }];
}

/**
 * The subject's own distance, as a vertical reference on the distance
 * charts — so you can see where it sits in the spread of comps rather
 * than having to work it out from the roll.
 *
 * Only drawn when measuring from WINNIPEG. Measuring from the subject,
 * its distance from itself is 0 by definition: the line would pin itself
 * to the left edge and say nothing.
 */
function subjectDistanceRef() {
  if (activeDistRef() !== 'winnipeg') return [];
  const s = data.meta?.subject;
  if (!Number.isFinite(s?.lat) || !Number.isFinite(s?.lng)) return [];
  const km = haversineKm(WINNIPEG_CENTRE, { lat: s.lat, lng: s.lng });
  if (!Number.isFinite(km)) return [];
  return [{ x: km, label: 'Subject', color: SERIES_COLORS[0] }];
}

/**
 * A per-day money rate at enough precision to say something.
 *
 * The $/acre trend runs to dollars a day; the $/SF trend is ~$0.00004,
 * which a fixed 2-decimal format renders as "$0.00" — a real number
 * reported as nothing. Scale the decimals to keep two significant
 * digits, capped at six.
 */
function fmtRate(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '$0';
  if (a >= 1) return fmtMoney0(v);
  const dp = Math.min(6, Math.max(2, -Math.floor(Math.log10(a)) + 1));
  return `$${v.toFixed(dp)}`;
}

/** The judgement rate, or null when the fitted trend is in charge. */
function overrideRate() {
  return opts.adjBasis === 'override' ? normalizeOverrideRate(opts.adjRate) : null;
}

/**
 * The adjuster for one metric, plus the words describing it.
 *
 * The two bases are not interchangeable — dollars-per-day shifts every
 * comp by the same amount, a percent scales each by its own value — so
 * the note goes on the chart rather than being left implicit.
 */
function adjusterFor(metric, mc) {
  const effMs = effectiveMs();
  const ovr = overrideRate();
  const on = opts.adjusted && effMs != null;

  if (!on) {
    return {
      adjust: (rec) => rec[metric],
      adjusted: false,
      suffix: '',
      note: 'Nominal rates, as sold — no time adjustment applied.',
    };
  }
  if (ovr != null) {
    return {
      adjust: (rec) => timeAdjust(rec, metric, null, effMs, { overrideRate: ovr }),
      adjusted: true,
      suffix: ' (adjusted)',
      note: `Rates carried to ${opts.effDate} at ${(ovr * 100).toFixed(1)}% per year (judgement rate).`,
    };
  }
  if (!mc) {
    return {
      adjust: (rec) => rec[metric],
      adjusted: false,
      suffix: '',
      note: 'Too few dated sales to measure a trend — showing nominal rates.',
    };
  }
  return {
    adjust: (rec) => timeAdjust(rec, metric, mc.perDay, effMs),
    adjusted: true,
    suffix: ' (adjusted)',
    note: `Rates carried to ${opts.effDate} at the fitted trend `
      + `(${mc.perDay >= 0 ? '+' : '−'}${fmtRate(Math.abs(mc.perDay))} per day).`,
  };
}

function buildRateCharts() {
  const records = data.records || [];
  const metric = areaMetric();
  const areaFmt = areaMoneyFmt();
  const unit = areaUnitLabel();

  // One regression per metric, reused by the over-time chart's caption
  // and by every time-adjusted chart, so the two never disagree.
  const mcLot = marketConditions(records, 'ppl');
  const mcArea = marketConditions(records, metric);

  const lotAdj = adjusterFor('ppl', mcLot);
  const areaAdj = adjusterFor(metric, mcArea);
  const adjLot = lotAdj.adjust;
  const adjArea = areaAdj.adjust;
  const size = (rec) => rec[sizeField()];

  const { refName, distLabel, distEmpty, distStats } = distContext();

  // Charts are grouped by RATE, not by question: every price-per-area
  // chart first, then every price-per-lot chart. Reading down a column
  // of one rate and then the other is how the comparison actually gets
  // made — interleaving them means re-reading the axis label on each
  // card to work out which rate you are looking at.
  const charts = [];

  // ---- Price per acre (or per SF) --------------------------------

  // Over time. Raw rates; the fitted line IS the trend, and a cubic is
  // legitimate here because multi-year turns in the market do happen.
  {
    const pts = pointsFor(records, (r) => r.dateMs, (r) => r[metric]);
    const trend = timeTrend(records, pts, metric, mcArea, areaFmt);
    charts.push(drawChart({
      title: `Price per ${unit.toLowerCase()} over time`,
      subtitle: ['Rates as sold — the Nominal/Time-adjusted toggle does not apply here.',
        trend.note].filter(Boolean).join(' '),
      points: pts, xIsDate: true,
      xLabel: 'Sale date', yLabel: `Price per ${unit.toLowerCase()}`,
      yFormat: areaFmt, yAxisFormat: fmtAxisMoney,
      fits: trend.fits, legend: legendFor(trend.fits),
      refLines: mcArea?.median != null ? [{ y: mcArea.median, label: 'median' }] : [],
      stats: trend.stats,
      tooltipRows,
    }));
  }

  // By lot size, time-adjusted. Power curve, not cubic — see fitPower.
  {
    const pts = pointsFor(records, size, adjArea);
    const fits = fitsFor(pts, { curve: 'power' });
    charts.push(drawChart({
      title: `Price per ${unit.toLowerCase()} by lot size`,
      subtitle: areaAdj.note,
      points: pts,
      xLabel: sizeAxisLabel(), yLabel: `Price per ${unit.toLowerCase()}${areaAdj.suffix}`,
      yFormat: areaFmt, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits),
      refLines: subjectRef(),
      stats: [...sizeStats(pts, areaAdj.adjusted, areaFmt), ...powerStat(fits)],
      tooltipRows,
    }));
  }

  // The same by-size view split by zoning. Colour is the variable here,
  // so this chart drops the curve entirely: its orange would collide
  // with a zone's hue, and the question is "do these zones price
  // differently", not "how does the rate decay with size".
  {
    const zones = topZones(records, SERIES_COLORS.length);
    const colorByZone = new Map(zones.map((z, i) => [z.key, SERIES_COLORS[i]]));
    const pts = pointsFor(records, size, adjArea,
      (r) => colorByZone.get(String(r.zone || '').trim()) || OTHER_COLOR);
    const fits = fitsFor(pts, { curve: 'none' });
    const zoneKeys = new Set(colorByZone.keys());
    const hasOther = records.some((r) => !zoneKeys.has(String(r.zone || '').trim()));
    const legend = [
      ...zones.map((z) => ({ label: `${z.key} (${z.count})`, color: colorByZone.get(z.key) })),
      ...(hasOther ? [{ label: 'Other / none', color: OTHER_COLOR }] : []),
      ...fits.map((f) => ({ label: f.label, color: f.color, dash: !!f.dash })),
    ];
    charts.push(drawChart({
      title: `Price per ${unit.toLowerCase()} by size and zoning`,
      subtitle: `${areaAdj.note} The three most common zones are coloured; the rest fold into Other.`,
      points: pts,
      xLabel: sizeAxisLabel(), yLabel: `Price per ${unit.toLowerCase()}${areaAdj.suffix}`,
      yFormat: areaFmt, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legend.length > 1 ? legend : null,
      refLines: subjectRef(),
      stats: sizeStats(pts, areaAdj.adjusted, areaFmt),
      tooltipRows,
      empty: 'No sales in the current filter carry both a zoning code and a usable rate.',
    }));
  }

  // By distance from the reference point. Cubic, not power: distance is
  // not a clean decay the way size is. Secondary influences kick in
  // further out — a lake, another urban centre — and put real humps in
  // the curve that a monotonic power fit would flatten away.
  {
    const pts = pointsFor(records, distanceFor, adjArea);
    const fits = fitsFor(pts, { curve: 'cubic' });
    charts.push(drawChart({
      title: `Price per ${unit.toLowerCase()} by distance`,
      subtitle: `Measured from ${refName}. ${areaAdj.note}`,
      points: pts,
      xLabel: distLabel, yLabel: `Price per ${unit.toLowerCase()}${areaAdj.suffix}`,
      yFormat: areaFmt, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits),
      refLines: subjectDistanceRef(),
      stats: distStats(pts, areaAdj.adjusted, areaFmt),
      tooltipRows,
      empty: distEmpty,
    }));
  }

  // ---- Price per lot ---------------------------------------------

  {
    const pts = pointsFor(records, (r) => r.dateMs, (r) => r.ppl);
    const trend = timeTrend(records, pts, 'ppl', mcLot, fmtMoney0);
    charts.push(drawChart({
      title: 'Price per lot over time',
      subtitle: ['Prices as sold. One point per sale; larger dots are multi-parcel assemblies.',
        trend.note].filter(Boolean).join(' '),
      points: pts, xIsDate: true,
      xLabel: 'Sale date', yLabel: 'Price per lot',
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney,
      fits: trend.fits, legend: legendFor(trend.fits),
      refLines: mcLot?.median != null ? [{ y: mcLot.median, label: 'median' }] : [],
      stats: trend.stats,
      tooltipRows,
    }));
  }

  {
    const pts = pointsFor(records, size, adjLot);
    const fits = fitsFor(pts, { curve: 'power' });
    charts.push(drawChart({
      title: 'Price per lot by lot size',
      subtitle: lotAdj.note,
      points: pts,
      xLabel: sizeAxisLabel(), yLabel: `Price per lot${lotAdj.suffix}`,
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits),
      refLines: subjectRef(),
      stats: [...sizeStats(pts, lotAdj.adjusted, fmtMoney0), ...powerStat(fits)],
      tooltipRows,
    }));
  }

  {
    const pts = pointsFor(records, distanceFor, adjLot);
    const fits = fitsFor(pts, { curve: 'cubic' });
    charts.push(drawChart({
      title: 'Price per lot by distance',
      subtitle: `Measured from ${refName}. ${lotAdj.note}`,
      points: pts,
      xLabel: distLabel, yLabel: `Price per lot${lotAdj.suffix}`,
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits),
      refLines: subjectDistanceRef(),
      stats: distStats(pts, lotAdj.adjusted, fmtMoney0),
      tooltipRows,
      empty: distEmpty,
    }));
  }

  return charts;
}

/**
 * Total-price charts — the second tab.
 *
 * Every y-axis here is the WHOLE consideration, undivided. That is the point
 * of the tab: on a land-and-building sale a per-acre rate divides a price
 * that is mostly building by the land the building happens to sit on, and
 * two properties with identical houses on quarter-acre and half-acre lots
 * come out an implausible factor apart. Total price asks the question the
 * improved market actually answers.
 *
 * NO by-size chart, deliberately (Jason, 2026-08-18): MAO carries no size for
 * rural residential sales, so the x-axis would be empty for exactly the
 * population this tab exists to serve. The size question is on the rates tab,
 * where the data supports it.
 *
 * This set does NOT filter to residential land-and-building. It plots whatever
 * the main window's filters are showing, the same records the rates tab gets —
 * sale type is already selectable at load time and through the Primary
 * Property filter, and a tab that silently re-filtered would disagree with the
 * table view sitting underneath it.
 */
function buildTotalCharts() {
  const records = data.records || [];
  const { refName, distLabel, distEmpty, distStats } = distContext();

  // One regression on total price, shared by the over-time caption and the
  // time adjustment, so the two never state different trends.
  const mcPrice = marketConditions(records, 'price');
  const priceAdj = adjusterFor('price', mcPrice);
  const adjPrice = priceAdj.adjust;

  const charts = [];

  // Over time. Prices as sold — carrying them to one date is precisely what
  // would flatten the trend this chart exists to show.
  {
    const pts = pointsFor(records, (r) => r.dateMs, (r) => r.price);
    const trend = timeTrend(records, pts, 'price', mcPrice, fmtMoney0);
    charts.push(drawChart({
      title: 'Total price over time',
      subtitle: ['Prices as sold. One point per sale; larger dots are multi-parcel assemblies.',
        trend.note].filter(Boolean).join(' '),
      points: pts, xIsDate: true,
      xLabel: 'Sale date', yLabel: 'Total sale price',
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney,
      fits: trend.fits, legend: legendFor(trend.fits),
      refLines: mcPrice?.median != null ? [{ y: mcPrice.median, label: 'median' }] : [],
      stats: trend.stats,
      tooltipRows,
    }));
  }

  // By distance. Cubic for the same reason the rate charts use one — a lake
  // or a second town further out puts real humps in the curve.
  {
    const pts = pointsFor(records, distanceFor, adjPrice);
    const fits = fitsFor(pts, { curve: 'cubic' });
    charts.push(drawChart({
      title: 'Total price by distance',
      subtitle: `Measured from ${refName}. ${priceAdj.note}`,
      points: pts,
      xLabel: distLabel, yLabel: `Total sale price${priceAdj.suffix}`,
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits),
      refLines: subjectDistanceRef(),
      stats: distStats(pts, priceAdj.adjusted, fmtMoney0),
      tooltipRows,
      empty: distEmpty,
    }));
  }

  // Against assessed value.
  //
  // The record carries the RATIO (saleToAsmt), not the assessed total, so the
  // total is recovered as price / ratio — exact, since the ratio was computed
  // from that same price. Sales missing either drop out, which is the usual
  // "missing = exclude" rule and here means no assessment on file.
  //
  // The 1:1 line is supplied as a FIT rather than a refLine because refLines
  // are horizontal or vertical only; a diagonal cannot be expressed as one.
  // It is the line that matters: above it the sale beat its assessment, below
  // it the sale went under, and a cluster hard below is the shape a
  // non-arms-length transfer makes.
  {
    const assessedOf = (r) => (
      r.saleToAsmt != null && r.saleToAsmt > 0 && r.price != null
        ? r.price / r.saleToAsmt
        : null);
    const pts = pointsFor(records, assessedOf, adjPrice);
    const fits = [
      ...fitsFor(pts, { curve: 'none' }),
      { predict: (x) => x, color: INK.muted, dash: '4 3', label: 'Sale = assessed (1:1)' },
    ];
    charts.push(drawChart({
      title: 'Total price against assessed value',
      subtitle: `Points above the 1:1 line sold over their assessment. ${priceAdj.note}`,
      points: pts,
      xLabel: 'Total assessed value', yLabel: `Total sale price${priceAdj.suffix}`,
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisMoney,
      fits, legend: legendFor(fits),
      stats: spreadStats(pts, {
        xName: 'Median assessed',
        xFormat: fmtMoney0,
        adjusted: priceAdj.adjusted,
        yFormat: fmtMoney0,
      }),
      tooltipRows,
      empty: 'No sales in the current filter carry an assessed value to compare against.',
    }));
  }

  return charts;
}

// ---------- table view ---------------------------------------------

const TABLE_COLS = [
  ['Sold', (r) => r.dateText || fmtDate(r.dateMs)],
  ['Municipality', (r) => r.muni],
  ['Address', (r) => r.address || (r.rolls || []).join(', ')],
  ['Parcels', (r) => String(r.parcelCount)],
  ['Price', (r) => fmtMoney0(r.price)],
  ['Lot acres', (r) => (r.lotAcres != null ? fmtNum(r.lotAcres) : '—')],
  ['Lot sq ft', (r) => (r.lotSf != null ? fmtNum(r.lotSf) : '—')],
  ['$/Lot', (r) => (r.ppl != null ? fmtMoney0(r.ppl) : '—')],
  ['$/Acre', (r) => (r.ppa != null ? fmtMoney0(r.ppa) : '—')],
  ['$/SF', (r) => (r.ppsf != null ? fmtMoney2(r.ppsf) : '—')],
  ['Sale/Asmt', (r) => (r.saleToAsmt != null ? r.saleToAsmt.toFixed(2) : '—')],
  ['Zoning', (r) => r.zone || '—'],
  ['Distance (km)', (r) => { const d = distanceFor(r); return d != null ? fmtNum(d) : '—'; }],
];

function renderTable() {
  const thead = els.table.tHead;
  const tbody = els.table.tBodies[0];
  thead.textContent = '';
  tbody.textContent = '';

  const hr = document.createElement('tr');
  for (const [label] of TABLE_COLS) {
    const th = document.createElement('th');
    th.textContent = label;
    hr.appendChild(th);
  }
  thead.appendChild(hr);

  // Every cell goes in via textContent — addresses, municipality names
  // and zoning codes all originate in a pasted CSV.
  for (const rec of data.records) {
    const tr = document.createElement('tr');
    for (const [, get] of TABLE_COLS) {
      const td = document.createElement('td');
      td.textContent = get(rec) ?? '';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

// ---------- render ---------------------------------------------------

function renderStatus() {
  const n = data.records.length;
  if (!data.meta) {
    els.status.textContent = 'Waiting for the Sales Analysis tab…';
    return;
  }
  // Locale time can itself end in a period ("08:40 a.m."), so the
  // sentence is built to not add a second one.
  const when = receivedAt
    ? new Date(receivedAt).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' })
    : '';
  const sales = `${n} ${n === 1 ? 'sale' : 'sales'}`;
  const parcels = data.meta.parcelCount != null ? ` from ${data.meta.parcelCount} parcels` : '';
  els.status.textContent = opts.frozen
    ? `Frozen — ${sales}${parcels}, as of ${when} · filter changes are being ignored.`
    : `Live — ${sales}${parcels} · tracking the Sales Analysis filters · updated ${when}`;
  els.status.classList.toggle('is-frozen', opts.frozen);
}

function render() {
  renderStatus();

  const has = data.records.length > 0;
  els.empty.hidden = has;
  els.grid.hidden = !has;
  els.tablePanel.hidden = !has || !opts.showTable;

  if (!has) {
    els.grid.textContent = '';
    return;
  }

  // Rebuild into a fragment and swap in one go, so a re-render on every
  // keystroke in the main window's filters doesn't flash an empty grid.
  const frag = document.createDocumentFragment();
  for (const fig of buildCharts()) frag.appendChild(fig);
  els.grid.textContent = '';
  els.grid.appendChild(frag);

  if (opts.showTable) renderTable();
}

function syncControls() {
  // Tab state. The size-unit control picks between $/acre and $/SF, so it
  // governs nothing on the total-price tab; showing it there would be an
  // inert switch inviting a click that changes no chart on screen.
  const onTotal = opts.tab === 'total';
  els.tabRates.setAttribute('aria-selected', String(!onTotal));
  els.tabTotal.setAttribute('aria-selected', String(onTotal));
  els.tabRates.classList.toggle('is-on', !onTotal);
  els.tabTotal.classList.toggle('is-on', onTotal);
  els.ctlUnit.hidden = onTotal;
  // Name the charts the Nominal/Time-adjusted toggle actually reaches on
  // THIS tab — the total set has no by-size chart to speak of.
  els.ratesHint.textContent = onTotal
    ? 'Applies to the by-distance and assessed-value charts.'
    : 'Applies to the by-size and by-distance charts.';

  els.unitAcres.setAttribute('aria-checked', String(isAcres()));
  els.unitSf.setAttribute('aria-checked', String(!isAcres()));
  els.unitAcres.classList.toggle('is-on', isAcres());
  els.unitSf.classList.toggle('is-on', !isAcres());
  els.freeze.checked = opts.frozen;
  els.showTable.checked = opts.showTable;
  els.adjBasis.value = opts.adjBasis;
  els.adjRate.hidden = opts.adjBasis !== 'override';

  els.ratesNominal.setAttribute('aria-checked', String(!opts.adjusted));
  els.ratesAdjusted.setAttribute('aria-checked', String(opts.adjusted));
  els.ratesNominal.classList.toggle('is-on', !opts.adjusted);
  els.ratesAdjusted.classList.toggle('is-on', opts.adjusted);

  // The effective date is NOT disabled in Nominal mode: it still anchors
  // the stated-rate curve on the two over-time charts, which the
  // Nominal/Time-adjusted toggle does not govern.
  els.adjHint.textContent = opts.adjBasis === 'override'
    ? 'Percent per year. "5" and "0.05" both mean 5%.'
    : 'Dollars per day, measured from the sales on screen.';

  // Never write .value into a field the user is currently typing in.
  //
  // syncControls runs on EVERY message from the main window, and the
  // main window publishes on every renderTable — so with a filter being
  // adjusted next door, assigning .value to a focused date input resets
  // its segments mid-entry and the field reads as uneditable. Same for
  // the rate box. Both are re-synced the moment focus leaves.
  if (document.activeElement !== els.effDate) els.effDate.value = opts.effDate;
  if (document.activeElement !== els.adjRate) els.adjRate.value = opts.adjRate;

  // The subject option is only meaningful once a subject roll is set in
  // the main window; disabling it beats silently measuring from
  // somewhere else than the label claims.
  const hasSubject = Number.isFinite(data.meta?.subject?.lat);
  const subjOpt = els.distRef.querySelector('option[value="subject"]');
  if (subjOpt) {
    subjOpt.disabled = !hasSubject;
    subjOpt.textContent = hasSubject
      ? `Subject parcel${data.meta.subject.roll ? ` (${data.meta.subject.roll})` : ''}`
      : 'Subject parcel — none set';
  }
  els.distRef.value = activeDistRef();
}

// ---------- wiring ---------------------------------------------------

function setOpt(patch) {
  Object.assign(opts, patch);
  writeOpts();
  syncControls();
  render();
}

els.tabRates.addEventListener('click', () => setOpt({ tab: 'rates' }));
els.tabTotal.addEventListener('click', () => setOpt({ tab: 'total' }));
els.unitAcres.addEventListener('click', () => setOpt({ unit: 'acres' }));
els.unitSf.addEventListener('click', () => setOpt({ unit: 'sf' }));
// Both 'input' and 'change': a date field fires 'change' only once the
// whole date is valid, and on some platforms not until blur. Listening to
// 'input' as well means the charts follow as soon as a usable date
// exists. effectiveMs() ignores anything that isn't a full YYYY-MM-DD, so
// half-typed dates are harmless.
for (const evt of ['input', 'change']) {
  els.effDate.addEventListener(evt, () => setOpt({ effDate: els.effDate.value }));
}
els.ratesNominal.addEventListener('click', () => setOpt({ adjusted: false }));
els.ratesAdjusted.addEventListener('click', () => setOpt({ adjusted: true }));
els.adjBasis.addEventListener('change', () => setOpt({ adjBasis: els.adjBasis.value }));
els.adjRate.addEventListener('input', () => setOpt({ adjRate: els.adjRate.value }));
els.distRef.addEventListener('change', () => setOpt({ distRef: els.distRef.value }));
els.freeze.addEventListener('change', () => setOpt({ frozen: els.freeze.checked }));
els.showTable.addEventListener('change', () => setOpt({ showTable: els.showTable.checked }));

// Re-lay the SVG-dependent tooltip anchors after a resize. Charts scale
// with their viewBox so nothing needs redrawing; only an open tooltip
// would be left pointing at the wrong pixel, and re-rendering is cheap
// enough not to warrant tracking that separately.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 150);
});

const channel = new BroadcastChannel(CHANNEL_NAME);
channel.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'sales') return;
  if (opts.frozen) return;
  data = { records: Array.isArray(msg.records) ? msg.records : [], meta: msg.meta || null };
  receivedAt = Date.now();
  syncControls();
  render();
});

// The main window may have rendered long before this tab opened, so ask
// for the current slice rather than waiting for the next filter change.
channel.postMessage({ type: 'request' });

syncControls();
render();
