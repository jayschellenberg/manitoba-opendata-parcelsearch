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
  median, marketConditions, timeAdjust, fitLinear, fitPoly,
  normalizeOverrideRate, topZones, dotRadius, haversineKm, WINNIPEG_CENTRE,
} from '../lib/salesCharts.js';
import {
  drawChart, SERIES_COLORS, OTHER_COLOR, INK,
  fmtMoney0, fmtMoney2, fmtNum, fmtDate, fmtAxisMoney, fmtAxisNum,
} from '../lib/chartRender.js';

export const CHANNEL_NAME = 'mbps-sales-charts';
const OPTS_KEY = 'mbps_charts_opts_v1';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('charts-status'),
  empty: $('charts-empty'),
  grid: $('charts-grid'),
  unitAcres: $('unit-acres'),
  unitSf: $('unit-sf'),
  effDate: $('eff-date'),
  adjMode: $('adj-mode'),
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

const opts = {
  unit: 'acres',
  effDate: new Date().toISOString().slice(0, 10),
  // 'fitted'   — the regression's own dollars-per-day (the R engine's default)
  // 'override' — a judgement percent per year, applied proportionally
  // 'none'     — nominal rates, no adjustment
  adjMode: 'fitted',
  adjRate: 3,
  distRef: 'subject',
  frozen: false,
  showTable: false,
  ...readOpts(),
};

