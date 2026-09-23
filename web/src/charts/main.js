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
 * carried to an effective date at the measured market rate.
 *
 * From the land template's CMS Charts page (Jason, 2026-09-22): a click on a
 * dot unticks that sale in the grid (and back), the CMS2 percentile trim with
 * its own refitted rate beside the untrimmed one, the sale/assessment review
 * flag, the filter waterfall, and a PNG of each chart. It still does NOT
 * reproduce the template's criteria subtitle block or full caption.
 */

import './charts.css';
import {
  median, marketConditions, timeAdjust, fitLinear, fitPoly, fitPower,
  normalizeOverrideRate, topZones, dotRadius, haversineKm, WINNIPEG_CENTRE,
  percentileTrim, saleAsmtFlag, TRIM_MIN_SALES,
} from '../lib/salesCharts.js';
import {
  drawChart, SERIES_COLORS, OTHER_COLOR, INK, slugify,
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
  unitFf: $('unit-ff'),
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
  showExcluded: $('show-excluded'),
  trimOn: $('trim-on'),
  trimLo: $('trim-lo'),
  trimHi: $('trim-hi'),
  trimHint: $('trim-hint'),
  waterfall: $('waterfall-panel'),
  waterfallSummary: $('waterfall-summary'),
  waterfallBody: $('waterfall-body'),
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
  // Sales unticked in the grid, drawn pale so they can be clicked back in.
  showExcluded: true,
  // The land template's CMS2: trim to the loPct–hiPct percentile band of
  // each chart's own measure, and refit the time trend on what is left.
  trim: false,
  trimLo: 5,
  trimHi: 95,
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

/**
 * The size unit, as one table. The rate field and the size field move
 * together — plotting $/acre against a square-foot x-axis would be
 * unreadable — and front feet is the land template's third unit (AcOrSF =
 * "ff"): $/front foot against frontage, the way an urban lot is compared.
 *
 * `perUnit` names the rate ("Price per acre"); `short` its column/table form.
 * $/SF runs to cents; $/acre, $/front foot and $/lot are whole dollars.
 */
const UNITS = {
  acres: {
    metric: 'ppa', size: 'lotAcres', short: 'Acre', perUnit: 'acre',
    axis: 'Lot size (acres)', sizeText: (v) => `${fmtNum(v)} ac`, money: fmtMoney0,
    subjectSize: (s) => (Number(s?.acres) > 0 ? Number(s.acres) : null),
  },
  sf: {
    metric: 'ppsf', size: 'lotSf', short: 'SF', perUnit: 'sf',
    axis: 'Lot size (sq ft)', sizeText: (v) => `${fmtNum(v)} sf`, money: fmtMoney2,
    subjectSize: (s) => (Number(s?.acres) > 0 ? Number(s.acres) * 43560 : null),
  },
  ff: {
    metric: 'ppff', size: 'lotFrontFt', short: 'FF', perUnit: 'front foot',
    axis: 'Lot frontage (feet)', sizeText: (v) => `${fmtNum(v)} ft`, money: fmtMoney0,
    subjectSize: (s) => (Number(s?.frontFt) > 0 ? Number(s.frontFt) : null),
  },
};
const unitSpec = () => UNITS[opts.unit] || UNITS.acres;
const areaMetric = () => unitSpec().metric;
const sizeField = () => unitSpec().size;
const areaUnitLabel = () => unitSpec().short;
const sizeAxisLabel = () => unitSpec().axis;
const areaMoneyFmt = () => unitSpec().money;

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
function tooltipRows(rec, pt) {
  if (!rec) return [];
  const rows = [];
  // What the dot IS comes first: a pale or hollow dot is otherwise a
  // question the reader has to answer from the legend.
  const state = pt?.state || (rec.excluded ? 'excluded' : 'in');
  if (state === 'excluded') rows.push(['Unticked in the grid', 'Excluded']);
  else if (state === 'trimmed') rows.push([`Outside ${opts.trimLo}th–${opts.trimHi}th pctl`, 'Trimmed']);
  const flag = saleAsmtFlag(rec.saleToAsmt);
  if (flag && flag !== 'No assessment') {
    rows.push(['Sale/Asmt flag', `${flag} (${rec.saleToAsmt.toFixed(2)})`]);
  }
  rows.push(
    [rec.parcelCount > 1 ? `${rec.parcelCount}-parcel sale` : 'Sale', fmtMoney0(rec.price)],
    ['Sold', rec.dateText || fmtDate(rec.dateMs)],
  );
  const lotSize = rec[sizeField()];
  if (lotSize != null) rows.push(['Lot size', unitSpec().sizeText(lotSize)]);
  // Frontage alongside an area unit too: it is the other half of how an
  // urban lot is described, and the roll only states one or the other.
  if (opts.unit !== 'ff' && rec.lotFrontFt != null) rows.push(['Frontage', `${fmtNum(rec.lotFrontFt)} ft`]);
  if (rec.ppl != null) rows.push(['$/Lot', fmtMoney0(rec.ppl)]);
  if (rec.ppff != null) rows.push(['$/FF', fmtMoney0(rec.ppff)]);
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
  if (!opts.frozen && rec.keys?.length) {
    rows.push(['', state === 'excluded' ? 'Click to include' : 'Click to exclude']);
  }
  return rows;
}

// ---------- the comparable set (CMS1 / CMS2) -------------------------

/** Sales ticked in the grid — the land template's CMS1. */
function activeRecords() {
  return (data.records || []).filter((r) => !r.excluded);
}

/** What the charts draw: every sale, or only the ticked ones when the
 *  "Show excluded" box is off. */
function drawnRecords() {
  return opts.showExcluded ? (data.records || []) : activeRecords();
}

/**
 * The comparable set for one measure, with and without the percentile trim.
 *
 *   active   — CMS1: the ticked sales
 *   fitted   — what every fit, median and rate is taken over: CMS2 (the
 *              trimmed set) when the trim is on and applies, else CMS1
 *   mc / mc1 — the market-conditions regression on `fitted` / on CMS1, so a
 *              trimmed chart can state both rates as the template does
 *   stateOf  — 'in' | 'trimmed' | 'excluded' for a record, for drawing
 *
 * Built per MEASURE because the template trims on the chart's own unit
 * price: a sale can sit inside the $/acre band and outside the $/lot one.
 * Cached per render, so the charts sharing a measure share one trim.
 */
let cmsCache = new Map();
function cmsFor(metric) {
  if (cmsCache.has(metric)) return cmsCache.get(metric);
  const active = activeRecords();
  const trim = opts.trim ? percentileTrim(active, metric, opts.trimLo, opts.trimHi) : null;
  const applied = !!trim?.applied;
  const fitted = applied ? active.filter((r) => trim.keep.has(r.saleId)) : active;
  const mc1 = marketConditions(active, metric);
  const mc = applied ? marketConditions(fitted, metric) : mc1;
  const fittedIds = new Set(fitted.map((r) => r.saleId));
  const cms = {
    metric, active, fitted, mc, mc1, trim, applied,
    stateOf: (rec) => {
      if (rec.excluded) return 'excluded';
      if (applied && !fittedIds.has(rec.saleId)) return 'trimmed';
      return 'in';
    },
  };
  cmsCache.set(metric, cms);
  return cms;
}

/** The trim band as words, for subtitles and notes. */
function trimWords() {
  return `${opts.trimLo}th–${opts.trimHi}th percentile`;
}

/** Legend keys for the point states a chart actually shows. */
function stateLegend(pts) {
  const out = [];
  if (pts.some((p) => p.state === 'trimmed')) {
    out.push({ label: `Trimmed (outside ${trimWords()})`, dot: 'hollow', color: SERIES_COLORS[0] });
  }
  if (pts.some((p) => p.state === 'excluded')) {
    out.push({ label: 'Excluded (unticked)', dot: 'pale' });
  }
  if (pts.some((p) => p.flagged)) {
    out.push({ label: 'Sale/Asmt flag', dot: 'ring' });
  }
  return out;
}

/**
 * Click on a dot: untick (or re-tick) that sale in the grid. The grid is the
 * one place the selection lives; the main window re-publishes and this tab
 * redraws from that, so the charts, the map and the CSV export can never
 * disagree about which sales are in. Off while frozen — a frozen tab
 * ignores the republish, so the click would appear to do nothing.
 */
function onPointClick(rec) {
  if (opts.frozen || !rec?.keys?.length) return;
  channel.postMessage({ type: 'set-excluded', keys: rec.keys, excluded: !rec.excluded });
}

/** PNG file stem: the chart title plus today's date. */
const pngName = (title) => `${slugify(title)}-${todayLocal()}`;

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

/**
 * A sale contributes to a chart only when both axes resolve. Every drawn
 * sale gets a point; `cms` decides its state (in / trimmed / excluded), and
 * only the 'in' points reach a fit or a stat — see inOnly().
 */
function pointsFor(cms, xOf, yOf, colorOf) {
  const out = [];
  for (const rec of drawnRecords()) {
    const x = xOf(rec);
    const y = yOf(rec);
    if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) continue;
    const flag = saleAsmtFlag(rec.saleToAsmt);
    out.push({
      x, y, rec,
      r: dotRadius(rec.parcelCount),
      color: colorOf ? colorOf(rec) : SERIES_COLORS[0],
      state: cms.stateOf(rec),
      flagged: flag !== '' && flag !== 'No assessment',
    });
  }
  return out;
}

/** The points the fits and stats are taken over. */
const inOnly = (pts) => pts.filter((p) => p.state === 'in');

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
  const xy = inOnly(points).map((p) => ({ x: p.x, y: p.y }));
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

/** Fit lines plus the point-state keys (trimmed / excluded / flagged) the
 *  chart actually shows. */
function legendFor(fits, pts = [], extra = []) {
  const items = [...extra, ...fits.map((f) => ({
    label: f.label, color: f.color, dash: !!f.dash,
  })), ...stateLegend(pts)];
  return items.length > 1 ? items : null;
}

/** "+4.1%" style annual rate, or null. */
const pctWords = (mc) => (mc?.pctPerYear != null ? `${(mc.pctPerYear * 100).toFixed(1)}%` : null);

/**
 * n / median / trend figures — the numbers the QMD puts in its caption.
 * With the trim applied, `mc` is the CMS2 regression and the untrimmed CMS1
 * rate is shown beside it, as the template reports both tiers.
 */
function trendStats(points, cms, fmt) {
  const mc = cms.mc;
  const fitted = inOnly(points);
  const stats = [{ label: 'Sales', value: String(fitted.length) }];
  const med = median(fitted.map((p) => p.y));
  if (med != null) stats.push({ label: 'Median', value: fmt(med) });
  if (mc) {
    stats.push({
      label: 'Per day',
      value: `${mc.perDay >= 0 ? '+' : '−'}${fmtRate(Math.abs(mc.perDay))}`,
      title: 'Slope of the price-vs-date regression — the market-conditions rate.',
    });
    if (mc.pctPerYear != null) {
      stats.push({
        label: cms.applied ? 'Per year (trimmed)' : 'Per year',
        value: pctWords(mc),
        title: `${fmt(mc.perYear)} per year over the median of ${fmt(mc.median)}`
          + (cms.applied ? `, fitted on the ${trimWords()} set.` : '.'),
      });
    }
    stats.push({ label: 'R²', value: mc.r2.toFixed(2) });
  }
  if (cms.applied && pctWords(cms.mc1)) {
    stats.push({
      label: 'Per year (all)',
      value: pctWords(cms.mc1),
      title: `The same regression on all ${cms.active.length} ticked sales, before the trim.`,
    });
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
  const fitted = inOnly(points);
  const stats = [{ label: 'Sales', value: String(fitted.length) }];
  const medX = median(fitted.map((p) => p.x));
  if (medX != null) stats.push({ label: xName, value: xFormat(medX) });
  const medY = median(fitted.map((p) => p.y));
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
function timeTrend(cms, points, fmt) {
  const ovr = overrideRate();
  const effMs = effectiveMs();

  if (ovr != null && effMs != null) {
    const stated = statedRateFit(cms.fitted, cms.metric, ovr, effMs);
    const pct = `${(ovr * 100).toFixed(1)}%`;
    const fitted = inOnly(points);
    const stats = [{ label: 'Sales', value: String(fitted.length) }];
    const med = median(fitted.map((p) => p.y));
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
    stats: trendStats(points, cms, fmt),
    note: cms.applied ? `Trend fitted on the ${trimWords()} set.` : '',
  };
}

/** Trim note for a chart's subtitle when the trim is on but could not
 *  apply — so an untrimmed chart never looks like a trimmed one. */
function trimSkipNote(cms) {
  if (!opts.trim || cms.applied) return '';
  return `Trim not applied: it needs at least ${TRIM_MIN_SALES} sales with this measure.`;
}

/** Median-size stats for the three by-size charts. */
function sizeStats(points, adjusted, yFormat) {
  return spreadStats(points, {
    xName: 'Median size',
    xFormat: (v) => unitSpec().sizeText(v),
    adjusted,
    yFormat,
  });
}

/** Subject size as a vertical reference, when the main window knows it. */
function subjectRef() {
  const x = unitSpec().subjectSize(data.meta?.subject);
  if (!Number.isFinite(x) || x <= 0) return [];
  return [{
    x,
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
function adjusterFor(cms) {
  const { metric, mc } = cms;
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
      + `(${mc.perDay >= 0 ? '+' : '−'}${fmtRate(Math.abs(mc.perDay))} per day`
      + `${cms.applied ? `, fitted on the ${trimWords()} set` : ''}).`,
  };
}

/**
 * drawChart with the options every chart on this page shares: the tooltip,
 * click-to-exclude (off while frozen) and the PNG button named for the title.
 */
function chart(spec) {
  return drawChart({
    tooltipRows,
    onPointClick: opts.frozen ? null : onPointClick,
    pngName: pngName(spec.title),
    ...spec,
  });
}

/** Join subtitle fragments, skipping the empty ones. */
const sub = (...parts) => parts.filter(Boolean).join(' ');

function buildRateCharts() {
  const records = activeRecords();
  const metric = areaMetric();
  const areaFmt = areaMoneyFmt();
  // How the rate reads in a title: "Price per acre" / "per sf" / "per front foot".
  const perUnit = unitSpec().perUnit;

  // One comparable set per measure — CMS1, and CMS2 when the trim is on —
  // reused by the over-time chart's caption and by every time-adjusted
  // chart of that measure, so the two never disagree.
  const cmsLot = cmsFor('ppl');
  const cmsArea = cmsFor(metric);

  const lotAdj = adjusterFor(cmsLot);
  const areaAdj = adjusterFor(cmsArea);
  const adjLot = lotAdj.adjust;
  const adjArea = areaAdj.adjust;
  const size = (rec) => rec[sizeField()];
  // Front feet is the one unit a large share of sales cannot carry, so an
  // empty chart has to say why rather than look broken.
  const unitEmpty = opts.unit === 'ff'
    ? 'No sales in the current filter carry a $/front foot. Every parcel in a sale must state '
      + 'a frontage on the roll; most rural parcels state an area instead.'
    : undefined;

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
    const pts = pointsFor(cmsArea, (r) => r.dateMs, (r) => r[metric]);
    const trend = timeTrend(cmsArea, pts, areaFmt);
    charts.push(chart({
      title: `Price per ${perUnit} over time`,
      subtitle: sub('Rates as sold — the Nominal/Time-adjusted toggle does not apply here.',
        trend.note, trimSkipNote(cmsArea)),
      points: pts, xIsDate: true,
      xLabel: 'Sale date', yLabel: `Price per ${perUnit}`,
      yFormat: areaFmt, yAxisFormat: fmtAxisMoney,
      fits: trend.fits, legend: legendFor(trend.fits, pts),
      refLines: cmsArea.mc?.median != null ? [{ y: cmsArea.mc.median, label: 'median' }] : [],
      stats: trend.stats,
      empty: unitEmpty,
    }));
  }

  // By lot size, time-adjusted. Power curve, not cubic — see fitPower.
  {
    const pts = pointsFor(cmsArea, size, adjArea);
    const fits = fitsFor(pts, { curve: 'power' });
    charts.push(chart({
      title: `Price per ${perUnit} by lot size`,
      subtitle: sub(areaAdj.note, trimSkipNote(cmsArea)),
      points: pts,
      xLabel: sizeAxisLabel(), yLabel: `Price per ${perUnit}${areaAdj.suffix}`,
      yFormat: areaFmt, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits, pts),
      refLines: subjectRef(),
      stats: [...sizeStats(pts, areaAdj.adjusted, areaFmt), ...powerStat(fits)],
      empty: unitEmpty,
    }));
  }

  // The same by-size view split by zoning. Colour is the variable here,
  // so this chart drops the curve entirely: its orange would collide
  // with a zone's hue, and the question is "do these zones price
  // differently", not "how does the rate decay with size".
  {
    const zones = topZones(records, SERIES_COLORS.length);
    const colorByZone = new Map(zones.map((z, i) => [z.key, SERIES_COLORS[i]]));
    const pts = pointsFor(cmsArea, size, adjArea,
      (r) => colorByZone.get(String(r.zone || '').trim()) || OTHER_COLOR);
    const fits = fitsFor(pts, { curve: 'none' });
    const zoneKeys = new Set(colorByZone.keys());
    const hasOther = records.some((r) => !zoneKeys.has(String(r.zone || '').trim()));
    const legend = [
      ...zones.map((z) => ({ label: `${z.key} (${z.count})`, color: colorByZone.get(z.key) })),
      ...(hasOther ? [{ label: 'Other / none', color: OTHER_COLOR }] : []),
      ...fits.map((f) => ({ label: f.label, color: f.color, dash: !!f.dash })),
      ...stateLegend(pts),
    ];
    charts.push(chart({
      title: `Price per ${perUnit} by size and zoning`,
      subtitle: sub(areaAdj.note, 'The three most common zones are coloured; the rest fold into Other.',
        trimSkipNote(cmsArea)),
      points: pts,
      xLabel: sizeAxisLabel(), yLabel: `Price per ${perUnit}${areaAdj.suffix}`,
      yFormat: areaFmt, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legend.length > 1 ? legend : null,
      refLines: subjectRef(),
      stats: sizeStats(pts, areaAdj.adjusted, areaFmt),
      empty: 'No sales in the current filter carry both a zoning code and a usable rate.',
    }));
  }

  // By distance from the reference point. Cubic, not power: distance is
  // not a clean decay the way size is. Secondary influences kick in
  // further out — a lake, another urban centre — and put real humps in
  // the curve that a monotonic power fit would flatten away.
  {
    const pts = pointsFor(cmsArea, distanceFor, adjArea);
    const fits = fitsFor(pts, { curve: 'cubic' });
    charts.push(chart({
      title: `Price per ${perUnit} by distance`,
      subtitle: sub(`Measured from ${refName}.`, areaAdj.note, trimSkipNote(cmsArea)),
      points: pts,
      xLabel: distLabel, yLabel: `Price per ${perUnit}${areaAdj.suffix}`,
      yFormat: areaFmt, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits, pts),
      refLines: subjectDistanceRef(),
      stats: distStats(pts, areaAdj.adjusted, areaFmt),
      empty: distEmpty,
    }));
  }

  // ---- Price per lot ---------------------------------------------

  {
    const pts = pointsFor(cmsLot, (r) => r.dateMs, (r) => r.ppl);
    const trend = timeTrend(cmsLot, pts, fmtMoney0);
    charts.push(chart({
      title: 'Price per lot over time',
      subtitle: sub('Prices as sold. One point per sale; larger dots are multi-parcel assemblies.',
        trend.note, trimSkipNote(cmsLot)),
      points: pts, xIsDate: true,
      xLabel: 'Sale date', yLabel: 'Price per lot',
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney,
      fits: trend.fits, legend: legendFor(trend.fits, pts),
      refLines: cmsLot.mc?.median != null ? [{ y: cmsLot.mc.median, label: 'median' }] : [],
      stats: trend.stats,
    }));
  }

  {
    const pts = pointsFor(cmsLot, size, adjLot);
    const fits = fitsFor(pts, { curve: 'power' });
    charts.push(chart({
      title: 'Price per lot by lot size',
      subtitle: sub(lotAdj.note, trimSkipNote(cmsLot)),
      points: pts,
      xLabel: sizeAxisLabel(), yLabel: `Price per lot${lotAdj.suffix}`,
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits, pts),
      refLines: subjectRef(),
      stats: [...sizeStats(pts, lotAdj.adjusted, fmtMoney0), ...powerStat(fits)],
    }));
  }

  {
    const pts = pointsFor(cmsLot, distanceFor, adjLot);
    const fits = fitsFor(pts, { curve: 'cubic' });
    charts.push(chart({
      title: 'Price per lot by distance',
      subtitle: sub(`Measured from ${refName}.`, lotAdj.note, trimSkipNote(cmsLot)),
      points: pts,
      xLabel: distLabel, yLabel: `Price per lot${lotAdj.suffix}`,
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits, pts),
      refLines: subjectDistanceRef(),
      stats: distStats(pts, lotAdj.adjusted, fmtMoney0),
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
  const { refName, distLabel, distEmpty, distStats } = distContext();

  // One comparable set on total price, shared by the over-time caption and
  // the time adjustment, so the two never state different trends.
  const cmsPrice = cmsFor('price');
  const priceAdj = adjusterFor(cmsPrice);
  const adjPrice = priceAdj.adjust;

  const charts = [];

  // Over time. Prices as sold — carrying them to one date is precisely what
  // would flatten the trend this chart exists to show.
  {
    const pts = pointsFor(cmsPrice, (r) => r.dateMs, (r) => r.price);
    const trend = timeTrend(cmsPrice, pts, fmtMoney0);
    charts.push(chart({
      title: 'Total price over time',
      subtitle: sub('Prices as sold. One point per sale; larger dots are multi-parcel assemblies.',
        trend.note, trimSkipNote(cmsPrice)),
      points: pts, xIsDate: true,
      xLabel: 'Sale date', yLabel: 'Total sale price',
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney,
      fits: trend.fits, legend: legendFor(trend.fits, pts),
      refLines: cmsPrice.mc?.median != null ? [{ y: cmsPrice.mc.median, label: 'median' }] : [],
      stats: trend.stats,
    }));
  }

  // By distance. Cubic for the same reason the rate charts use one — a lake
  // or a second town further out puts real humps in the curve.
  {
    const pts = pointsFor(cmsPrice, distanceFor, adjPrice);
    const fits = fitsFor(pts, { curve: 'cubic' });
    charts.push(chart({
      title: 'Total price by distance',
      subtitle: sub(`Measured from ${refName}.`, priceAdj.note, trimSkipNote(cmsPrice)),
      points: pts,
      xLabel: distLabel, yLabel: `Total sale price${priceAdj.suffix}`,
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits, pts),
      refLines: subjectDistanceRef(),
      stats: distStats(pts, priceAdj.adjusted, fmtMoney0),
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
    const pts = pointsFor(cmsPrice, assessedOf, adjPrice);
    const fits = [
      ...fitsFor(pts, { curve: 'none' }),
      { predict: (x) => x, color: INK.muted, dash: '4 3', label: 'Sale = assessed (1:1)' },
    ];
    charts.push(chart({
      title: 'Total price against assessed value',
      subtitle: sub('Points above the 1:1 line sold over their assessment.', priceAdj.note,
        trimSkipNote(cmsPrice)),
      points: pts,
      xLabel: 'Total assessed value', yLabel: `Total sale price${priceAdj.suffix}`,
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisMoney,
      fits, legend: legendFor(fits, pts),
      stats: spreadStats(pts, {
        xName: 'Median assessed',
        xFormat: fmtMoney0,
        adjusted: priceAdj.adjusted,
        yFormat: fmtMoney0,
      }),
      empty: 'No sales in the current filter carry an assessed value to compare against.',
    }));
  }

  return charts;
}

// ---------- table view ---------------------------------------------

/** The measures a tab trims on, for the table's Trimmed column. */
function trimMetricsForTab() {
  return opts.tab === 'total'
    ? [['price', 'Price']]
    : [[areaMetric(), `$/${areaUnitLabel()}`], ['ppl', '$/Lot']];
}

const TABLE_COLS = [
  ['Status', (r) => {
    if (r.excluded) return 'Excluded';
    const trimmedOn = trimMetricsForTab()
      .filter(([m]) => cmsFor(m).stateOf(r) === 'trimmed')
      .map(([, label]) => label);
    return trimmedOn.length ? `Trimmed (${trimmedOn.join(', ')})` : 'In';
  }],
  ['S/A flag', (r) => saleAsmtFlag(r.saleToAsmt) || '—'],
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
  ['Lot frontage (ft)', (r) => (r.lotFrontFt != null ? fmtNum(r.lotFrontFt) : '—')],
  ['$/FF', (r) => (r.ppff != null ? fmtMoney0(r.ppff) : '—')],
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
  for (const rec of drawnRecords()) {
    const tr = document.createElement('tr');
    if (rec.excluded) tr.className = 'is-excluded';
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
  const n = activeRecords().length;
  const nExcluded = data.records.length - n;
  if (!data.meta) {
    els.status.textContent = 'Waiting for the Sales Analysis tab…';
    return;
  }
  // Locale time can itself end in a period ("08:40 a.m."), so the
  // sentence is built to not add a second one.
  const when = receivedAt
    ? new Date(receivedAt).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' })
    : '';
  const sales = `${n} ${n === 1 ? 'sale' : 'sales'}`
    + (nExcluded > 0 ? ` (${nExcluded} excluded)` : '');
  const parcels = data.meta.parcelCount != null ? ` from ${data.meta.parcelCount} parcels` : '';
  els.status.textContent = opts.frozen
    ? `Frozen — ${sales}${parcels}, as of ${when} · filter changes are being ignored.`
    : `Live — ${sales}${parcels} · tracking the Sales Analysis filters · updated ${when}`;
  els.status.classList.toggle('is-frozen', opts.frozen);
}

// ---------- filter waterfall -----------------------------------------

/**
 * How the loaded sales were narrowed to what is fitted, the land template's
 * filter waterfall: the main window's filter steps (only those that removed
 * something), then the sales unticked in the grid, then — per measure on the
 * current tab — the percentile trim.
 */
function renderWaterfall() {
  const wf = data.meta?.waterfall;
  const body = els.waterfallBody;
  body.textContent = '';
  const nAll = data.records.length;
  const nActive = activeRecords().length;

  const rows = [];
  if (wf && Number.isFinite(wf.loaded)) {
    rows.push({ label: 'Sales loaded', value: wf.loaded, kind: 'total' });
    for (const s of wf.steps || []) {
      rows.push({ label: s.label, removed: s.removed, value: s.remaining });
    }
  }
  rows.push({ label: 'After the Sales Analysis filters', value: nAll, kind: 'total' });
  if (nAll !== nActive) {
    rows.push({ label: 'Unticked in the grid', removed: nAll - nActive, value: nActive });
  }
  for (const [metric, label] of trimMetricsForTab()) {
    const cms = cmsFor(metric);
    if (!opts.trim) continue;
    if (cms.applied) {
      // Per measure, not a continuation of the running total above: only the
      // sales that CARRY this measure are trimmed on it, so say how many.
      rows.push({
        label: `${label}: trimmed to ${trimWords()} (of ${cms.trim.n} sales with a ${label})`,
        removed: cms.trim.removed,
        value: cms.fitted.length,
        note: `band ${areaMoneyFmtFor(metric)(cms.trim.qLo)} – ${areaMoneyFmtFor(metric)(cms.trim.qHi)}`,
      });
    } else {
      rows.push({ label: `${label}: trim not applied (fewer than ${TRIM_MIN_SALES} sales)`, value: cms.fitted.length });
    }
  }

  for (const r of rows) {
    const tr = document.createElement('tr');
    if (r.kind === 'total') tr.className = 'is-total';
    const tdLabel = document.createElement('td');
    tdLabel.textContent = r.label;
    const tdRemoved = document.createElement('td');
    tdRemoved.className = 'num';
    tdRemoved.textContent = r.removed != null ? `−${r.removed.toLocaleString('en-US')}` : '';
    const tdValue = document.createElement('td');
    tdValue.className = 'num';
    tdValue.textContent = Number.isFinite(r.value) ? r.value.toLocaleString('en-US') : '';
    const tdNote = document.createElement('td');
    tdNote.className = 'note';
    tdNote.textContent = r.note || '';
    tr.append(tdLabel, tdRemoved, tdValue, tdNote);
    body.appendChild(tr);
  }

  const start = wf && Number.isFinite(wf.loaded) ? wf.loaded : nAll;
  els.waterfallSummary.textContent =
    `Filter waterfall — ${start.toLocaleString('en-US')} loaded → ${nActive.toLocaleString('en-US')} ticked`;
}

/** Money formatter matching a measure, for the trim band. */
function areaMoneyFmtFor(metric) {
  return metric === 'ppsf' ? fmtMoney2 : fmtMoney0;
}

function render() {
  // Every comparable set is rebuilt from the data and options of THIS
  // render; a cached trim from the last one would describe other sales.
  cmsCache = new Map();
  renderStatus();

  const has = data.records.length > 0;
  els.empty.hidden = has;
  els.grid.hidden = !has;
  els.tablePanel.hidden = !has || !opts.showTable;
  els.waterfall.hidden = !has;

  if (!has) {
    els.grid.textContent = '';
    return;
  }
  renderWaterfall();

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

  const unit = UNITS[opts.unit] ? opts.unit : 'acres';
  for (const [key, btn] of [['acres', els.unitAcres], ['sf', els.unitSf], ['ff', els.unitFf]]) {
    btn.setAttribute('aria-checked', String(unit === key));
    btn.classList.toggle('is-on', unit === key);
  }
  els.freeze.checked = opts.frozen;
  els.showTable.checked = opts.showTable;
  els.showExcluded.checked = opts.showExcluded;
  els.trimOn.checked = opts.trim;
  els.trimLo.disabled = !opts.trim;
  els.trimHi.disabled = !opts.trim;
  if (document.activeElement !== els.trimLo) els.trimLo.value = opts.trimLo;
  if (document.activeElement !== els.trimHi) els.trimHi.value = opts.trimHi;
  const bandOk = Number(opts.trimLo) >= 0 && Number(opts.trimHi) <= 100
    && Number(opts.trimLo) < Number(opts.trimHi);
  els.trimHint.textContent = !opts.trim
    ? 'Off — every ticked sale is fitted.'
    : bandOk
      ? `Fits and rates use sales inside the ${trimWords()} of each chart's measure.`
      : 'Band not valid — low must be below high, within 0–100.';
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
els.unitFf.addEventListener('click', () => setOpt({ unit: 'ff' }));
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
els.showExcluded.addEventListener('change', () => setOpt({ showExcluded: els.showExcluded.checked }));
els.trimOn.addEventListener('change', () => setOpt({ trim: els.trimOn.checked }));
// A number, or the old value while the box holds something half-typed.
const pctOr = (v, fallback) => { const n = Number(v); return v !== '' && Number.isFinite(n) ? n : fallback; };
els.trimLo.addEventListener('input', () => setOpt({ trimLo: pctOr(els.trimLo.value, opts.trimLo) }));
els.trimHi.addEventListener('input', () => setOpt({ trimHi: pctOr(els.trimHi.value, opts.trimHi) }));

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