function readOpts() {
  try {
    const raw = localStorage.getItem(OPTS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    // Freeze is deliberately NOT restored: a tab that opens already
    // frozen looks broken — it shows stale numbers and ignores the
    // filters until you find the checkbox.
    const { frozen, ...rest } = parsed;
    return rest;
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

/**
 * Fit the trend lines a chart shows. The cubic is what ggplot draws as
 * `y ~ poly(x,3)`; fitPoly refuses it below 8 points, and when it does
 * the legend must not advertise it either.
 */
function fitsFor(points, { cubic = true } = {}) {
  const xy = points.map((p) => ({ x: p.x, y: p.y }));
  const out = [];
  const lin = fitLinear(xy);
  if (lin) out.push({ ...LINEAR_FIT, predict: lin.predict });
  if (cubic) {
    const cub = fitPoly(xy, 3);
    if (cub) out.push({ ...CUBIC_FIT, predict: cub.predict });
  }
  return out;
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
  return opts.adjMode === 'override' ? normalizeOverrideRate(opts.adjRate) : null;
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
  const on = opts.adjMode !== 'none' && effMs != null;

  if (!on) {
    return {
      adjust: (rec) => rec[metric],
      adjusted: false,
      suffix: '',
      note: 'Nominal rates — no time adjustment applied.',
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

function buildCharts() {
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

  const charts = [];

  // 1 — $/Lot over time. Raw prices; the fitted line IS the trend.
  {
    const pts = pointsFor(records, (r) => r.dateMs, (r) => r.ppl);
    const fits = fitsFor(pts);
    charts.push(drawChart({
      title: 'Price per lot over time',
      subtitle: 'Actual sale prices. One point per sale; larger dots are multi-parcel assemblies.',
      points: pts, xIsDate: true,
      xLabel: 'Sale date', yLabel: 'Price per lot',
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney,
      fits, legend: legendFor(fits),
      refLines: mcLot?.median != null ? [{ y: mcLot.median, label: 'median' }] : [],
      stats: trendStats(pts, mcLot, fmtMoney0),
      tooltipRows,
    }));
  }

  // 2 — $/Acre (or $/SF) over time.
  {
    const pts = pointsFor(records, (r) => r.dateMs, (r) => r[metric]);
    const fits = fitsFor(pts);
    charts.push(drawChart({
      title: `Price per ${unit.toLowerCase()} over time`,
      subtitle: 'Actual rates. Sales whose parcels have incomplete acreage are excluded.',
      points: pts, xIsDate: true,
      xLabel: 'Sale date', yLabel: `Price per ${unit.toLowerCase()}`,
      yFormat: areaFmt, yAxisFormat: fmtAxisMoney,
      fits, legend: legendFor(fits),
      refLines: mcArea?.median != null ? [{ y: mcArea.median, label: 'median' }] : [],
      stats: trendStats(pts, mcArea, areaFmt),
      tooltipRows,
    }));
  }

  // 3 — $/Lot by lot size, time-adjusted.
  {
    const pts = pointsFor(records, size, adjLot);
    const fits = fitsFor(pts);
    charts.push(drawChart({
      title: 'Price per lot by lot size',
      subtitle: lotAdj.note,
      points: pts,
      xLabel: sizeAxisLabel(), yLabel: `Price per lot${lotAdj.suffix}`,
      yFormat: fmtMoney0, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits),
      refLines: subjectRef(),
      stats: sizeStats(pts, lotAdj.adjusted, fmtMoney0),
      tooltipRows,
    }));
  }

  // 4 — $/Acre (or $/SF) by lot size, time-adjusted.
  {
    const pts = pointsFor(records, size, adjArea);
    const fits = fitsFor(pts);
    charts.push(drawChart({
      title: `Price per ${unit.toLowerCase()} by lot size`,
      subtitle: areaAdj.note,
      points: pts,
      xLabel: sizeAxisLabel(), yLabel: `Price per ${unit.toLowerCase()}${areaAdj.suffix}`,
      yFormat: areaFmt, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits),
      refLines: subjectRef(),
      stats: sizeStats(pts, areaAdj.adjusted, areaFmt),
      tooltipRows,
    }));
  }

  // 5 — the same by-size view split by zoning. Colour is the variable
  // here, so this chart drops the cubic: its orange would collide with
  // a zone's hue, and the question being asked is "do these zones price
  // differently", not "is the size curve bent".
  {
    const zones = topZones(records, SERIES_COLORS.length);
    const colorByZone = new Map(zones.map((z, i) => [z.key, SERIES_COLORS[i]]));
    const pts = pointsFor(records, size, adjArea,
      (r) => colorByZone.get(String(r.zone || '').trim()) || OTHER_COLOR);
    const fits = fitsFor(pts, { cubic: false });
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

  // 6 — $/Acre (or $/SF) against distance from the reference point.
  {
    const ref = activeDistRef();
    const refName = ref === 'subject' ? 'the subject parcel' : 'Portage & Main';
    const pts = pointsFor(records, distanceFor, adjArea);
    const fits = fitsFor(pts);
    charts.push(drawChart({
      title: `Price per ${unit.toLowerCase()} by distance`,
      subtitle: `Measured from ${refName}. ${areaAdj.note}`,
      points: pts,
      xLabel: `Distance from ${ref === 'subject' ? 'subject' : 'Winnipeg'} (km)`,
      yLabel: `Price per ${unit.toLowerCase()}${areaAdj.suffix}`,
      yFormat: areaFmt, yAxisFormat: fmtAxisMoney, xAxisFormat: fmtAxisNum,
      fits, legend: legendFor(fits),
      stats: spreadStats(pts, {
        xName: 'Median distance',
        xFormat: (v) => `${fmtNum(v)} km`,
        adjusted: areaAdj.adjusted,
        yFormat: areaFmt,
      }),
      tooltipRows,
      empty: ref === 'subject'
        ? 'No subject distance available. Set a subject roll in the main window, or measure from Winnipeg.'
        : 'No sales in the current filter have usable parcel geometry to measure from.',
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
  els.unitAcres.setAttribute('aria-checked', String(isAcres()));
  els.unitSf.setAttribute('aria-checked', String(!isAcres()));
  els.unitAcres.classList.toggle('is-on', isAcres());
  els.unitSf.classList.toggle('is-on', !isAcres());
  els.effDate.value = opts.effDate;
  els.freeze.checked = opts.frozen;
  els.showTable.checked = opts.showTable;

  els.adjMode.value = opts.adjMode;
  els.adjRate.hidden = opts.adjMode !== 'override';
  els.adjRate.value = opts.adjRate;
  // The effective date only means something once something is being
  // carried TO it.
  els.effDate.disabled = opts.adjMode === 'none';
  els.adjHint.textContent = opts.adjMode === 'override'
    ? 'Percent per year, applied proportionally. "5" and "0.05" both mean 5%.'
    : opts.adjMode === 'none'
      ? 'Charts show nominal rates as sold.'
      : 'Dollars per day, measured from the sales on screen.';

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

els.unitAcres.addEventListener('click', () => setOpt({ unit: 'acres' }));
els.unitSf.addEventListener('click', () => setOpt({ unit: 'sf' }));
els.effDate.addEventListener('change', () => setOpt({ effDate: els.effDate.value }));
els.adjMode.addEventListener('change', () => setOpt({ adjMode: els.adjMode.value }));
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
