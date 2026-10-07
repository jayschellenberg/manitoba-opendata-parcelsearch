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
  normalizeOverrideRate, topZones, haversineKm, WINNIPEG_CENTRE,
  percentileTrim, saleAsmtFlag, TRIM_MIN_SALES, SALE_ASMT_TIERS, COVER_KEYS,
} from '../lib/salesCharts.js';
import {
  saleWaterFacts, boxStats, waterPremium, pairedSales, WATER_GROUPS,
} from '../lib/salesWater.js';
import { WATER_CLASSES, WATER_DETECTION_LIMIT_FT } from '../lib/water.js';
import { priceBuckets, yearColors, SIZE_RAMP } from '../lib/salesMapColors.js';
import { createSalesMap, linkMaps } from './chartMap.js';
import { criteriaText } from '../lib/criteriaLine.js';
import { masccolor } from '../masc.js';
import { buildStoreZip } from '../lib/zipStore.js';
import {
  agConsSpec as libAgConsSpec, agConsActive as libAgConsActive, agConsistent as libAgConsistent, agConsWords as libAgConsWords,
} from '../lib/agConsistency.js';
import {
  TAG_LISTS, TAG_LIST_NAMES, COMP_TAGS_KEY, EXCL_REASONS_KEY, EXCLUSION_REASONS, normalizeReasons, normalizeTags, saleTagKey, toggleTag, removeTag, moveTag, clearTags,
  tagNumber, tagLabel, tagDescriptions,
} from '../lib/compTags.js';
import { toCsv, buildSummaryHtml, figureFileName, workFileName } from '../lib/workFile.js';
import { LAND_COVER_BUCKETS } from '../lib/landcover.js';
import {
  drawChart, drawBoxChart, drawTableCard, drawStackedBars, drawHistogram, setChartCompany, ZONE_COLORS, OTHER_COLOR, INK, R_STYLE, slugify,
  chartExportSpec, renderChartPng, downloadBlob, setPointLabeler,
  fmtMoney0, fmtMoney2, fmtNum, fmtDate, fmtAxisDollar, fmtAxisComma, fmtMonYear,
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
  tabWater: $('tab-water'),
  tabNote: $('tab-note'),
  company: $('company'),
  tabAg: $('tab-ag'),
  ctlMapColor: $('ctl-mapcolor'),
  mapMunis: $('map-munis'),
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
  workfileOpen: $('workfile-open'),
  compsPanel: $('comps-panel'),
  exclPanel: $('excl-panel'),
  exclSummary: $('excl-summary'),
  exclBody: $('excl-body'),
  compsSummary: $('comps-summary'),
  compsBody: $('comps-body'),
  workfileDialog: $('workfile-dialog'),
  workfileList: $('workfile-list'),
  workfileStatus: $('workfile-status'),
  workfileGo: $('workfile-go'),
  table: $('sales-table'),
};

/**
 * Comparable tags (charts Phase 2, Jason 2026-10-06): the numbered comps and
 * Land Sets 1 and 2, keyed on rolls + sale date (see lib/compTags.js). Kept
 * in this browser, and shared live with any other charts tab through the
 * storage event.
 */
const TAGS_KEY = COMP_TAGS_KEY;
function readTags() {
  try { return normalizeTags(JSON.parse(localStorage.getItem(TAGS_KEY) || 'null')); } catch { return normalizeTags(null); }
}
let tags = readTags();
function saveTags(next) {
  tags = next;
  try { localStorage.setItem(TAGS_KEY, JSON.stringify(tags)); } catch { /* private mode */ }
  render();
}
/** Add a sale to a tag list, or take it off. */
function toggleSaleTag(rec, list) {
  const key = saleTagKey(rec);
  if (key) saveTags(toggleTag(tags, list, key, rec));
}
// An opened job rewrites this page's settings from the main window.
window.addEventListener('storage', (e) => {
  if (e.key !== OPTS_KEY) return;
  Object.assign(opts, readOpts());
  syncControls();
  render();
});

window.addEventListener('storage', (e) => {
  if (e.key !== TAGS_KEY) return;
  tags = readTags();
  render();
});

/**
 * Exclusion reasons (charts Phase 3, Jason 2026-10-06): why a sale was
 * unticked, as the R template's Excluded Records card records it
 * ("127900|Nominal transfer"). Keyed like the comp tags — rolls + sale date —
 * because MAO renumbers sale ids. A reason outlives a re-tick, so excluding
 * the same sale again brings it back.
 */
const REASONS_KEY = EXCL_REASONS_KEY;
function readReasons() {
  try { return normalizeReasons(JSON.parse(localStorage.getItem(REASONS_KEY) || 'null')); } catch { return {}; }
}
let reasons = readReasons();
function setReason(key, text) {
  const t = String(text ?? '').trim().slice(0, 200);
  reasons = { ...reasons };
  if (t) reasons[key] = t; else delete reasons[key];
  try { localStorage.setItem(REASONS_KEY, JSON.stringify(reasons)); } catch { /* private mode */ }
}
const reasonOf = (rec) => reasons[saleTagKey(rec)] || '';
// The sale just excluded from a chart or map: the panel opens on it, with
// its reason box focused, on the render that shows it unticked.
let reasonPromptKey = null;
window.addEventListener('storage', (e) => {
  if (e.key !== REASONS_KEY) return;
  reasons = readReasons();
  render();
});

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
  // The Agricultural page's consistency filters (R's CMSAG1, 2026-10-07):
  // a cultivated-% band and keep-lists for MASC, CLI class and dominant
  // cover. Empty = no filter. See agConsistent().
  agCons: { cultLo: '', cultHi: '', masc: [], cli: [], cover: [] },
  // Municipal boundaries on every map.
  mapMunis: true,
  // The company name that signs every chart caption and PNG (Jason,
  // 2026-09-23). Persisted with the rest of opts, so it is typed once.
  company: '',
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
      // A job file pins its effective date (effDatePinned, written by the
      // main window's Open job, 2026-10-07): a reopened assignment is about
      // its own date, so that one IS restored.
      const { frozen, effDate, ...rest } = parsed;
      return parsed.effDatePinned && effDate ? { ...rest, effDate } : rest;
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
  // `perUnit` is the Title-Case unit in chart titles ("Price per Acre"),
  // `axis` the template's x-axis title, `range` the unit in the criteria line.
  acres: {
    metric: 'ppa', size: 'lotAcres', short: 'Acre', perUnit: 'Acre', range: 'acres',
    axis: 'Parcel Size (Acres)', sizeTitle: 'Lot Size (Acres)', sizeText: (v) => `${fmtNum(v)} ac`, money: fmtMoney0,
    subjectSize: (s) => (Number(s?.acres) > 0 ? Number(s.acres) : null),
  },
  sf: {
    metric: 'ppsf', size: 'lotSf', short: 'SF', perUnit: 'SF', range: 'sq ft',
    axis: 'Parcel Size (Sq Ft)', sizeTitle: 'Lot Size (Sq Ft)', sizeText: (v) => `${fmtNum(v)} sf`, money: fmtMoney2,
    subjectSize: (s) => (Number(s?.acres) > 0 ? Number(s.acres) * 43560 : null),
  },
  ff: {
    metric: 'ppff', size: 'lotFrontFt', short: 'FF', perUnit: 'Front Foot', range: 'ft frontage',
    axis: 'Lot Frontage (Feet)', sizeTitle: 'Lot Frontage (Feet)', sizeText: (v) => `${fmtNum(v)} ft`, money: fmtMoney0,
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

/** What the review flag's ratio was measured against — bare-land sales are
 *  graded against today's LAND assessment, since the lot may since have
 *  been built on (see saleRecordsFromRows). */
const flagBasisWords = (rec) => (rec.flagBasis === 'land' ? 'vs land' : 'vs total');

/** Tooltip rows, shared by every chart. Values lead, labels follow. */
function tooltipRows(rec, pt) {
  if (!rec) return [];
  const rows = [];
  // What the dot IS comes first: a pale or hollow dot is otherwise a
  // question the reader has to answer from the legend.
  const state = pt?.state || (rec.excluded ? 'excluded' : 'in');
  if (state === 'excluded') rows.push(['Unticked in the grid', 'Excluded']);
  else if (state === 'trimmed') rows.push([`Outside ${opts.trimLo}th–${opts.trimHi}th pctl`, 'Trimmed']);
  const flag = saleAsmtFlag(rec.flagRatio);
  if (flag && flag !== 'No assessment') {
    rows.push([`Sale/Asmt flag (${flagBasisWords(rec)})`, `${flag} (${rec.flagRatio.toFixed(2)})`]);
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
  if (opts.tab === 'ag' && rec.ag) {
    if (rec.ag.masc) rows.push(['MASC', rec.ag.masc]);
    if (rec.ag.cli) rows.push(['CLI', rec.ag.cli]);
    if (rec.ag.soil) rows.push(['Soil', rec.ag.soil]);
    if (rec.ag.cover) rows.push(['Cultivated', `${Math.round(rec.ag.cover.cult * 100)}%`]);
    if (rec.ag.coverLabel) rows.push(['Cover', rec.ag.coverLabel]);
  }
  if (opts.tab === 'water' || (opts.tab === 'rates' && subTab('rates', 'map') === 'Water Influence')) {
    const w = waterOf(rec);
    if (w.group) rows.push(['Water', w.cls && w.cls !== w.group ? `${w.group} · ${w.cls}` : w.group]);
    if (w.body) rows.push(['Water body', w.body]);
    if (w.distFt != null) rows.push(['To water', `${fmtNum(w.distFt)} ft`]);
    if (w.flood) rows.push(['Flood', w.flood]);
  }
  const who = rec.address || (rec.rolls || []).join(', ');
  if (who) rows.push([rec.muni || 'Parcel', who]);
  if (rec.excluded && reasonOf(rec)) rows.unshift(['Excluded', reasonOf(rec)]);
  const tagged = tagDescriptions(tags, saleTagKey(rec));
  if (tagged.length) rows.unshift(['Tagged', tagged.join(' · ')]);
  if (!opts.frozen && rec.keys?.length) {
    rows.push(['', `${state === 'excluded' ? 'Click to include' : 'Click to exclude'} · Shift-click to ${
      tagNumber(tags, 'comps', saleTagKey(rec)) ? 'untag the comp' : 'tag as a comp'}`]);
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
// ---------- Ag consistency filters (R's CMSAG1, 2026-10-07) -------------
//
// The land template's consistency filters in its "rate" mode: on the
// Agricultural page only, a cultivated-% band and keep-lists for MASC rating,
// CLI class and dominant land cover narrow the set that page fits — its own
// trend and its own time-adjustment rate — while every other page keeps the
// wide set. (R's "both" mode, narrowing everything, is what the main window's
// MASC / CLI / cultivation filters already do.) As in R, a sale with no value
// for an attribute is KEPT: it was never measured, so it has not failed.

function agConsSpec() { return libAgConsSpec(opts.agCons); }
function agConsActive() { return libAgConsActive(agConsSpec()); }
/** True when a sale passes every set filter (unknown values pass). */
function agConsistent(rec) { return libAgConsistent(rec, agConsSpec(), { mascOf: mascKey, unrated: UNRATED }); }
function agConsWords() { return libAgConsWords(agConsSpec()); }

let cmsCache = new Map();
function cmsFor(metric) {
  // The Agricultural page fits its own, consistency-filtered set.
  const ag = opts.tab === 'ag' && agConsActive();
  const cacheKey = ag ? `${metric}|ag` : metric;
  if (cmsCache.has(cacheKey)) return cmsCache.get(cacheKey);
  const ticked = activeRecords();
  const active = ag ? ticked.filter(agConsistent) : ticked;
  const agOut = ag ? new Set(ticked.filter((r) => !agConsistent(r)).map((r) => r.saleId)) : null;
  const trim = opts.trim ? percentileTrim(active, metric, opts.trimLo, opts.trimHi) : null;
  const applied = !!trim?.applied;
  const fitted = applied ? active.filter((r) => trim.keep.has(r.saleId)) : active;
  const mc1 = marketConditions(active, metric);
  const mc = applied ? marketConditions(fitted, metric) : mc1;
  const fittedIds = new Set(fitted.map((r) => r.saleId));
  const cms = {
    metric, active, fitted, mc, mc1, trim, applied,
    // The Ag set's bookkeeping: how many ticked sales the filters left out,
    // and the rate on every ticked sale for comparison.
    ag: ag ? { out: agOut.size, ticked: ticked.length, mcWide: marketConditions(ticked, metric), words: agConsWords() } : null,
    stateOf: (rec) => {
      if (rec.excluded) return 'excluded';
      // Drawn hollow like a trimmed sale: present, but fitted by nothing.
      if (agOut?.has(rec.saleId)) return 'trimmed';
      if (applied && !fittedIds.has(rec.saleId)) return 'trimmed';
      return 'in';
    },
  };
  cmsCache.set(cacheKey, cms);
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
    const agOn = opts.tab === 'ag' && agConsActive();
    const label = agOn && opts.trim ? `Outside the Ag filters or ${trimWords()}`
      : agOn ? 'Outside the Ag consistency filters'
        : `Trimmed (outside ${trimWords()})`;
    out.push({ label, dot: 'hollow', color: R_STYLE.pointStroke });
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
/**
 * The "Restore N unticked sales" link under a chart: re-tick exactly those
 * sales in the grid, in one message. Off while frozen, like a dot click.
 */
function restoreSales(recs) {
  if (opts.frozen) return;
  const keys = (recs || []).flatMap((r) => r.keys || []);
  if (keys.length) channel.postMessage({ type: 'set-excluded', keys, excluded: false });
}

function onPointClick(rec, pt, e) {
  // Shift-click tags the sale as the next comparable (or untags it).
  if (e?.shiftKey) { toggleSaleTag(rec, 'comps'); return; }
  if (opts.frozen || !rec?.keys?.length) return;
  if (!rec.excluded) reasonPromptKey = saleTagKey(rec);
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
    // Title-case, as the template names it: "…by Distance from Winnipeg".
    refTitle: ref === 'subject' ? 'Subject' : 'Winnipeg',
    distLabel: `Distance from ${ref === 'subject' ? 'Subject' : 'Winnipeg'} (km)`,
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

/** Each page's chart builder. */
const PAGE_BUILDERS = {
  rates: () => buildRateCharts(),
  ag: () => buildAgCharts(),
  total: () => buildTotalCharts(),
  water: () => buildWaterCharts(),
};
const pageOf = (tab) => (PAGE_BUILDERS[tab] ? tab : 'rates');

/**
 * Run `fn` in the unit a page draws in. Front feet means nothing for
 * farmland — almost no farm roll states a frontage — and left on it the
 * whole Agricultural page went empty with messages that blamed the MASC and
 * land-cover data instead (Jason, 2026-09-23). That page draws per acre; the
 * unit control keeps its setting for the others, and the note under the
 * tabs says what happened.
 */
function withPageUnit(page, fn) {
  if (page !== 'ag' || opts.unit !== 'ff') return fn();
  opts.unit = 'acres';
  try { return fn(); } finally { opts.unit = 'ff'; }
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
    const flag = saleAsmtFlag(rec.flagRatio);
    // One dot size for every sale, as in the R template (symbolSize 9):
    // it does not size assemblies up. Colour only on the zoning chart,
    // which also takes the template's darker edge and heavier alpha.
    out.push({
      x, y, rec,
      ...(colorOf
        ? { color: colorOf(rec), stroke: R_STYLE.zoneStroke, opacity: R_STYLE.zoneOpacity }
        : {}),
      state: cms.stateOf(rec),
      flagged: flag !== '' && flag !== 'No assessment',
    });
  }
  return out;
}

/** The points the fits and stats are taken over. */
const inOnly = (pts) => pts.filter((p) => p.state === 'in');

// The template's trend lines: linear black solid, cubic red4 dashed, power
// darkorchid dotted — all width 2.
const LINEAR_FIT = { color: R_STYLE.linear, label: 'Linear trend' };
const CUBIC_FIT = { color: R_STYLE.cubic, dash: '6 4', label: 'Cubic trend' };
const POWER_FIT = { color: R_STYLE.power, dash: '1 4', label: 'Power trend' };

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
  }
  if (cms.applied && pctWords(cms.mc1)) {
    stats.push({
      label: cms.ag ? 'Per year (Ag set)' : 'Per year (all)',
      value: pctWords(cms.mc1),
      title: `The same regression on all ${cms.active.length} ${cms.ag ? 'Ag-set' : 'ticked'} sales, before the trim.`,
    });
  }
  if (cms.ag && pctWords(cms.ag.mcWide)) {
    stats.push({
      label: 'Per year (all ticked)',
      value: pctWords(cms.ag.mcWide),
      title: `The same regression on all ${cms.ag.ticked} ticked sales, before the Ag consistency filters (${cms.ag.words}).`,
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

const STATED_FIT = { color: R_STYLE.linear };

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
 * data still decided.
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
    color: R_STYLE.subject,
  }];
}

/**
 * A subject line at `x` on any other scatter — cultivated share, distance to
 * water, assessed value (Jason, 2026-09-23: the subject on every chart where
 * it has a value). Empty when there is no subject or the value is unknown.
 */
function subjectAt(x) {
  const n = Number(x);
  if (!data.meta?.subject || x == null || !Number.isFinite(n)) return [];
  return [{ x: n, label: 'Subject', color: R_STYLE.subject }];
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
  return [{ x: km, label: 'Subject', color: R_STYLE.subject }];
}

/**
 * A per-day money rate, unsigned (callers add the sign), to four decimals
 * (Jason, 2026-09-23): "$0.9512", "$23.4500".
 *
 * The one exception: a $/SF trend can be ~$0.00004 a day, which four
 * decimals would print as "$0.0000" — a real rate reported as none — so a
 * value that small keeps two significant digits instead.
 */
function fmtRate(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '$0';
  if (a >= 0.0001) return `$${a.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
  const dp = Math.min(8, -Math.floor(Math.log10(a)) + 1);
  return `$${a.toFixed(dp)}`;
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
    onRestore: opts.frozen ? null : restoreSales,
    pngName: pngName(spec.title),
    ...spec,
  });
}

/** What "total price" means, said on the Total price tab and in its charts' notes. */
const TOTAL_PRICE_NOTE = 'Total price is the whole consideration: a multi-parcel sale is one point at its full price, not split across its lots.';

/** Join note fragments, skipping the empty ones. */
const sub = (...parts) => parts.filter(Boolean).join(' ');

/** "12" / "0.35" — a range end, at the precision the value needs. */
const rangeNum = (v) => v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 2 : 0 });

/**
 * The template's criteria subtitle (land_subtitles):
 *   "CMS; 0-35 km from Subject; 1-10 acres; Jan-2021 to Sep-2026"
 * with "CMS (Time-Adjusted)" on the charts that carry rates to the effective
 * date. Each part states the Sales Analysis filter setting where one is set
 * (Jason, 2026-09-22), and the span of the fitted sales where the filter is
 * left open — see lib/criteriaLine.js.
 */
function criteriaLine(cms, adjusted) {
  return baseCriteriaLine(cms, adjusted) + (cms.ag ? `; Ag: ${cms.ag.words}` : '');
}
function baseCriteriaLine(cms, adjusted) {
  const recs = cms.fitted;
  const span = (vals) => {
    const v = vals.filter((x) => Number.isFinite(x));
    return v.length ? [Math.min(...v), Math.max(...v)] : null;
  };
  return criteriaText({
    adjusted,
    criteria: data.meta?.criteria || null,
    unitKey: UNITS[opts.unit] ? opts.unit : 'acres',
    unitWord: unitSpec().range,
    refTitle: distContext().refTitle,
    refIsSubject: activeDistRef() === 'subject',
    span: {
      dist: span(recs.map(distanceFor)),
      size: span(recs.map((r) => r[sizeField()])),
      date: span(recs.map((r) => r.dateMs)),
    },
    fmtMonYear,
    fmtNum: rangeNum,
  });
}

/** The y-axis tick formatter for a measure: full dollars, cents on $/SF. */
const axisDollar = fmtAxisDollar;

function buildRateCharts() {
  const records = activeRecords();
  const metric = areaMetric();
  const areaFmt = areaMoneyFmt();
  // The unit as the template's titles name it: "Price per Acre".
  const perUnit = unitSpec().perUnit;

  // One comparable set per measure — CMS1, and CMS2 when the trim is on —
  // reused by the over-time chart's caption and by every time-adjusted
  // chart of that measure, so the two never disagree.
  const cmsArea = cmsFor(metric);
  const areaAdj = adjusterFor(cmsArea);
  const adjArea = areaAdj.adjust;
  const size = (rec) => rec[sizeField()];
  // Front feet is the one unit a large share of sales cannot carry, so an
  // empty chart has to say why rather than look broken.
  const unitEmpty = opts.unit === 'ff'
    ? 'No sales in the current filter carry a $/front foot. Every parcel in a sale must state '
      + 'a frontage on the roll; most rural parcels state an area instead.'
    : undefined;
  // "Adjusted Price per Acre", as the template labels a time-adjusted axis.
  const yAdj = (adj, what) => (adj.adjusted ? `Adjusted ${what}` : what);

  const { refName, refTitle, distLabel, distEmpty, distStats } = distContext();

  // Charts are grouped by RATE, not by question: every price-per-area
  // chart first, then every price-per-lot chart. Reading down a column
  // of one rate and then the other is how the comparison actually gets
  // made — interleaving them means re-reading the axis label on each
  // card to work out which rate you are looking at.
  const charts = [];

  // ---- Price per acre (or per SF / front foot) --------------------

  // Over time. Raw rates; the fitted line IS the trend, and a cubic is
  // legitimate here because multi-year turns in the market do happen.
  {
    const pts = pointsFor(cmsArea, (r) => r.dateMs, (r) => r[metric]);
    const trend = timeTrend(cmsArea, pts, areaFmt);
    charts.push(chart({
      title: `Land Price per ${perUnit} Over Time`,
      subtitle: criteriaLine(cmsArea, false),
      note: sub('Rates as sold — the Nominal/Time-adjusted toggle does not apply here.',
        trend.note, trimSkipNote(cmsArea)),
      points: pts, xIsDate: true,
      xLabel: 'Sale Date', yLabel: `Price per ${perUnit}`,
      yFormat: areaFmt, yAxisFormat: axisDollar,
      fits: trend.fits, legend: legendFor(trend.fits, pts),
      stats: trend.stats,
      empty: unitEmpty,
    }));
  }

  // By lot size. Power curve, not cubic — see fitPower.
  {
    const pts = pointsFor(cmsArea, size, adjArea);
    const fits = fitsFor(pts, { curve: 'power' });
    charts.push(chart({
      title: `Price per ${perUnit} by Size`,
      subtitle: criteriaLine(cmsArea, areaAdj.adjusted),
      note: sub(areaAdj.note, trimSkipNote(cmsArea)),
      points: pts,
      xLabel: sizeAxisLabel(), yLabel: yAdj(areaAdj, `Price per ${perUnit}`),
      yFormat: areaFmt, yAxisFormat: axisDollar, xAxisFormat: fmtAxisComma,
      fits, legend: legendFor(fits, pts),
      refLines: subjectRef(),
      stats: [...sizeStats(pts, areaAdj.adjusted, areaFmt), ...powerStat(fits)],
      empty: unitEmpty,
    }));
  }

  // The same by-size view split by zoning, in the template's Set2 palette
  // over its top eight zones. Colour is the variable here, so this chart
  // keeps only the straight line: a curve's hue would collide with a
  // zone's, and the question is "do these zones price differently".
  {
    const zones = topZones(records, ZONE_COLORS.length);
    const colorByZone = new Map(zones.map((z, i) => [z.key, ZONE_COLORS[i]]));
    const pts = pointsFor(cmsArea, size, adjArea,
      (r) => colorByZone.get(String(r.zone || '').trim()) || OTHER_COLOR);
    const fits = fitsFor(pts, { curve: 'none' });
    const zoneKeys = new Set(colorByZone.keys());
    const hasOther = records.some((r) => !zoneKeys.has(String(r.zone || '').trim()));
    const legend = [
      ...zones.map((z) => ({ label: `${z.key} (${z.count})`, color: colorByZone.get(z.key), dot: 'swatch' })),
      ...(hasOther ? [{ label: 'Other', color: OTHER_COLOR, dot: 'swatch' }] : []),
      ...fits.map((f) => ({ label: f.label, color: f.color, dash: !!f.dash })),
      ...stateLegend(pts),
    ];
    charts.push(chart({
      title: `Price per ${perUnit} by Size and Zoning`,
      subtitle: criteriaLine(cmsArea, areaAdj.adjusted),
      note: sub(areaAdj.note, `The ${ZONE_COLORS.length} most common zones are coloured; the rest fold into Other.`,
        trimSkipNote(cmsArea)),
      points: pts,
      xLabel: sizeAxisLabel(), yLabel: yAdj(areaAdj, `Price per ${perUnit}`),
      yFormat: areaFmt, yAxisFormat: axisDollar, xAxisFormat: fmtAxisComma,
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
      title: `Price per ${perUnit} by Distance from ${refTitle}`,
      subtitle: criteriaLine(cmsArea, areaAdj.adjusted),
      note: sub(`Measured from ${refName}.`, areaAdj.note, trimSkipNote(cmsArea)),
      points: pts,
      xLabel: distLabel, yLabel: yAdj(areaAdj, `Price per ${perUnit}`),
      yFormat: areaFmt, yAxisFormat: axisDollar, xAxisFormat: fmtAxisComma,
      fits, legend: legendFor(fits, pts),
      refLines: subjectDistanceRef(),
      stats: distStats(pts, areaAdj.adjusted, areaFmt),
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
 * No TOTAL-price-by-size chart, deliberately (Jason, 2026-08-18): MAO carries
 * no size for rural residential sales, so the x-axis would be empty for
 * exactly the population this tab exists to serve. The price-per-LOT charts
 * moved here from Land rates on 2026-09-23 (Jason), by-size one included —
 * a lot price is a whole-lot consideration, which is this tab's subject.
 *
 * This set does NOT filter to residential land-and-building. It plots whatever
 * the main window's filters are showing, the same records the rates tab gets —
 * sale type is already selectable at load time and through the Primary
 * Property filter, and a tab that silently re-filtered would disagree with the
 * table view sitting underneath it.
 */
/**
 * The Total/Per Lot tab's price-per-lot heatmap (Jason, 2026-10-06):
 * quintiles of the per-lot price, time-adjusted when the page is.
 */
function buildPplMap() {
  const cms = cmsFor('ppl');
  const adj = adjusterFor(cms);
  const recs = activeRecords().filter(located);
  const priced = recs.filter((r) => Number.isFinite(adj.adjust(r)) && adj.adjust(r) > 0);
  const b = priceBuckets(priced.map(adj.adjust), fmtMoney0);
  const missing = recs.length - priced.length;
  return paintMap('ppl', {
    title: 'CMS Heatmap – Price per Lot',
    cms,
    adj,
    colored: priced,
    context: recs.filter((r) => !priced.includes(r)),
    colorOf: (r) => (b ? b.colorOf(adj.adjust(r)) : R_STYLE.pointFill),
    legend: [...(b ? b.legend : []), ...(missing ? [{ label: `No price per lot (${missing})`, color: '#c8c8c8' }] : [])],
    note: sub(`Quintiles of ${adj.adjusted ? 'adjusted ' : ''}price per lot (the price divided by the parcels in the sale); `
      + 'each colour holds about a fifth of the sales.', adj.note),
  });
}

function buildTotalCharts() {
  const { refName, refTitle, distLabel, distEmpty, distStats } = distContext();

  // One comparable set on total price, shared by the over-time caption and
  // the time adjustment, so the two never state different trends.
  const cmsPrice = cmsFor('price');
  const priceAdj = adjusterFor(cmsPrice);
  const adjPrice = priceAdj.adjust;
  const yAdj = (adj, what) => (adj.adjusted ? `Adjusted ${what}` : what);

  const charts = [];

  // Over time. Prices as sold — carrying them to one date is precisely what
  // would flatten the trend this chart exists to show.
  {
    const pts = pointsFor(cmsPrice, (r) => r.dateMs, (r) => r.price);
    const trend = timeTrend(cmsPrice, pts, fmtMoney0);
    charts.push(chart({
      title: 'Total Price Over Time',
      subtitle: criteriaLine(cmsPrice, false),
      note: sub('Prices as sold.', TOTAL_PRICE_NOTE, trend.note, trimSkipNote(cmsPrice)),
      points: pts, xIsDate: true,
      xLabel: 'Sale Date', yLabel: 'Sale Price',
      yFormat: fmtMoney0, yAxisFormat: axisDollar,
      fits: trend.fits, legend: legendFor(trend.fits, pts),
      stats: trend.stats,
    }));
  }

  // By distance. Cubic for the same reason the rate charts use one — a lake
  // or a second town further out puts real humps in the curve.
  {
    const pts = pointsFor(cmsPrice, distanceFor, adjPrice);
    const fits = fitsFor(pts, { curve: 'cubic' });
    charts.push(chart({
      title: `Total Price by Distance from ${refTitle}`,
      subtitle: criteriaLine(cmsPrice, priceAdj.adjusted),
      note: sub(`Measured from ${refName}.`, TOTAL_PRICE_NOTE, priceAdj.note, trimSkipNote(cmsPrice)),
      points: pts,
      xLabel: distLabel, yLabel: yAdj(priceAdj, 'Sale Price'),
      yFormat: fmtMoney0, yAxisFormat: axisDollar, xAxisFormat: fmtAxisComma,
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
      title: 'Total Price vs Assessed Value',
      subtitle: criteriaLine(cmsPrice, priceAdj.adjusted),
      note: sub('Points above the 1:1 line sold over their assessment.', priceAdj.note,
        trimSkipNote(cmsPrice)),
      points: pts,
      xLabel: 'Total Assessed Value', yLabel: yAdj(priceAdj, 'Sale Price'),
      yFormat: fmtMoney0, yAxisFormat: axisDollar, xAxisFormat: axisDollar,
      fits, legend: legendFor(fits, pts),
      refLines: subjectAt(data.meta?.subject?.asmtTotal),
      stats: spreadStats(pts, {
        xName: 'Median assessed',
        xFormat: fmtMoney0,
        adjusted: priceAdj.adjusted,
        yFormat: fmtMoney0,
      }),
      empty: 'No sales in the current filter carry an assessed value to compare against.',
    }));
  }

  // ---- Price per lot (moved here from Land rates, Jason 2026-09-23) --
  // A lot price is a whole-lot consideration, which is what this tab is about.
  const cmsLot = cmsFor('ppl');
  const lotAdj = adjusterFor(cmsLot);
  const adjLot = lotAdj.adjust;
  const size = (rec) => rec[sizeField()];

  {
    const pts = pointsFor(cmsLot, (r) => r.dateMs, (r) => r.ppl);
    const trend = timeTrend(cmsLot, pts, fmtMoney0);
    charts.push(chart({
      title: 'Land Price per Lot Over Time',
      subtitle: criteriaLine(cmsLot, false),
      note: sub('Prices as sold. Price per lot = the sale price divided by the parcels in the sale; a single-parcel sale is the same as its total.',
        trend.note, trimSkipNote(cmsLot)),
      points: pts, xIsDate: true,
      xLabel: 'Sale Date', yLabel: 'Price per Lot',
      yFormat: fmtMoney0, yAxisFormat: axisDollar,
      fits: trend.fits, legend: legendFor(trend.fits, pts),
      stats: trend.stats,
    }));
  }

  {
    const pts = pointsFor(cmsLot, size, adjLot);
    const fits = fitsFor(pts, { curve: 'power' });
    charts.push(chart({
      title: 'Price per Lot by Size',
      subtitle: criteriaLine(cmsLot, lotAdj.adjusted),
      note: sub(lotAdj.note, trimSkipNote(cmsLot)),
      points: pts,
      xLabel: sizeAxisLabel(), yLabel: yAdj(lotAdj, 'Price per Lot'),
      yFormat: fmtMoney0, yAxisFormat: axisDollar, xAxisFormat: fmtAxisComma,
      fits, legend: legendFor(fits, pts),
      refLines: subjectRef(),
      stats: [...sizeStats(pts, lotAdj.adjusted, fmtMoney0), ...powerStat(fits)],
    }));
  }

  {
    const pts = pointsFor(cmsLot, distanceFor, adjLot);
    const fits = fitsFor(pts, { curve: 'cubic' });
    charts.push(chart({
      title: `Price per Lot by Distance from ${refTitle}`,
      subtitle: criteriaLine(cmsLot, lotAdj.adjusted),
      note: sub(`Measured from ${refName}.`, lotAdj.note, trimSkipNote(cmsLot)),
      points: pts,
      xLabel: distLabel, yLabel: yAdj(lotAdj, 'Price per Lot'),
      yFormat: fmtMoney0, yAxisFormat: axisDollar, xAxisFormat: fmtAxisComma,
      fits, legend: legendFor(fits, pts),
      refLines: subjectDistanceRef(),
      stats: distStats(pts, lotAdj.adjusted, fmtMoney0),
      empty: distEmpty,
    }));
  }

  return charts;
}

// ---------- box-plot groups (Water and Agricultural tabs) ----------

/**
 * Box-plot groups from a key function: every drawn sale becomes a point in
 * its key's row, and the box is fitted to the 'in' points only.
 *
 *   cms        the comparable set whose states the points take
 *   keyOf      rec → group key, or null to leave the sale out
 *   valueOf    rec → the value plotted (a rate, a ratio)
 *   order      explicit row order (keys not listed sort last); else by count
 *   minN       rows need this many 'in' sales (the template's AgMinGroup)
 *   maxGroups  cap (the template's AgTopN)
 *   colorOf    key → box fill
 *
 * Returns {groups, dropped}: `dropped` counts groups left out by either rule.
 */
function boxGroupsFor(cms, keyOf, valueOf, { order = null, minN = 2, maxGroups = Infinity, colorOf = () => null } = {}) {
  const by = new Map();
  for (const rec of drawnRecords()) {
    const key = keyOf(rec);
    const v = valueOf(rec);
    if (key == null || !Number.isFinite(v) || v <= 0) continue;
    const flag = saleAsmtFlag(rec.flagRatio);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({
      v, rec, state: cms.stateOf(rec), flagged: flag !== '' && flag !== 'No assessment',
    });
  }
  const all = [...by.keys()];
  const inCount = (k) => by.get(k).filter((p) => p.state === 'in').length;
  let keys = all.filter((k) => inCount(k) >= minN);
  const rank = (k) => { const i = order ? order.indexOf(k) : -1; return i < 0 ? Infinity : i; };
  if (order) keys.sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)));
  else keys.sort((a, b) => inCount(b) - inCount(a) || String(a).localeCompare(String(b)));
  keys = keys.slice(0, maxGroups);
  return {
    groups: keys.map((k) => ({
      label: k,
      color: colorOf(k),
      points: by.get(k),
      stats: boxStats(by.get(k).filter((p) => p.state === 'in').map((p) => p.v)),
    })),
    dropped: all.length - keys.length,
  };
}

// ---------- water tab ----------------------------------------------

/** Per-render cache of each sale's water facts (lib/salesWater.js). */
let waterCache = new Map();
function waterOf(rec) {
  if (!waterCache.has(rec.saleId)) waterCache.set(rec.saleId, saleWaterFacts(rec));
  return waterCache.get(rec.saleId);
}

/** Colours for the three water groups: the grid's water ramp for the two
 *  water groups, the template's Other grey for dry land. */
const WATER_GROUP_COLORS = {
  Waterfront: WATER_CLASSES[1].color,
  'Near water': WATER_CLASSES[3].color,
  'No water': OTHER_COLOR,
};

const pct1 = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%` : '—');

/**
 * The land template's water tabs (LandStatic.qmd ~8313-8760): sales grouped
 * Waterfront / Near water / No water, box plots by group, class, flood status
 * and water body, scatters by size and by distance to water, and the summary,
 * water-premium and paired-sales tables.
 *
 * Everything is on the current size unit's rate ($/acre, $/SF or $/front
 * foot), time-adjusted when the toggle says so, over the same comparable set
 * (CMS1, or CMS2 when the trim is on) as the Land rates tab.
 */
/** A water class's colour, by the label saleWaterFacts reports. */
const WATER_CLASS_COLOR = new Map(WATER_CLASSES.map((c) => [c.label, c.color]));

/**
 * The Water tab's map (Jason, 2026-10-06): only the water-influenced sales
 * in colour, by the strongest water class among each sale's parcels; the
 * dry sales as faint grey dots for the market around them; sales with no
 * water data left off and counted in the note. Framed on the water sales.
 */
function buildWaterMap(cms, adj) {
  const recs = activeRecords().filter(located);
  const wet = recs.filter((r) => ['Waterfront', 'Near water'].includes(waterOf(r).group));
  const dry = recs.filter((r) => waterOf(r).group === 'No water');
  const unknown = recs.length - wet.length - dry.length;

  const counts = new Map();
  for (const r of wet) {
    const w = waterOf(r);
    // A sale with no class falls back to its group, counted under its own
    // key: the "Waterfront" class and the "Waterfront" group share a name.
    const key = WATER_CLASS_COLOR.has(w.cls) ? w.cls : `group:${w.group}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return paintMap('water', {
    title: 'CMS – Map of Water-Influenced Sales',
    cms,
    adj,
    colored: wet,
    context: dry,
    colorOf: (r) => {
      const w = waterOf(r);
      return WATER_CLASS_COLOR.get(w.cls) || WATER_GROUP_COLORS[w.group] || R_STYLE.pointFill;
    },
    legend: [
      ...WATER_CLASSES.filter((c) => counts.has(c.label)).map((c) => ({ label: `${c.label} (${counts.get(c.label)})`, color: c.color })),
      ...WATER_GROUPS.filter((g) => counts.has(`group:${g}`))
        .map((g) => ({ label: `${g}, class not recorded (${counts.get(`group:${g}`)})`, color: WATER_GROUP_COLORS[g] })),
      ...(dry.length ? [{ label: `No water influence (${dry.length})`, color: '#c8c8c8' }] : []),
    ],
    note: sub(
      wet.length
        ? `${plural(wet.length, 'water-influenced sale')}, coloured by the strongest water class among each sale's parcels.`
        : 'No ticked sale in the current filter is waterfront or near water.',
      dry.length ? 'Grey dots are the sales with no water influence, shown for context.' : '',
      unknown ? `${plural(unknown, 'sale')} without water data not shown.` : ''),
  });
}

function buildWaterCharts() {
  const metric = areaMetric();
  const areaFmt = areaMoneyFmt();
  const perUnit = unitSpec().perUnit;
  const cms = cmsFor(metric);
  const adj = adjusterFor(cms);
  const rate = adj.adjust;
  const size = (rec) => rec[sizeField()];
  const yWord = adj.adjusted ? `Adjusted Price per ${perUnit}` : `Price per ${perUnit}`;
  const criteria = criteriaLine(cms, adj.adjusted);
  const charts = [];

  const unknown = activeRecords().filter((r) => !waterOf(r).group).length;
  const unknownNote = unknown
    ? `${unknown} sale${unknown === 1 ? '' : 's'} without water data are left out — still loading in the `
      + 'main window, or no water data is published for the municipality.'
    : '';

  const boxGroups = (keyOf, order = null, minN = 2, maxGroups = Infinity) => boxGroupsFor(
    cms, keyOf, rate, { order, minN, maxGroups, colorOf: (k) => WATER_GROUP_COLORS[k] });
  const box = (spec) => drawBoxChart({
    tooltipRows,
    onPointClick: opts.frozen ? null : onPointClick,
    onRestore: opts.frozen ? null : restoreSales,
    pngName: pngName(spec.title),
    valueFormat: areaFmt,
    axisFormat: fmtAxisDollar,
    valueLabel: yWord,
    subtitle: criteria,
    ...spec,
  });

  // 1. By water group — the headline comparison.
  {
    const { groups } = boxGroups((r) => waterOf(r).group, WATER_GROUPS, 1);
    charts.push(box({
      title: `Price per ${perUnit} by Water Influence`,
      note: sub('Waterfront = any parcel in the sale has frontage; Near water = near but without frontage.',
        adj.note, unknownNote),
      groups,
      empty: 'No sales in the current filter carry water-influence data and a usable rate.',
    }));
  }

  // 2. By detection class, strongest first.
  {
    const order = [...WATER_CLASSES.map((c) => c.label), 'No water'];
    const { groups, dropped } = boxGroups((r) => waterOf(r).cls, order);
    charts.push(box({
      title: `Price per ${perUnit} by Water Class`,
      note: sub('Classes with fewer than 2 sales are left out.',
        dropped ? `${dropped} class${dropped === 1 ? '' : 'es'} omitted.` : '', adj.note),
      groups,
    }));
  }

  // 3. By flood status.
  {
    const { groups, dropped } = boxGroups((r) => waterOf(r).flood);
    charts.push(box({
      title: `Price per ${perUnit} by Flood Status`,
      note: sub('Most severe flood layer any parcel in the sale touches. Groups with fewer than 2 sales are left out.',
        dropped ? `${dropped} omitted.` : '', adj.note),
      groups,
      empty: 'No flood-layer data for these sales: the municipality has no published flood shard '
        + '(often because no flood layer reaches it), so flood status is unknown rather than "None".',
    }));
  }

  // 4. By water body (at least 2 sales per body, as the template).
  {
    const { groups, dropped } = boxGroups((r) => waterOf(r).body, null, 2, 10);
    charts.push(box({
      title: `Price per ${perUnit} by Water Body`,
      note: sub('The ten water bodies with the most sales, at least 2 each.',
        dropped ? `${dropped} other water bod${dropped === 1 ? 'y' : 'ies'} omitted.` : '', adj.note),
      groups,
      empty: 'No water body has 2 or more sales in the current filter.',
    }));
  }

  // 5. By size, coloured by water group, a straight line per group.
  {
    const pts = pointsFor(cms, size, rate, (r) => WATER_GROUP_COLORS[waterOf(r).group] || null)
      .filter((p) => waterOf(p.rec).group);
    const fits = [];
    for (const g of WATER_GROUPS) {
      const lin = fitLinear(inOnly(pts).filter((p) => waterOf(p.rec).group === g).map((p) => ({ x: p.x, y: p.y })));
      if (lin) fits.push({ predict: lin.predict, color: WATER_GROUP_COLORS[g], label: `${g} trend` });
    }
    const legend = [
      ...WATER_GROUPS.filter((g) => pts.some((p) => waterOf(p.rec).group === g))
        .map((g) => ({ label: g, color: WATER_GROUP_COLORS[g], dot: 'swatch' })),
      ...fits.map((f) => ({ label: f.label, color: f.color })),
      ...stateLegend(pts),
    ];
    charts.push(chart({
      title: `Price per ${perUnit} by Size and Water Influence`,
      subtitle: criteria,
      note: sub('A straight trend per group; the gap between the lines at a given size is the water effect.', adj.note),
      points: pts,
      xLabel: sizeAxisLabel(), yLabel: yWord,
      yFormat: areaFmt, yAxisFormat: fmtAxisDollar, xAxisFormat: fmtAxisComma,
      fits, legend: legend.length > 1 ? legend : null,
      refLines: subjectRef(),
      stats: sizeStats(pts, adj.adjusted, areaFmt),
    }));
  }

  // 6. By distance to water.
  {
    const pts = pointsFor(cms, (r) => waterOf(r).distFt, rate,
      (r) => WATER_GROUP_COLORS[waterOf(r).group] || null);
    const fits = fitsFor(pts, { curve: 'none' });
    charts.push(chart({
      title: `Price per ${perUnit} by Distance to Water`,
      subtitle: criteria,
      note: sub(`Only parcels within ${WATER_DETECTION_LIMIT_FT} ft of water carry a distance.`, adj.note),
      points: pts,
      xLabel: 'Distance to Water (ft)', yLabel: yWord,
      yFormat: areaFmt, yAxisFormat: fmtAxisDollar, xAxisFormat: fmtAxisComma,
      fits, legend: legendFor(fits, pts),
      refLines: subjectAt(data.meta?.subject?.waterFt),
      stats: spreadStats(pts, {
        xName: 'Median distance', xFormat: (v) => `${fmtNum(v)} ft`, adjusted: adj.adjusted, yFormat: areaFmt,
      }),
      empty: 'No sales in the current filter are within the water detection distance.',
    }));
  }

  // 7. Summary by group.
  {
    const rows = [];
    for (const g of WATER_GROUPS) {
      const recs = cms.fitted.filter((r) => waterOf(r).group === g);
      if (!recs.length) continue;
      const nominal = recs.map((r) => r[metric]).filter((v) => v > 0);
      const adjusted = recs.map(rate).filter((v) => v > 0);
      rows.push([
        g, String(recs.length),
        fmtNumOr(median(recs.map(size))),
        areaFmt(median(nominal)),
        adj.adjusted ? areaFmt(median(adjusted)) : '—',
        fmtMoney0(median(recs.map((r) => r.price))),
      ]);
    }
    charts.push(drawTableCard({
      title: 'Water Influence Summary',
      subtitle: criteria,
      columns: [
        { label: 'Group' }, { label: 'Sales', num: true }, { label: `Median ${unitSpec().range}`, num: true },
        { label: `Median $/${areaUnitLabel()}`, num: true }, { label: `Median adj. $/${areaUnitLabel()}`, num: true },
        { label: 'Median price', num: true },
      ],
      rows,
      note: unknownNote,
      empty: 'No sales in the current filter carry water-influence data.',
    }));
  }

  // 8. Water premium regression.
  {
    const prem = waterPremium(cms.fitted
      .map((r) => ({ rate: rate(r), size: size(r), group: waterOf(r).group })));
    const rows = prem ? prem.groups.map((g) => [
      g.group, String(g.n), pct1(g.premium), `${pct1(g.lo)} to ${pct1(g.hi)}`,
    ]) : [];
    charts.push(drawTableCard({
      title: 'Water Premium',
      subtitle: `log(${yWord}) ~ log(size) + water group, against ${prem?.baseN ?? 0} no-water sales`,
      columns: [{ label: 'Group' }, { label: 'Sales', num: true }, { label: 'Premium vs no water', num: true }, { label: '95% range', num: true }],
      rows,
      note: prem
        ? `n = ${prem.n}, R² = ${prem.r2.toFixed(2)}, size elasticity ${prem.sizeElasticity.toFixed(2)}. `
          + 'Controls for size, since waterfront lots are often smaller; a range that spans 0% is not a measured premium.'
        : '',
      empty: 'Needs sales in the No water group and at least one water group, each with a size.',
    }));
  }

  // 9. Paired sales.
  {
    const items = cms.fitted.map((r) => ({
      rec: r, size: size(r), rate: rate(r), group: waterOf(r).group,
    }));
    const pairs = pairedSales(items);
    const who = (r) => r.address || (r.rolls || []).join(', ');
    const rows = pairs.map((p) => [
      who(p.wet.rec), p.wet.rec.dateText || fmtDate(p.wet.rec.dateMs), unitSpec().sizeText(p.wet.size), areaFmt(p.wet.rate),
      who(p.dry.rec), unitSpec().sizeText(p.dry.size), areaFmt(p.dry.rate), pct1(p.diff),
    ]);
    const medDiff = median(pairs.map((p) => p.diff));
    charts.push(drawTableCard({
      title: 'Paired Sales: Waterfront vs No Water',
      subtitle: 'Each waterfront sale paired with the no-water sale closest in size (half to double its size)',
      columns: [
        { label: 'Waterfront sale' }, { label: 'Sold' }, { label: 'Size', num: true }, { label: `$/${areaUnitLabel()}`, num: true },
        { label: 'Paired dry sale' }, { label: 'Size', num: true }, { label: `$/${areaUnitLabel()}`, num: true },
        { label: 'Difference', num: true },
      ],
      rows,
      note: pairs.length ? `Median difference across ${pairs.length} pair${pairs.length === 1 ? '' : 's'}: ${pct1(medDiff)}. ${adj.note}` : '',
      empty: 'No waterfront sale has a no-water sale within half to double its size.',
    }));
  }

  return charts;
}

const fmtNumOr = (v) => (Number.isFinite(v) ? fmtNum(v) : '—');

// ---------- agricultural tab ---------------------------------------

const MASC_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const UNRATED = 'Unrated';
/** A sale's MASC rating as a group key: a single letter A-J, or Unrated.
 *  A split quarter ("C/F") keeps its label — it is its own market. */
const mascKey = (rec) => {
  const m = String(rec.ag?.masc || '').trim().toUpperCase();
  return m || UNRATED;
};
const mascFill = (key) => (MASC_ORDER.includes(key) ? masccolor(key) : OTHER_COLOR);
const COVER_COLORS = Object.fromEntries(LAND_COVER_BUCKETS.map((b) => [b.label, b.color]));

/**
 * The land template's Ag-CMS page (LandStatic.qmd ~15416-15992): farmland
 * price by MASC rating, cultivation, soil, CLI class and land cover; the
 * land-cover mix by MASC and by soil; and the sale-to-assessment ratio over
 * time, by MASC and as a distribution. On the current size unit's rate,
 * time-adjusted per the toggle, over the same CMS1/CMS2 set as the other
 * tabs. Groups need 2 sales and the top 8 are shown, the template's
 * AgMinGroup / AgTopN defaults.
 *
 * Not ported: the template's separate Ag consistency filters (CMSAG1 and its
 * own rate). Narrow the sales in the main window instead — the cultivation,
 * CLI and MASC ticks there are the same filters.
 */
/** CLI capability classes 1 (best) to 7, on a green-to-red ramp. */
const CLI_COLORS = { 1: '#1a9850', 2: '#66bd63', 3: '#a6d96a', 4: '#fee08b', 5: '#fdae61', 6: '#f46d43', 7: '#d73027' };

/**
 * The Agricultural tab's crop-rating maps (Jason, 2026-10-06): the sales by
 * MASC rating, and by CLI capability class. Sales without the rating are
 * faint grey context dots.
 */
function buildAgMaps(cms, adj) {
  const recs = activeRecords().filter(located);
  const rated = recs.filter((r) => MASC_ORDER.includes(mascKey(r)));
  const mascCounts = new Map();
  for (const r of rated) mascCounts.set(mascKey(r), (mascCounts.get(mascKey(r)) || 0) + 1);
  const unrated = recs.length - rated.length;
  const masc = paintMap('masc', {
    title: 'CMS – Map by MASC Rating',
    cms,
    adj,
    colored: rated,
    context: recs.filter((r) => !MASC_ORDER.includes(mascKey(r))),
    colorOf: (r) => mascFill(mascKey(r)),
    legend: [
      ...MASC_ORDER.filter((k) => mascCounts.has(k)).map((k) => ({ label: `${k} (${mascCounts.get(k)})`, color: mascFill(k) })),
      ...(unrated ? [{ label: `Unrated (${unrated})`, color: '#c8c8c8' }] : []),
    ],
    note: rated.length
      ? 'MASC soil productivity rating, the acre-weighted mode across each sale\'s parcels (A best).'
        + (unrated ? ' Grey dots carry no rating.' : '')
      : 'No ticked sale in the current filter carries a MASC rating.',
  });

  const withCli = recs.filter((r) => CLI_COLORS[r.ag?.cliClass]);
  const cliCounts = new Map();
  for (const r of withCli) cliCounts.set(r.ag.cliClass, (cliCounts.get(r.ag.cliClass) || 0) + 1);
  const noCli = recs.length - withCli.length;
  const cli = paintMap('cli', {
    title: 'CMS – Map by CLI Capability Class',
    cms,
    adj,
    colored: withCli,
    context: recs.filter((r) => !CLI_COLORS[r.ag?.cliClass]),
    colorOf: (r) => CLI_COLORS[r.ag.cliClass],
    legend: [
      ...Object.keys(CLI_COLORS).filter((k) => cliCounts.has(k)).map((k) => ({ label: `Class ${k} (${cliCounts.get(k)})`, color: CLI_COLORS[k] })),
      ...(noCli ? [{ label: `No CLI data (${noCli})`, color: '#c8c8c8' }] : []),
    ],
    note: withCli.length
      ? 'Canada Land Inventory agricultural capability, class 1 (no limitations) to 7 (no capability).'
        + (noCli ? ' Grey dots have no CLI class loaded.' : '')
      : 'No CLI data for these sales. Pick the Agricultural column preset in the main window to load it.',
  });
  return [masc, cli];
}

function buildAgCharts() {
  const metric = areaMetric();
  const areaFmt = areaMoneyFmt();
  const perUnit = unitSpec().perUnit;
  const cms = cmsFor(metric);
  const adj = adjusterFor(cms);
  const rate = adj.adjust;
  const yWord = adj.adjusted ? `Adjusted Price per ${perUnit}` : `Price per ${perUnit}`;
  const criteria = criteriaLine(cms, adj.adjusted);
  const MIN_N = 2;
  const TOP_N = 8;
  const charts = [];
  // When no ticked sale carries a price in the chosen unit, every chart is
  // empty for THAT reason — say so, instead of a message about MASC or land
  // cover that sends the reader looking for missing data that is there.
  const noRate = cms.active.some((r) => Number(rate(r)) > 0)
    ? null
    : `No sales in the current filter carry a price per ${perUnit.toLowerCase()}. Try the Acres size unit.`;
  const emptyOr = (msg) => noRate || msg;

  const soilMissing = activeRecords().some((r) => !r.ag?.soilLoaded);
  const soilNote = soilMissing
    ? 'Soil and CLI load with the Agricultural column preset (or the CLI overlay) in the main window; '
      + 'sales without them are left out.'
    : '';
  const box = (spec) => drawBoxChart({
    tooltipRows,
    onPointClick: opts.frozen ? null : onPointClick,
    onRestore: opts.frozen ? null : restoreSales,
    pngName: pngName(spec.title),
    valueFormat: areaFmt,
    axisFormat: fmtAxisDollar,
    valueLabel: yWord,
    subtitle: criteria,
    ...spec,
  });
  const groupNote = (dropped) => (dropped
    ? `${dropped} group${dropped === 1 ? '' : 's'} with fewer than ${MIN_N} sales, or past the top ${TOP_N}, left out.`
    : '');
  const mascLegend = (pts) => {
    const keys = [...new Set(pts.map((p) => mascKey(p.rec)))]
      .sort((a, b) => (MASC_ORDER.indexOf(a) + 1 || 99) - (MASC_ORDER.indexOf(b) + 1 || 99));
    return keys.map((k) => ({ label: k, color: mascFill(k), dot: 'swatch' }));
  };

  // 1. Price over time, coloured by MASC rating.
  {
    const pts = pointsFor(cms, (r) => r.dateMs, (r) => r[metric], (r) => mascFill(mascKey(r)));
    const trend = timeTrend(cms, pts, areaFmt);
    charts.push(chart({
      title: `Land Price per ${perUnit} Over Time by MASC Rating`,
      subtitle: criteriaLine(cms, false),
      note: sub('Rates as sold, coloured by the MASC rating covering the most of each sale.', trend.note),
      points: pts, xIsDate: true,
      xLabel: 'Sale Date', yLabel: `Price per ${perUnit}`,
      yFormat: areaFmt, yAxisFormat: fmtAxisDollar,
      fits: trend.fits,
      legend: [...mascLegend(pts), ...trend.fits.map((f) => ({ label: f.label, color: f.color, dash: !!f.dash })), ...stateLegend(pts)],
      stats: trend.stats,
      empty: noRate || undefined,
    }));
  }

  // 2. Price by cultivation ratio.
  {
    const pts = pointsFor(cms, (r) => (r.ag?.cover ? r.ag.cover.cult * 100 : null), rate);
    const fits = fitsFor(pts, { curve: 'cubic' });
    charts.push(chart({
      title: `Price per ${perUnit} by Cultivation Ratio`,
      subtitle: criteria,
      note: sub('Share of each sale under cultivation (crop inventory 2021-25, or the 2020 Land Cover Register).', adj.note),
      points: pts,
      xLabel: 'Cultivated (%)', yLabel: yWord,
      yFormat: areaFmt, yAxisFormat: fmtAxisDollar, xAxisFormat: fmtAxisComma,
      fits, legend: legendFor(fits, pts),
      refLines: subjectAt(data.meta?.subject?.cultPct),
      stats: spreadStats(pts, { xName: 'Median cultivated', xFormat: (v) => `${Math.round(v)}%`, adjusted: adj.adjusted, yFormat: areaFmt }),
      empty: emptyOr('No sales in the current filter carry land-cover data (parcels under 10 acres have none).'),
    }));
  }

  // 3. MASC rating.
  {
    const { groups, dropped } = boxGroupsFor(cms, mascKey, rate,
      { order: [...MASC_ORDER, UNRATED], minN: MIN_N, colorOf: mascFill });
    charts.push(box({
      title: `Farmland Price per ${perUnit} by MASC Rating`,
      note: sub(groupNote(dropped), adj.note),
      groups,
      empty: emptyOr('No MASC rating has 2 or more sales in the current filter.'),
    }));
  }

  // 4. Soil type (top 8).
  {
    const { groups, dropped } = boxGroupsFor(cms, (r) => r.ag?.soil || null, rate,
      { minN: MIN_N, maxGroups: TOP_N });
    charts.push(box({
      title: `Price per ${perUnit} by Soil Type`,
      note: sub(groupNote(dropped), soilNote, adj.note),
      groups,
      empty: emptyOr('No soil data for these sales. Pick the Agricultural column preset in the main window to load it.'),
    }));
  }

  // 5. CLI capability class.
  {
    const { groups, dropped } = boxGroupsFor(cms,
      (r) => (r.ag?.cliClass ? `Class ${r.ag.cliClass}` : null), rate,
      { order: ['1', '2', '3', '4', '5', '6', '7'].map((c) => `Class ${c}`), minN: MIN_N });
    charts.push(box({
      title: `Price per ${perUnit} by CLI Capability Class`,
      note: sub(groupNote(dropped), soilNote, adj.note),
      groups,
      empty: emptyOr('No CLI data for these sales. Pick the Agricultural column preset in the main window to load it.'),
    }));
  }

  // 6. Dominant land cover, ordered by median (the template sorts descending).
  {
    const { groups, dropped } = boxGroupsFor(cms, (r) => r.ag?.coverLabel || null, rate,
      { minN: MIN_N, colorOf: (k) => COVER_COLORS[k] || null });
    groups.sort((a, b) => (b.stats?.median ?? 0) - (a.stats?.median ?? 0));
    charts.push(box({
      title: `Price per ${perUnit} by Dominant Land Cover`,
      note: sub(groupNote(dropped), adj.note),
      groups,
      empty: emptyOr('No sales in the current filter carry land-cover data.'),
    }));
  }

  // 7-8. Land-cover mix by MASC and by soil type.
  const mixRows = (keyOf, order = null) => {
    const by = new Map();
    for (const r of cms.fitted) {
      const k = keyOf(r);
      if (k == null || !r.ag?.cover) continue;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(r.ag.cover);
    }
    let keys = [...by.keys()].filter((k) => by.get(k).length >= MIN_N);
    if (order) keys.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    else keys.sort((a, b) => by.get(b).length - by.get(a).length);
    return keys.slice(0, TOP_N).map((k) => {
      const covers = by.get(k);
      const shares = {};
      for (const c of COVER_KEYS) shares[c] = covers.reduce((s, x) => s + (Number(x[c]) || 0), 0) / covers.length;
      return { label: k, n: covers.length, shares };
    });
  };
  const segments = LAND_COVER_BUCKETS.map((b) => ({ key: b.key, label: b.label, color: b.color }));
  charts.push(drawStackedBars({
    title: 'Land Cover Mix by MASC Rating',
    subtitle: criteria,
    note: 'Mean share of each cover type across the sales in each rating.',
    pngName: pngName('Land Cover Mix by MASC Rating'),
    segments,
    rows: mixRows(mascKey, [...MASC_ORDER, UNRATED]),
    empty: 'No MASC rating has 2 or more sales with land-cover data.',
  }));
  charts.push(drawStackedBars({
    title: 'Land Cover Mix by Soil Type',
    subtitle: criteria,
    note: sub('Mean share of each cover type across the sales on each soil (top 8).', soilNote),
    pngName: pngName('Land Cover Mix by Soil Type'),
    segments,
    rows: mixRows((r) => r.ag?.soil || null),
    empty: 'No soil data for these sales. Pick the Agricultural column preset in the main window to load it.',
  }));

  // 9-11. Sale-to-assessment ratio: over time, by MASC, distribution. The
  // template's SaleAsmt: price over the sale's summed total assessment.
  const ratio = (r) => r.saleToAsmt;
  {
    const pts = pointsFor(cms, (r) => r.dateMs, ratio, (r) => mascFill(mascKey(r)));
    const fits = fitsFor(pts, { curve: 'none' });
    charts.push(chart({
      title: 'Sale-to-Assessment Ratio Over Time',
      subtitle: criteriaLine(cms, false),
      note: 'Sale price over total assessed value; 1 = sold at assessment.',
      points: pts, xIsDate: true,
      xLabel: 'Sale Date', yLabel: 'Sale / Assessment',
      yFormat: (v) => v.toFixed(2), yAxisFormat: (v) => v.toFixed(1),
      fits, refLines: [{ y: 1, label: '1.0' }],
      legend: [...mascLegend(pts), ...fits.map((f) => ({ label: f.label, color: f.color })), ...stateLegend(pts)],
      stats: (() => {
        const fitted = inOnly(pts);
        const med = median(fitted.map((p) => p.y));
        return [
          { label: 'Sales', value: String(fitted.length) },
          ...(med != null ? [{ label: 'Median ratio', value: med.toFixed(2) }] : []),
        ];
      })(),
      empty: 'No sales in the current filter carry an assessed value.',
    }));
  }
  {
    const { groups, dropped } = boxGroupsFor(cms, mascKey, ratio,
      { order: [...MASC_ORDER, UNRATED], minN: MIN_N, colorOf: mascFill });
    charts.push(box({
      title: 'Sale-to-Assessment Ratio by MASC Rating',
      note: groupNote(dropped),
      groups,
      valueFormat: (v) => v.toFixed(2),
      axisFormat: (v) => v.toFixed(1),
      valueLabel: 'Sale / Assessment',
      subtitle: criteriaLine(cms, false),
      empty: 'No MASC rating has 2 or more sales with an assessed value.',
    }));
  }
  {
    const vals = cms.fitted.map(ratio).filter((v) => Number.isFinite(v) && v > 0);
    charts.push(drawHistogram({
      title: 'Sale-to-Assessment Ratio Distribution',
      subtitle: criteriaLine(cms, false),
      note: 'Reference lines at 1 and at the review-flag thresholds (0.25 very low, 0.50 low, 2.50 high).',
      pngName: pngName('Sale-to-Assessment Ratio Distribution'),
      values: vals,
      bins: 20,
      refLines: [
        { x: 1, label: '1.0', color: R_STYLE.linear },
        { x: SALE_ASMT_TIERS.veryLow, color: INK.muted },
        { x: SALE_ASMT_TIERS.low, color: INK.muted },
        { x: SALE_ASMT_TIERS.high, color: INK.muted },
      ],
      xLabel: 'Sale / Assessment',
      axisFormat: (v) => v.toFixed(1),
      stats: vals.length ? [
        { label: 'Sales', value: String(vals.length) },
        { label: 'Median', value: median(vals).toFixed(2) },
      ] : [],
      empty: 'No sales in the current filter carry an assessed value.',
    }));
  }

  return charts;
}

// ---------- map tab ------------------------------------------------

/** The page's two maps, created the first time the Map tab is shown: the
 *  colour-by map, and beside it the lot-size heatmap (Jason, 2026-09-23 —
 *  for residential work, where lot size drives the rate). One wrapper holds
 *  both so they sit side by side in the grid. */
/**
 * Every map on the page, by key, created on first use and kept: a MapLibre
 * map is expensive, and the figures are re-appended on each render. Which
 * page and map tab shows each key is PAGE_MAPS. mapCounts holds how many
 * sales each drew in colour; the work file lists a map with none as
 * "no data".
 */
const pageMaps = new Map();
const mapCounts = new Map();
function pageMap(key) {
  if (!pageMaps.has(key)) pageMaps.set(key, createSalesMap(mapHandlers()));
  return pageMaps.get(key);
}

/**
 * One row per tab holding its maps, two to a row so no map is wider than half
 * the page (Jason, 2026-10-06); a single map takes the left half. The row is
 * kept, not rebuilt: an off-screen build for the work file then re-fills the
 * same element instead of pulling a live map out of the page.
 */
const mapRows = new Map();
function mapRow(tab, maps) {
  let row = mapRows.get(tab);
  if (!row) {
    row = document.createElement('div');
    row.className = 'map-row';
    mapRows.set(tab, row);
  }
  row.replaceChildren(...maps.map((m) => m.figure));
  // The figures are re-appended on every render; the maps must re-measure
  // once they are back in the document.
  requestAnimationFrame(() => { for (const m of maps) m.resize(); });
  return row;
}

/** The subject point and the distance-filter ring, as every map draws them. */
function subjectAndRings() {
  const s = data.meta?.subject;
  const subject = Number.isFinite(s?.lat) && Number.isFinite(s?.lng) ? { lat: s.lat, lng: s.lng } : null;
  const filterKm = Number(data.meta?.criteria?.distanceMax);
  return { subject, rings: subject && Number.isFinite(filterKm) && filterKm > 0 ? [filterKm] : [] };
}

const located = (r) => Number.isFinite(r.lat) && Number.isFinite(r.lng);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Fill one of the category / heatmap maps: `colored` sales in their colour,
 * `context` sales as faint grey dots under them (not framed), and the shared
 * subject, ring, municipal lines, title and criteria line.
 */
function paintMap(key, { title, cms, adj, colored, context = [], colorOf, legend, note }) {
  const m = pageMap(key);
  const feature = (r, ctx) => ({
    type: 'Feature',
    properties: {
      saleId: String(r.saleId), excluded: false, context: ctx, color: ctx ? null : colorOf(r),
      label: tagLabel(tags, saleTagKey(r)) || '',
    },
    geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
  });
  const { subject, rings } = subjectAndRings();
  m.setHeader(title, criteriaLine(cms, adj.adjusted));
  m.setPngName(pngName(title));
  m.setMunisVisible(opts.mapMunis !== false);
  m.setLegend(legend);
  const unlocated = activeRecords().length - activeRecords().filter(located).length;
  const unticked = (data.records || []).filter((r) => r.excluded).length;
  m.setNote(sub(note,
    rings.length ? `The circle is the ${fmtNum(rings[0])} km distance filter set in Sales Analysis.` : '',
    subject ? '' : 'Set a subject roll in the main window to mark it on the map.',
    unticked ? `${plural(unticked, 'unticked sale')} not shown.` : '',
    unlocated ? `${plural(unlocated, 'sale')} without a parcel location not shown.` : ''));
  m.setData({
    fc: { type: 'FeatureCollection', features: [...context.map((r) => feature(r, true)), ...colored.map((r) => feature(r, false))] },
    subject,
    rings,
    fitKey: `${colored.map((r) => r.saleId).join('|')}#${context.length}`,
  });
  mapCounts.set(key, colored.length);
  return m;
}

/** Click and popup handlers, shared by every map on the page. */
function mapHandlers() {
  const find = (id) => (data.records || []).find((r) => String(r.saleId) === String(id));
  return {
    onPick: (id) => { const rec = find(id); if (rec) onPointClick(rec); },  // prompts for a reason too
    popupRows: (id) => { const rec = find(id); return rec ? tooltipRows(rec, null).filter(([l]) => l !== '') : []; },
    // Tag buttons under Exclude: one per list, saying what a click will do.
    popupActions: (id) => {
      const rec = find(id);
      const key = rec && saleTagKey(rec);
      if (!key) return [];
      return TAG_LISTS.map((list) => {
        const n = tagNumber(tags, list, key);
        const name = list === 'comps' ? 'Comp' : TAG_LIST_NAMES[list];
        return {
          text: n ? `Remove ${name} #${n}` : `Add as ${name} #${tags[list].length + 1}`,
          run: () => toggleSaleTag(rec, list),
        };
      });
    },
  };
}

/** The template's map titles, per colouring. */
/** Two maps side by side pan and zoom together; linked once, on first paint. */
const linkedMaps = new WeakSet();
function linkPair(a, b) {
  if (linkedMaps.has(a)) return;
  linkMaps(a, b);
  linkedMaps.add(a);
}

/**
 * The Land Price/Unit page's maps — the land template's CMS maps
 * (LandStatic.qmd ~6798-7303), one map per colouring rather than a
 * colour-by switch, arranged in Shiny's map tabs (Jason, 2026-10-06).
 * Only the ticked sales are drawn (Jason, 2026-09-23): an unticked sale
 * drawn pale beside the pale end of the price ramp read as a real, cheap
 * sale.
 */
function paintRateMaps(keys) {
  const metric = areaMetric();
  const areaFmt = areaMoneyFmt();
  const cms = cmsFor(metric);
  const adj = adjusterFor(cms);
  const recs = activeRecords().filter(located);
  const spec = unitSpec();
  const painters = {
    price: () => {
      const b = priceBuckets(recs.map(adj.adjust), areaFmt);
      return paintMap('price', {
        title: `CMS Heatmap – Price per ${spec.perUnit}`,
        cms,
        adj,
        colored: recs,
        colorOf: (r) => (b && b.colorOf(adj.adjust(r))) || R_STYLE.pointFill,
        legend: b ? b.legend : [],
        note: sub(`Quintiles of ${adj.adjusted ? 'adjusted ' : ''}price per ${spec.perUnit.toLowerCase()}; `
          + 'each colour holds about a fifth of the sales.', adj.note),
      });
    },
    // Quintiles of the size in the chosen unit, on its own blue ramp so it is
    // never mistaken for the price map beside it. Size is not time-adjusted.
    size: () => {
      const sizeOf = (r) => { const v = Number(r[sizeField()]); return v > 0 ? v : null; };
      const sized = recs.filter((r) => sizeOf(r) != null);
      const sb = priceBuckets(sized.map(sizeOf), spec.sizeText, SIZE_RAMP);
      const sizeless = recs.length - sized.length;
      const ff = opts.unit === 'ff';
      return paintMap('size', {
        title: `CMS Heatmap – ${spec.sizeTitle}`,
        cms,
        adj,
        colored: sized,
        context: recs.filter((r) => sizeOf(r) == null),
        colorOf: (r) => (sb && sb.colorOf(sizeOf(r))) || '#dddddd',
        legend: [...(sb ? sb.legend : []), ...(sizeless ? [{ label: `${ff ? 'No frontage' : 'No size'} (${sizeless})`, color: '#c8c8c8' }] : [])],
        note: sub(`Quintiles of ${ff ? 'lot frontage' : 'lot size'}; each colour holds about a fifth of the sales.`,
          'Pans and zooms with the map beside it.'),
      });
    },
    year: () => {
      const yearOf = (r) => (Number.isFinite(r.dateMs) ? new Date(r.dateMs).getFullYear() : null);
      const y = yearColors(recs.map(yearOf));
      return paintMap('year', {
        title: 'CMS – Map by Year of Sale', cms, adj, colored: recs,
        colorOf: (r) => y.colorOf(yearOf(r)), legend: y.legend,
        note: 'Pans and zooms with the map beside it.',
      });
    },
    zoning: () => {
      const zones = topZones(recs, ZONE_COLORS.length);
      const byZone = new Map(zones.map((z, i) => [z.key, ZONE_COLORS[i]]));
      return paintMap('zoning', {
        title: 'CMS – Map by Zoning', cms, adj, colored: recs,
        colorOf: (r) => byZone.get(String(r.zone || '').trim()) || OTHER_COLOR,
        legend: [...zones.map((z) => ({ label: `${z.key} (${z.count})`, color: byZone.get(z.key) })),
          ...(recs.some((r) => !byZone.has(String(r.zone || '').trim())) ? [{ label: 'Other', color: OTHER_COLOR }] : [])],
        note: 'The eight most common zones; the rest are Other.',
      });
    },
    waterinf: () => paintMap('waterinf', {
      title: 'CMS – Map by Water Influence', cms, adj, colored: recs,
      colorOf: (r) => WATER_GROUP_COLORS[waterOf(r).group] || '#dddddd',
      legend: [...WATER_GROUPS.map((g) => ({ label: g, color: WATER_GROUP_COLORS[g] })),
        ...(recs.some((r) => !waterOf(r).group) ? [{ label: 'No water data', color: '#dddddd' }] : [])],
      note: 'Waterfront = any parcel in the sale has frontage; Near water = near but without frontage.',
    }),
  };
  const apis = keys.map((k) => painters[k]());
  if (apis.length === 2) linkPair(apis[0], apis[1]);
  return apis;
}

/**
 * Each page's map tabs, the top row of the Shiny layout (Jason, 2026-10-06):
 * a label, the map keys it shows side by side, and the painter that fills
 * them. Every painter runs inside withPageUnit for its page.
 */
const PAGE_MAPS = {
  rates: [
    { label: 'Price & Lot Size', keys: ['price', 'size'], paint: () => paintRateMaps(['price', 'size']) },
    { label: 'Year & Zoning', keys: ['year', 'zoning'], paint: () => paintRateMaps(['year', 'zoning']) },
    { label: 'Water Influence', keys: ['waterinf'], paint: () => paintRateMaps(['waterinf']) },
  ],
  ag: [{
    label: 'MASC & CLI', keys: ['masc', 'cli'],
    paint: () => { const cms = cmsFor(areaMetric()); return buildAgMaps(cms, adjusterFor(cms)); },
  }],
  total: [{ label: 'Price per Lot', keys: ['ppl'], paint: () => [buildPplMap()] }],
  water: [{
    label: 'Water Class', keys: ['water'],
    paint: () => { const cms = cmsFor(areaMetric()); return [buildWaterMap(cms, adjusterFor(cms))]; },
  }],
};
/** key -> {page, label}: where the work file goes to capture a map. */
const MAP_HOME = Object.fromEntries(Object.entries(PAGE_MAPS)
  .flatMap(([page, tabs]) => tabs.flatMap((t) => t.keys.map((k) => [k, { page, label: t.label }]))));

/**
 * Each page's chart tabs, the bottom row: a label and the chart titles it
 * holds, two to a tab. Matched on the title without its unit, so "Price
 * per Acre by Size" and "Price per SF by Size" land in the same tab. A
 * chart no pattern names goes to a "More" tab rather than disappearing.
 */
const CHART_GROUPS = {
  rates: [
    ['Over Time & Size', /Over Time$|by Size$/],
    ['Zoning & Distance', /and Zoning$|by Distance from/],
  ],
  ag: [
    ['MASC Rating', /Over Time by MASC Rating$|^Farmland Price/],
    ['Cultivation & Soil', /by Cultivation Ratio$|^Price per .* by Soil Type$/],
    ['CLI & Land Cover', /by CLI Capability Class$|by Dominant Land Cover$/],
    ['Cover Mix', /^Land Cover Mix/],
    ['Sale/Assessment', /^Sale-to-Assessment Ratio (Over Time|by MASC)/],
    ['S/A Distribution', /Ratio Distribution$/],
  ],
  total: [
    ['Total Price', /^Total Price (Over Time|by Distance)/],
    ['Per Lot', /^Land Price per Lot Over Time$|^Price per Lot by Size$/],
    ['Per Lot by Distance & Assessed', /^Price per Lot by Distance|vs Assessed Value$/],
  ],
  water: [
    ['Influence & Class', /by Water Influence$|by Water Class$/],
    ['Flood & Water Body', /by Flood Status$|by Water Body$/],
    ['Size & Distance', /Size and Water Influence$|Distance to Water$/],
    ['Summary & Premium', /^Water Influence Summary$|^Water Premium$/],
    ['Paired Sales', /^Paired Sales/],
  ],
};

const figTitle = (fig) => chartExportSpec(fig)?.title || fig.querySelector('h3')?.textContent || '';

/** A page's figures as [{label, figs}] in CHART_GROUPS order, two per tab at most. */
function groupCharts(page, figs) {
  const defs = CHART_GROUPS[page] || [];
  const groups = defs.map(([label]) => ({ label, figs: [] }));
  const rest = [];
  for (const fig of figs) {
    const i = defs.findIndex(([, re]) => re.test(figTitle(fig)));
    if (i >= 0) groups[i].figs.push(fig); else rest.push(fig);
  }
  const out = [];
  for (const g of groups) {
    for (let i = 0; i < g.figs.length; i += 2) {
      out.push({ label: i ? `${g.label} (${i / 2 + 1})` : g.label, figs: g.figs.slice(i, i + 2) });
    }
  }
  for (let i = 0; i < rest.length; i += 2) {
    out.push({ label: i ? `More (${i / 2 + 1})` : 'More', figs: rest.slice(i, i + 2) });
  }
  return out;
}

/** The remembered sub-tab of a page's map or chart row. */
function subTab(page, row) {
  return opts.subTabs?.[page]?.[row] || null;
}
function setSubTab(page, row, label) {
  const all = { ...(opts.subTabs || {}) };
  all[page] = { ...(all[page] || {}), [row]: label };
  setOpt({ subTabs: all });
}

/** A row's tab strip, Shiny's .tabset: one button per label. */
function rowTabStrip(page, row, labels, active, ariaLabel) {
  const strip = document.createElement('div');
  strip.className = 'row-tabs';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', ariaLabel);
  for (const label of labels) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(label === active));
    b.className = label === active ? 'is-on' : '';
    b.textContent = label;
    b.addEventListener('click', () => { if (label !== active) setSubTab(page, row, label); });
    strip.appendChild(b);
  }
  return strip;
}

/**
 * The active page in LandShiny's layout (Jason, 2026-10-06): a row of map
 * tabs on top, a row of chart tabs below, each tab showing two side by
 * side at half the page width.
 */
/**
 * The Agricultural page's consistency bar: a cultivated-% band and chips for
 * the MASC ratings, CLI classes and dominant covers among the ticked sales.
 * No chip ticked means no filter on that attribute.
 */
function agConsBar() {
  const a = agConsSpec();
  const bar = document.createElement('section');
  bar.className = 'page-row ag-cons';
  const head = document.createElement('div');
  head.className = 'ag-cons-head';
  const h = document.createElement('strong');
  h.textContent = 'Ag consistency filters';
  const why = document.createElement('span');
  why.className = 'ag-cons-note';
  why.textContent = agConsActive()
    ? 'This page fits its own trend and time-adjustment rate on the sales that pass; the others are drawn hollow. Other pages are unaffected. Unknown values are kept.'
    : 'Narrow the set this page fits — its trend and its time-adjustment rate — without changing the other pages (R\'s CMSAG1).';
  head.append(h, why);
  if (agConsActive()) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ag-cons-clear';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => setOpt({ agCons: { cultLo: '', cultHi: '', masc: [], cli: [], cover: [] } }));
    head.appendChild(clear);
  }
  bar.appendChild(head);

  const patch = (p) => setOpt({ agCons: { ...(opts.agCons || {}), ...p } });
  const row = document.createElement('div');
  row.className = 'ag-cons-row';
  // Cultivated band.
  const cult = document.createElement('label');
  cult.className = 'ag-cons-cult';
  cult.append('Cultivated ');
  const lo = document.createElement('input');
  const hi = document.createElement('input');
  for (const [inp, key, val, ph] of [[lo, 'cultLo', a.cultLo, '0'], [hi, 'cultHi', a.cultHi, '100']]) {
    inp.type = 'number';
    inp.min = '0';
    inp.max = '100';
    inp.step = '5';
    inp.placeholder = ph;
    inp.value = val ?? '';
    inp.setAttribute('aria-label', key === 'cultLo' ? 'Lowest cultivated percent' : 'Highest cultivated percent');
    inp.addEventListener('change', () => patch({ [key]: inp.value }));
  }
  cult.append(lo, '–', hi, ' %');
  row.appendChild(cult);

  const ticked = activeRecords();
  const chipGroup = (label, key, values) => {
    if (!values.length) return;
    const g = document.createElement('span');
    g.className = 'ag-cons-group';
    const l = document.createElement('span');
    l.className = 'ag-cons-label';
    l.textContent = label;
    g.appendChild(l);
    for (const v of values) {
      const on = a[key].includes(v);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ag-chip${on ? ' is-on' : ''}`;
      b.textContent = v;
      b.setAttribute('aria-pressed', String(on));
      b.addEventListener('click', () => patch({ [key]: on ? a[key].filter((x) => x !== v) : [...a[key], v] }));
      g.appendChild(b);
    }
    row.appendChild(g);
  };
  const present = (f) => [...new Set(ticked.map(f).filter(Boolean).map(String))];
  chipGroup('MASC', 'masc', present((r) => mascKey(r)).filter((k) => k !== UNRATED)
    .sort((x, y) => MASC_ORDER.indexOf(x) - MASC_ORDER.indexOf(y)));
  chipGroup('CLI', 'cli', present((r) => r.ag?.cliClass).sort());
  chipGroup('Cover', 'cover', present((r) => r.ag?.coverLabel).sort());
  bar.appendChild(row);
  if (agConsActive()) {
    const kept = ticked.filter(agConsistent).length;
    const n = document.createElement('p');
    n.className = 'ag-cons-count';
    n.textContent = `${kept} of ${ticked.length} ticked sales pass: ${agConsWords()}.`;
    bar.appendChild(n);
  }
  return bar;
}

function renderPage() {
  const page = pageOf(opts.tab);
  return withPageUnit(page, () => {
    const out = [];
    if (page === 'ag') out.push(agConsBar());
    const mapTabs = PAGE_MAPS[page] || [];
    if (mapTabs.length) {
      const act = mapTabs.find((t) => t.label === subTab(page, 'map')) || mapTabs[0];
      const sec = document.createElement('section');
      sec.className = 'page-row page-maps';
      sec.append(rowTabStrip(page, 'map', mapTabs.map((t) => t.label), act.label, 'Maps'), mapRow(page, act.paint()));
      out.push(sec);
    }
    const groups = groupCharts(page, PAGE_BUILDERS[page]());
    if (groups.length) {
      const act = groups.find((g) => g.label === subTab(page, 'chart')) || groups[0];
      const sec = document.createElement('section');
      sec.className = 'page-row page-charts';
      const pair = document.createElement('div');
      pair.className = 'chart-pair';
      pair.append(...act.figs);
      sec.append(rowTabStrip(page, 'chart', groups.map((g) => g.label), act.label, 'Charts'), pair);
      out.push(sec);
    }
    return out;
  });
}

// ---------- table view ---------------------------------------------

/** The measures a tab trims on, for the table's Trimmed column. */
function trimMetricsForTab() {
  if (opts.tab === 'total') return [['price', 'Price'], ['ppl', '$/Lot']];
  if (['water', 'ag'].includes(opts.tab)) return [[areaMetric(), `$/${areaUnitLabel()}`]];
  return [[areaMetric(), `$/${areaUnitLabel()}`]];
}

const TABLE_COLS = [
  ['Status', (r) => {
    if (r.excluded) return 'Excluded';
    const trimmedOn = trimMetricsForTab()
      .filter(([m]) => cmsFor(m).stateOf(r) === 'trimmed')
      .map(([, label]) => label);
    return trimmedOn.length ? `Trimmed (${trimmedOn.join(', ')})` : 'In';
  }],
  ['S/A flag', (r) => {
    const f = saleAsmtFlag(r.flagRatio);
    return f && f !== 'No assessment' ? `${f} (${flagBasisWords(r)})` : (f || '—');
  }],
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
  const tagTh = document.createElement('th');
  tagTh.textContent = 'Tag';
  hr.insertBefore(tagTh, hr.firstChild);
  thead.appendChild(hr);

  // Every cell goes in via textContent — addresses, municipality names
  // and zoning codes all originate in a pasted CSV.
  for (const rec of drawnRecords()) {
    const tr = document.createElement('tr');
    if (rec.excluded) tr.className = 'is-excluded';
    // The tag toggles: Comp, Land Set 1, Land Set 2 — lit with the number
    // when the sale is in that list.
    const tagTd = document.createElement('td');
    tagTd.className = 'tag-cell';
    const key = saleTagKey(rec);
    for (const [list, short] of [['comps', 'C'], ['set1', 'L1'], ['set2', 'L2']]) {
      const n = tagNumber(tags, list, key);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tag-btn${n ? ' is-on' : ''}`;
      b.textContent = n ? `${short}${list === 'comps' ? '#' : '-'}${n}` : short;
      b.title = n ? `Remove from ${TAG_LIST_NAMES[list]}` : `Add to ${TAG_LIST_NAMES[list]}`;
      b.disabled = !key;
      b.addEventListener('click', () => toggleSaleTag(rec, list));
      tagTd.appendChild(b);
    }
    tr.appendChild(tagTd);
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
  // The grid's own count first, then the split (2026-10-07). "3 sales (1
  // excluded)" read as three in all when the grid beside it showed four —
  // the total and the ticked/unticked split are now both stated.
  const total = data.records.length;
  const sales = nExcluded > 0
    ? `${total} sales: ${n} ticked, ${nExcluded} unticked`
    : `${n} ${n === 1 ? 'sale' : 'sales'}`;
  const pc = data.meta.parcelCount;
  const parcels = pc != null ? ` · ${pc} ticked ${pc === 1 ? 'parcel' : 'parcels'}` : '';
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
function waterfallRows() {
  const wf = data.meta?.waterfall;
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
  if (opts.tab === 'ag' && agConsActive()) {
    const kept = activeRecords().filter(agConsistent).length;
    rows.push({ label: 'Ag consistency filters (Agricultural page only)', removed: nActive - kept, value: kept, note: agConsWords() });
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
  return rows;
}

function renderWaterfall() {
  const wf = data.meta?.waterfall;
  const body = els.waterfallBody;
  body.textContent = '';
  const nAll = data.records.length;
  const nActive = activeRecords().length;
  const rows = waterfallRows();

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

// ---------- comparables panel (charts Phase 2) ----------------------------

/** The current sale for each tag key (null when it is filtered out). */
function recordsByTag() {
  const m = new Map();
  for (const r of data.records || []) {
    const k = saleTagKey(r);
    if (k && !m.has(k)) m.set(k, r);
  }
  return m;
}

/**
 * The Comparables panel: each list in order with its number, the sale, its
 * adjusted rate, and buttons to reorder or remove it. A tag whose sale is not
 * in the current filter stays listed (greyed) — a filter change must not
 * quietly lose a comparable.
 */
function renderCompsPanel() {
  const body = els.compsBody;
  body.textContent = '';
  const byKey = recordsByTag();
  const metric = areaMetric();
  const adj = adjusterAlways(metric);
  const money = areaMoneyFmt();
  const total = TAG_LISTS.reduce((n, l) => n + tags[l].length, 0);
  els.compsSummary.textContent = total
    ? `Comparable sales — ${plural(tags.comps.length, 'comp')}`
      + `${tags.set1.length ? `, Land Set 1: ${tags.set1.length}` : ''}${tags.set2.length ? `, Land Set 2: ${tags.set2.length}` : ''}`
    : 'Comparable sales — none tagged';

  const hint = document.createElement('p');
  hint.className = 'comps-hint';
  hint.textContent = 'Shift-click a dot on any chart to tag it as the next comp; click a sale on a map for the Land Set buttons; '
    + 'or use the Tag column in Table view. Numbers show on every chart, map and PNG, and in the work file.';
  body.appendChild(hint);

  const button = (label, title, run, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', run);
    return b;
  };
  for (const list of TAG_LISTS) {
    if (!tags[list].length) continue;
    const sec = document.createElement('div');
    sec.className = 'comps-list';
    const h = document.createElement('h3');
    h.textContent = TAG_LIST_NAMES[list];
    sec.appendChild(h);
    const table = document.createElement('table');
    table.className = 'comps-table';
    tags[list].forEach((key, i) => {
      const rec = byKey.get(key);
      const info = tags.info[key] || {};
      const tr = document.createElement('tr');
      const cell = (txt, cls = '') => {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = txt ?? '';
        tr.appendChild(td);
        return td;
      };
      cell(list === 'comps' ? `#${i + 1}` : `${list === 'set1' ? 'L1' : 'L2'}-${i + 1}`, 'tag');
      cell(rec ? (rec.dateText || fmtDate(rec.dateMs)) : info.date);
      cell(rec ? (rec.address || (rec.rolls || []).join(', ')) : (info.address || key.split('@')[0]));
      cell(rec ? rec.muni : info.muni);
      if (rec) {
        cell(rec.price != null ? fmtMoney0(rec.price) : '—', 'num');
        const a = adj.adjusted ? adj.adjust(rec) : rec[metric];
        cell(Number.isFinite(a) ? `${money(a)}/${areaUnitLabel()}${adj.adjusted ? ' adj.' : ''}` : '—', 'num');
        if (rec.excluded) cell('unticked', 'gone');
        else cell('');
      } else {
        const td = cell('not in the current filter', 'gone');
        td.colSpan = 3;
      }
      const act = document.createElement('td');
      act.className = 'tag-cell';
      act.append(
        button('↑', 'Move up', () => saveTags(moveTag(tags, list, key, -1)), i === 0),
        button('↓', 'Move down', () => saveTags(moveTag(tags, list, key, 1)), i === tags[list].length - 1),
        button('×', 'Remove this tag', () => saveTags(removeTag(tags, list, key))),
      );
      tr.appendChild(act);
      table.appendChild(tr);
    });
    sec.appendChild(table);
    body.appendChild(sec);
  }

  if (total) {
    const actions = document.createElement('div');
    actions.className = 'comps-actions';
    actions.append(
      button('Copy comp roll numbers', 'Copy the comparables\' roll numbers, in comp order', () => {
        const txt = tags.comps.map((k, i) => `${i + 1}\t${k.split('@')[0].replace(/\+/g, ', ')}`).join('\n');
        navigator.clipboard?.writeText(txt).catch(() => {});
      }, !tags.comps.length),
      button('Clear all tags', 'Remove every comp and Land Set tag', () => {
        if (window.confirm('Remove every comparable and Land Set tag?')) saveTags(clearTags(tags));
      }),
    );
    body.appendChild(actions);
  }
}

// ---------- excluded records (charts Phase 3) -------------------------------

/**
 * The Excluded records panel: every unticked sale with a reason box
 * (suggestions, or free text) and a way back in. The reason saves on change
 * and does not redraw the page, so typing is never interrupted by a
 * republish from the main window.
 */
function renderExclPanel() {
  const body = els.exclBody;
  // Keep a reason being typed: a republish mid-entry must not wipe it.
  const active = document.activeElement;
  if (active && body.contains(active) && active.dataset.key) return;
  body.textContent = '';
  const excluded = (data.records || []).filter((r) => r.excluded)
    .sort((a, b) => (a.dateMs ?? 0) - (b.dateMs ?? 0));
  const summary = () => {
    const n = excluded.filter((r) => reasonOf(r)).length;
    els.exclSummary.textContent = excluded.length
      ? `Excluded records — ${plural(excluded.length, 'unticked sale')}, ${n} with a reason`
      : 'Excluded records — none';
  };
  summary();

  if (!excluded.length) {
    const p = document.createElement('p');
    p.className = 'comps-hint';
    p.textContent = 'Sales you untick in the grid, or by clicking a dot, are listed here so you can record why.';
    body.appendChild(p);
    return;
  }
  const list = document.createElement('datalist');
  list.id = 'excl-reason-list';
  for (const r of EXCLUSION_REASONS) {
    const o = document.createElement('option');
    o.value = r;
    list.appendChild(o);
  }
  body.appendChild(list);

  const metric = areaMetric();
  const money = areaMoneyFmt();
  const table = document.createElement('table');
  table.className = 'comps-table';
  let focusEl = null;
  for (const rec of excluded) {
    const key = saleTagKey(rec);
    const tr = document.createElement('tr');
    const cell = (txt, cls = '') => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = txt ?? '';
      tr.appendChild(td);
      return td;
    };
    cell(rec.dateText || fmtDate(rec.dateMs));
    cell(rec.address || (rec.rolls || []).join(', '));
    cell(rec.muni);
    cell(rec.price != null ? fmtMoney0(rec.price) : '—', 'num');
    cell(Number.isFinite(rec[metric]) ? `${money(rec[metric])}/${areaUnitLabel()}` : '—', 'num');
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'excl-reason';
    input.setAttribute('list', 'excl-reason-list');
    input.placeholder = key ? 'Reason (pick or type)' : 'No roll number to key on';
    input.maxLength = 200;
    input.disabled = !key;
    input.value = key ? reasons[key] || '' : '';
    input.setAttribute('aria-label', `Exclusion reason for ${rec.address || (rec.rolls || []).join(', ')}`);
    if (key) input.dataset.key = key;
    input.addEventListener('change', () => { setReason(key, input.value); summary(); });
    // Enter commits and leaves the box, so the next republish can redraw.
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); });
    td.appendChild(input);
    tr.appendChild(td);
    const act = document.createElement('td');
    act.className = 'tag-cell';
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Include again';
    back.title = 'Tick this sale back in, in the grid, the map and every chart';
    back.disabled = opts.frozen;
    back.addEventListener('click', () => restoreSales([rec]));
    act.appendChild(back);
    tr.appendChild(act);
    if (key && key === reasonPromptKey) { tr.classList.add('is-new'); focusEl = input; }
    table.appendChild(tr);
  }
  body.appendChild(table);
  if (focusEl) {
    reasonPromptKey = null;
    els.exclPanel.open = true;
    requestAnimationFrame(() => {
      focusEl.scrollIntoView({ block: 'nearest' });
      focusEl.focus({ preventScroll: true });
    });
  }
}

/** Money formatter matching a measure, for the trim band. */
function areaMoneyFmtFor(metric) {
  return metric === 'ppsf' ? fmtMoney2 : fmtMoney0;
}

function render() {
  // Every comparable set is rebuilt from the data and options of THIS
  // render; a cached trim from the last one would describe other sales.
  cmsCache = new Map();
  waterCache = new Map();
  setChartCompany(opts.company);
  setPointLabeler((rec) => tagLabel(tags, saleTagKey(rec)));
  renderStatus();

  const has = data.records.length > 0;
  els.empty.hidden = has;
  els.grid.hidden = !has;
  els.tablePanel.hidden = !has || !opts.showTable;
  els.waterfall.hidden = !has;
  els.compsPanel.hidden = !has;
  els.exclPanel.hidden = !has;
  els.workfileOpen.disabled = !has;

  if (!has) {
    els.grid.textContent = '';
    return;
  }
  renderWaterfall();
  renderCompsPanel();
  renderExclPanel();

  // Rebuild into a fragment and swap in one go, so a re-render on every
  // keystroke in the main window's filters doesn't flash an empty grid.
  const frag = document.createDocumentFragment();
  for (const el of renderPage()) frag.appendChild(el);
  els.grid.textContent = '';
  els.grid.appendChild(frag);

  if (opts.showTable) renderTable();
}

function syncControls() {
  // Tab state.
  const onTotal = opts.tab === 'total';
  const tab = pageOf(opts.tab);
  for (const [key, btn] of [['rates', els.tabRates], ['total', els.tabTotal], ['water', els.tabWater], ['ag', els.tabAg]]) {
    btn.setAttribute('aria-selected', String(tab === key));
    btn.classList.toggle('is-on', tab === key);
  }
  els.mapMunis.checked = opts.mapMunis !== false;
  // The size unit shows on every tab now: the Total price tab's Price per
  // Lot by Size chart takes its x-axis from it.
  els.ctlUnit.hidden = false;
  if (document.activeElement !== els.company) els.company.value = opts.company || '';
  // The Total price tab's measure, spelled out where it is chosen.
  const agOnAcres = tab === 'ag' && opts.unit === 'ff';
  els.tabNote.hidden = !(tab === 'total' || agOnAcres);
  els.tabNote.textContent = tab === 'total'
    ? `${TOTAL_PRICE_NOTE} Price per lot divides that price by the number of parcels in the sale, `
      + 'so a $600,000 sale of 3 lots shows as $600,000 on the Total price charts and $200,000 on the '
      + 'Price per Lot charts. For a single-parcel sale the two are the same.'
    : agOnAcres
      ? 'Front feet does not apply to farmland, so the Agricultural charts are shown per acre.'
      : '';
  // Name the charts the Nominal/Time-adjusted toggle actually reaches on
  // THIS tab.
  els.ratesHint.textContent = onTotal
    ? 'Applies to the by-size, by-distance and assessed-value charts.'
    : tab === 'water' || tab === 'ag'
      ? 'Applies to every price chart on this tab.'
      : 'Applies to the by-size and by-distance charts and the price heatmap.';

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

// ---------- work file (charts Phase 1) --------------------------------

/**
 * "Work file…" (Jason, 2026-10-06): one zip for the appraisal work file —
 * a PNG of each chart and map he ticks, the comparable set as CSV, and a
 * self-contained summary.html. The lighter, no-R path to what the land
 * template's exports give.
 *
 * Every tab is built OFF-SCREEN through the same builders the page draws
 * with (buildCharts under a temporarily switched opts.tab), and each PNG is
 * rendered from the spec its card registered (chartExportSpec) — so a chart
 * in the zip is the one its own PNG button gives, and nothing is re-derived.
 * The two maps are the exception: MapLibre has to paint, so the export
 * shows the Map tab, waits for both maps to go idle, captures, and puts
 * the previous tab back.
 */
const WORK_TABS = [
  ['rates', 'Land Price/Unit'],
  ['ag', 'Agricultural'],
  ['total', 'Total/Per Lot Price'],
  ['water', 'Water'],
];
const WORKFILE_KEY = 'mbps_charts_workfile_v1';

/** Item keys he has unticked. New charts default to ticked. */
function readWorkfileOff() {
  try {
    const v = JSON.parse(localStorage.getItem(WORKFILE_KEY) || 'null');
    return new Set(Array.isArray(v?.off) ? v.off : []);
  } catch { return new Set(); }
}
function writeWorkfileOff(off) {
  try { localStorage.setItem(WORKFILE_KEY, JSON.stringify({ off: [...off] })); } catch { /* private mode */ }
}

/**
 * Everything the work file could hold, in page order:
 *   {key, tab, tabLabel, title, kind: 'chart' | 'table' | 'map', spec, map, empty}
 * A chart with nothing to draw is listed (so its absence is explained) but
 * cannot be ticked.
 */
function workItems() {
  const items = [];
  // Each page built off-screen through its own builders, maps first as the
  // page shows them. Every map tab is painted, not only the active one, so
  // the list can say which have data; a painted map that is not on screen
  // only takes its data and fits when it is next shown.
  for (const [tab, tabLabel] of WORK_TABS) {
    const saved = opts.tab;
    opts.tab = tab;
    try {
      withPageUnit(tab, () => {
        for (const mt of PAGE_MAPS[tab] || []) {
          const apis = mt.paint();
          mt.keys.forEach((k, i) => items.push({
            key: `${tab}:map:${k}`, tab, tabLabel, title: apis[i].title(), kind: 'map', map: k, empty: !mapCounts.get(k),
          }));
        }
        for (const g of groupCharts(tab, PAGE_BUILDERS[tab]())) {
          for (const fig of g.figs) {
            const spec = chartExportSpec(fig);
            const title = spec?.title || fig.querySelector('h3')?.textContent || 'Chart';
            items.push({
              key: `${tab}:${slugify(title)}`, tab, tabLabel, title,
              kind: spec?.kind || 'chart', spec, empty: !spec,
            });
          }
        }
      });
    } finally { opts.tab = saved; }
  }
  // Two charts can share a title across a tab (a nominal and an adjusted
  // twin); keep the keys unique so ticking one never ticks the other.
  const seen = new Map();
  for (const it of items) {
    const n = (seen.get(it.key) || 0) + 1;
    seen.set(it.key, n);
    if (n > 1) it.key = `${it.key}~${n}`;
  }
  return items;
}

/** A blank-safe number for a CSV cell: finite or null. */
const num = (v) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const isoDate = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

/**
 * The adjuster in the current unit, on the page's adjustment basis (fitted
 * trend or stated %/yr), WHETHER OR NOT the Nominal/Time-adjusted toggle is
 * on — a work file wants the nominal and adjusted columns side by side.
 */
function adjusterAlways(metric) {
  const saved = opts.adjusted;
  opts.adjusted = true;
  try { return adjusterFor(cmsFor(metric)); } finally { opts.adjusted = saved; }
}

/** The sale columns of cms.csv and comps.csv: [label, raw value]. */
function saleCsvColumns() {
  const metric = areaMetric();
  const adj = adjusterAlways(metric);
  const cms = cmsFor(metric);
  const refWord = activeDistRef() === 'subject' ? 'subject' : 'Winnipeg';
  const unit = areaUnitLabel();
  const dp = metric === 'ppsf' ? 2 : 0;
  return [
    ['Comp #', (r) => tagNumber(tags, 'comps', saleTagKey(r))],
    ['Land set', (r) => [tagNumber(tags, 'set1', saleTagKey(r)) && `L1-${tagNumber(tags, 'set1', saleTagKey(r))}`,
      tagNumber(tags, 'set2', saleTagKey(r)) && `L2-${tagNumber(tags, 'set2', saleTagKey(r))}`].filter(Boolean).join('; ')],
    ['Exclusion reason', (r) => (r.excluded ? reasonOf(r) : '')],
    ['Status', (r) => {
      const st = cms.stateOf(r);
      return st === 'excluded' ? 'Excluded' : st === 'trimmed' ? 'Trimmed' : 'In';
    }],
    ['Sale date', (r) => isoDate(r.dateMs) || r.dateText || ''],
    ['Municipality', (r) => r.muni || ''],
    ['Address', (r) => r.address || ''],
    ['Roll numbers', (r) => (r.rolls || []).join('; ')],
    ['Parcels', (r) => num(r.parcelCount)],
    ['Sale type', (r) => r.saleType || ''],
    ['Price', (r) => num(r.price)],
    ['Lot acres', (r) => round(num(r.lotAcres), 3)],
    ['Lot sq ft', (r) => round(num(r.lotSf), 0)],
    ['Frontage ft', (r) => round(num(r.lotFrontFt), 1)],
    ['$/Lot', (r) => round(num(r.ppl), 0)],
    ['$/Acre', (r) => round(num(r.ppa), 0)],
    ['$/SF', (r) => round(num(r.ppsf), 2)],
    ['$/FF', (r) => round(num(r.ppff), 0)],
    [adj.adjusted ? `Adj $/${unit} at ${opts.effDate}` : `Adj $/${unit} (no adjustment)`,
      (r) => (adj.adjusted ? round(num(adj.adjust(r)), dp) : null)],
    ['Sale/Asmt', (r) => round(num(r.saleToAsmt), 3)],
    ['S/A flag', (r) => {
      const f = saleAsmtFlag(r.flagRatio);
      return f && f !== 'No assessment' ? `${f} (${flagBasisWords(r)})` : '';
    }],
    ['Zoning', (r) => r.zone || ''],
    [`Distance from ${refWord} (km)`, (r) => round(num(distanceFor(r)), 2)],
    ['Water', (r) => waterOf(r).group || ''],
    ['MASC', (r) => r.ag?.masc || ''],
    ['CLI', (r) => r.ag?.cli || ''],
    ['Soil', (r) => r.ag?.soil || ''],
  ];
}

/** The market-conditions table: CMS1, and CMS2 when the trim applies. */
function ratesTable() {
  const metric = areaMetric();
  const cms = cmsFor(metric);
  const fmt = areaMoneyFmtFor(metric);
  const adj = adjusterAlways(metric);
  const unit = areaUnitLabel();
  const med = (recs, f) => {
    const m = median(recs.map(f).filter((v) => Number.isFinite(v) && v > 0));
    return m != null ? fmt(m) : '—';
  };
  const row = (label, recs, mc) => [
    label,
    String(recs.length),
    med(recs, (r) => r[metric]),
    adj.adjusted ? med(recs, adj.adjust) : '—',
    mc ? `${mc.perDay >= 0 ? '+' : '−'}${fmtRate(Math.abs(mc.perDay))}` : '—',
    mc?.pctPerYear != null ? `${(mc.pctPerYear * 100).toFixed(1)}%` : '—',
  ];
  const rows = [row('CMS1 — ticked sales', cms.active, cms.mc1)];
  if (cms.applied) rows.push(row(`CMS2 — trimmed to ${trimWords()}`, cms.fitted, cms.mc));
  // The Agricultural page's own set and rate, when its filters are on and it
  // shares this unit (it draws per acre when the unit is front feet).
  if (agConsActive() && opts.tab !== 'ag' && opts.unit !== 'ff') {
    const saved = opts.tab;
    opts.tab = 'ag';
    try {
      const agCms = cmsFor(metric);
      const agAdj = adjusterAlways(metric);
      rows.push([
        `Ag set — ${agConsWords()}`, String(agCms.fitted.length),
        (() => { const m = median(agCms.fitted.map((r) => r[metric]).filter((v) => Number.isFinite(v) && v > 0)); return m != null ? fmt(m) : '—'; })(),
        agAdj.adjusted ? (() => { const m = median(agCms.fitted.map(agAdj.adjust).filter((v) => Number.isFinite(v) && v > 0)); return m != null ? fmt(m) : '—'; })() : '—',
        agCms.mc ? `${agCms.mc.perDay >= 0 ? '+' : '−'}${fmtRate(Math.abs(agCms.mc.perDay))}` : '—',
        agCms.mc?.pctPerYear != null ? `${(agCms.mc.pctPerYear * 100).toFixed(1)}%` : '—',
      ]);
    } finally { opts.tab = saved; }
  }
  return {
    columns: [
      { label: 'Set' }, { label: 'Sales', num: true }, { label: `Median $/${unit}`, num: true },
      { label: `Median adj $/${unit}`, num: true }, { label: '$/day trend', num: true }, { label: '%/yr', num: true },
    ],
    rows,
  };
}

/** Everything summary.html says besides the figures. */
function summaryModel() {
  const s = data.meta?.subject || null;
  const metric = areaMetric();
  const adj = adjusterAlways(metric);
  const cms = cmsFor(metric);
  const money = areaMoneyFmt();
  const n2 = (v, dp = 2) => (num(v) != null ? Number(v).toLocaleString('en-US', { maximumFractionDigits: dp }) : '');
  const saleRow = (r) => {
    const a = adj.adjusted ? adj.adjust(r) : null;
    const d = distanceFor(r);
    return [
      isoDate(r.dateMs) || r.dateText || '', r.muni || '', r.address || (r.rolls || []).join(', '),
      r.price != null ? fmtMoney0(r.price) : '—',
      r[sizeField()] != null ? n2(r[sizeField()]) : '—',
      r[metric] != null ? money(r[metric]) : '—',
      Number.isFinite(a) ? money(a) : '—',
      r.zone || '—',
      d != null ? fmtNum(d) : '—',
    ];
  };
  const saleCols = [
    { label: 'Sold' }, { label: 'Municipality' }, { label: 'Address / roll' }, { label: 'Price', num: true },
    { label: unitSpec().sizeTitle, num: true }, { label: `$/${areaUnitLabel()}`, num: true },
    { label: `Adj $/${areaUnitLabel()}`, num: true }, { label: 'Zoning' }, { label: 'Dist. km', num: true },
  ];
  const byDate = (x, y) => (x.dateMs ?? 0) - (y.dateMs ?? 0);
  const ovr = overrideRate();
  return {
    title: s?.roll ? `Sales work file — roll ${s.roll}` : 'Sales work file',
    company: opts.company || '',
    generated: new Date().toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }),
    build: typeof __APP_COMMIT__ !== 'undefined' ? `build ${__APP_COMMIT__}` : '',
    subject: s ? [
      ['Roll', s.roll],
      ['Address', s.address],
      ['Municipality', s.muni],
      ['Acres', Number(s.acres) > 0 ? n2(s.acres, 3) : ''],
      ['Frontage', Number(s.frontFt) > 0 ? `${n2(s.frontFt, 1)} ft` : ''],
    ] : null,
    settings: [
      ['Criteria', criteriaLine(cms, adj.adjusted)],
      ['Size unit', unitSpec().perUnit],
      ['Effective date', opts.effDate],
      ['Time adjustment', ovr != null ? `${(ovr * 100).toFixed(1)}% per year (judgement rate)`
        : cms.mc ? 'Fitted trend from the charted sales' : 'None (too few dated sales)'],
      ['Percentile trim', opts.trim ? trimWords() : 'Off'],
      ['Ag consistency (Agricultural page)', agConsActive() ? agConsWords() : 'Off'],
      ['Distance measured from', activeDistRef() === 'subject' ? 'the subject parcel' : 'Portage & Main, Winnipeg'],
    ],
    rates: ratesTable(),
    waterfall: {
      columns: [{ label: 'Step' }, { label: 'Removed', num: true }, { label: 'Sales left', num: true }, { label: '' }],
      rows: waterfallRows().map((r) => [
        r.label,
        r.removed != null ? `−${r.removed.toLocaleString('en-US')}` : '',
        Number.isFinite(r.value) ? r.value.toLocaleString('en-US') : '',
        r.note || '',
      ]),
    },
    tagged: TAG_LISTS.map((list) => {
      const byKey = recordsByTag();
      return {
        title: TAG_LIST_NAMES[list],
        columns: [{ label: '#' }, ...saleCols],
        rows: tags[list].map((k, i) => {
          const r = byKey.get(k);
          const n = list === 'comps' ? String(i + 1) : `${list === 'set1' ? 'L1' : 'L2'}-${i + 1}`;
          const info = tags.info[k] || {};
          return r ? [n, ...saleRow(r)]
            : [n, info.date || '', info.muni || '', `${info.address || k.split('@')[0]} (not in the current filter)`, '', '', '', '', '', ''];
        }),
      };
    }).filter((t) => t.rows.length),
    comps: { columns: saleCols, rows: activeRecords().slice().sort(byDate).map(saleRow) },
    excluded: {
      columns: [...saleCols, { label: 'Reason' }],
      rows: (data.records || []).filter((r) => r.excluded).sort(byDate).map((r) => [...saleRow(r), reasonOf(r) || '—']),
    },
  };
}

/** A Blob as a data: URL, for embedding a PNG in summary.html. */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/**
 * Show each tab that holds a wanted map, let its maps paint, capture them,
 * and put the original tab back. A map that never finished drawing (a
 * hidden window gets no animation frames) is captured as it stands, and
 * the status line says so.
 */
async function captureMaps(which, onStep) {
  const prev = { tab: opts.tab, subTabs: opts.subTabs };
  const out = { incomplete: false };
  // One stop per page + map tab, showing it as the reader would.
  const stops = new Map();
  for (const k of which) {
    const home = MAP_HOME[k];
    const id = `${home.page}|${home.label}`;
    if (!stops.has(id)) stops.set(id, { ...home, keys: [] });
    stops.get(id).keys.push(k);
  }
  try {
    for (const stop of stops.values()) {
      const all = { ...(opts.subTabs || {}) };
      all[stop.page] = { ...(all[stop.page] || {}), map: stop.label };
      setOpt({ tab: stop.page, subTabs: all });
      onStep('Waiting for the maps to draw…');
      const drawn = await Promise.all(stop.keys.map((k) => pageMap(k).whenIdle()));
      if (drawn.includes(false)) out.incomplete = true;
      for (const k of stop.keys) out[k] = await pageMap(k).pngBlob();
    }
    return out;
  } finally {
    setOpt(prev);
  }
}

/**
 * Build and download the zip. Everything is snapshotted up front — the
 * items, the CSV rows, the summary text — so a republish from the main
 * window mid-export cannot mix two sets of sales in one work file.
 */
async function buildWorkFile(selected, onStep) {
  const enc = new TextEncoder();
  const items = workItems().filter((it) => !it.empty && selected.has(it.key));
  const cols = saleCsvColumns();
  const labels = cols.map(([l]) => l);
  const csvRows = (recs) => recs.map((r) => cols.map(([, get]) => get(r)));
  const all = (data.records || []).slice().sort((x, y) => (x.dateMs ?? 0) - (y.dateMs ?? 0));
  // comps.csv is the tagged comparables in comp order (charts Phase 2); with
  // none tagged it falls back to every ticked sale, as Phase 1 wrote it.
  const byKey = recordsByTag();
  const tagged = tags.comps.map((k) => byKey.get(k)).filter(Boolean);
  const files = [
    { name: 'cms.csv', data: enc.encode(toCsv(labels, csvRows(all))) },
    { name: 'comps.csv', data: enc.encode(toCsv(labels, csvRows(tags.comps.length ? tagged : all.filter((r) => !r.excluded)))) },
  ];
  const excludedRecs = all.filter((r) => r.excluded);
  if (excludedRecs.length) files.push({ name: 'excluded.csv', data: enc.encode(toCsv(labels, csvRows(excludedRecs))) });
  for (const list of ['set1', 'set2']) {
    const recs = tags[list].map((k) => byKey.get(k)).filter(Boolean);
    if (recs.length) files.push({ name: `land-set-${list.slice(-1)}.csv`, data: enc.encode(toCsv(labels, csvRows(recs))) });
  }
  const model = summaryModel();
  const figures = [];

  // Maps first, while nothing else has moved.
  const mapWant = new Set(items.filter((it) => it.kind === 'map').map((it) => it.map));
  const maps = mapWant.size ? await captureMaps(mapWant, onStep) : {};

  const nImages = items.filter((it) => it.kind !== 'table').length;
  let images = 0;
  let tables = 0;
  for (const [idx, it] of items.entries()) {
    if (it.kind === 'table') {
      const name = `tables/${figureFileName(idx, it.tabLabel, it.title, 'csv')}`;
      files.push({ name, data: enc.encode(toCsv(it.spec.columns.map((c) => c.label), it.spec.rows)) });
      figures.push({ ...it.spec, tabLabel: it.tabLabel, title: it.title, kind: 'table' });
      tables += 1;
      continue;
    }
    onStep(`Rendering image ${images + 1} of ${nImages}…`);
    const png = it.kind === 'map' ? maps[it.map] : await renderChartPng(it.spec);
    if (!png) continue;
    files.push({ name: `charts/${figureFileName(idx, it.tabLabel, it.title, 'png')}`, data: new Uint8Array(await png.arrayBuffer()) });
    figures.push({ tabLabel: it.tabLabel, title: it.title, kind: 'image', src: await blobToDataUrl(png) });
    images += 1;
  }

  onStep('Writing the zip…');
  files.unshift({ name: 'summary.html', data: enc.encode(buildSummaryHtml({ ...model, figures })) });
  const zip = buildStoreZip(files);
  downloadBlob(zip, workFileName(data.meta?.subject?.roll, todayLocal()));
  return { images, tables, bytes: zip.size, mapsIncomplete: !!maps.incomplete };
}

function selectedWorkKeys() {
  return new Set([...els.workfileList.querySelectorAll('input[data-key]:checked')].map((b) => b.dataset.key));
}

function syncWorkfileButton() {
  const n = selectedWorkKeys().size;
  els.workfileGo.textContent = n ? `Download zip (${n} item${n === 1 ? '' : 's'})` : 'Download zip (CSV + summary only)';
}

/** The dialog's list: one fieldset per tab, a checkbox per chart. */
function renderWorkfileList() {
  const off = readWorkfileOff();
  const items = workItems();
  const list = els.workfileList;
  list.textContent = '';
  for (const [tab, tabLabel] of WORK_TABS) {
    const group = items.filter((it) => it.tab === tab);
    if (!group.length) continue;
    const fs = document.createElement('fieldset');
    fs.className = 'workfile-group';
    const legend = document.createElement('legend');
    const allLabel = document.createElement('label');
    const all = document.createElement('input');
    all.type = 'checkbox';
    const allText = document.createElement('span');
    allLabel.append(all, allText);
    legend.appendChild(allLabel);
    fs.appendChild(legend);

    const boxes = [];
    for (const it of group) {
      const label = document.createElement('label');
      label.className = 'workfile-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.key = it.key;
      cb.disabled = it.empty;
      cb.checked = !it.empty && !off.has(it.key);
      const t = document.createElement('span');
      t.textContent = it.title + (it.kind === 'table' ? ' (table)' : '');
      label.append(cb, t);
      if (it.empty) {
        label.classList.add('is-empty');
        const why = document.createElement('span');
        why.className = 'workfile-why';
        why.textContent = 'no data';
        label.appendChild(why);
      } else {
        boxes.push(cb);
      }
      fs.appendChild(label);
    }
    const syncAll = () => {
      const on = boxes.filter((b) => b.checked).length;
      all.checked = boxes.length > 0 && on === boxes.length;
      all.indeterminate = on > 0 && on < boxes.length;
      all.disabled = !boxes.length;
      allText.textContent = `${tabLabel} (${on} of ${boxes.length})`;
    };
    const save = () => {
      const cur = readWorkfileOff();
      for (const b of boxes) { if (b.checked) cur.delete(b.dataset.key); else cur.add(b.dataset.key); }
      writeWorkfileOff(cur);
      syncAll();
      syncWorkfileButton();
    };
    for (const b of boxes) b.addEventListener('change', save);
    all.addEventListener('change', () => { for (const b of boxes) b.checked = all.checked; save(); });
    syncAll();
    list.appendChild(fs);
  }
  syncWorkfileButton();
}

els.workfileOpen.addEventListener('click', () => {
  if (!data.records.length) return;
  els.workfileStatus.textContent = '';
  renderWorkfileList();
  els.workfileDialog.showModal();
});
els.workfileGo.addEventListener('click', async () => {
  els.workfileGo.disabled = true;
  try {
    const res = await buildWorkFile(selectedWorkKeys(), (msg) => { els.workfileStatus.textContent = msg; });
    els.workfileStatus.textContent = `Downloaded: ${res.images} image${res.images === 1 ? '' : 's'}`
      + `${res.tables ? `, ${res.tables} table${res.tables === 1 ? '' : 's'}` : ''}, summary.html, cms.csv and comps.csv`
      + ` (${(res.bytes / 1048576).toFixed(1)} MB).`
      + (res.mapsIncomplete ? ' The maps had not finished drawing, so their images may be blank — keep this window in front and try again.' : '');
  } catch (err) {
    console.warn('Work file export failed', err);
    els.workfileStatus.textContent = `Export failed: ${err?.message || err}`;
  } finally {
    els.workfileGo.disabled = false;
  }
});

// ---------- wiring ---------------------------------------------------

function setOpt(patch) {
  Object.assign(opts, patch);
  writeOpts();
  syncControls();
  render();
}

els.tabRates.addEventListener('click', () => setOpt({ tab: 'rates' }));
els.tabTotal.addEventListener('click', () => setOpt({ tab: 'total' }));
els.tabWater.addEventListener('click', () => setOpt({ tab: 'water' }));
els.company.addEventListener('input', () => setOpt({ company: els.company.value.trim() }));
els.tabAg.addEventListener('click', () => setOpt({ tab: 'ag' }));
els.mapMunis.addEventListener('change', () => setOpt({ mapMunis: els.mapMunis.checked }));
els.unitAcres.addEventListener('click', () => setOpt({ unit: 'acres' }));
els.unitSf.addEventListener('click', () => setOpt({ unit: 'sf' }));
els.unitFf.addEventListener('click', () => setOpt({ unit: 'ff' }));
// Both 'input' and 'change': a date field fires 'change' only once the
// whole date is valid, and on some platforms not until blur. Listening to
// 'input' as well means the charts follow as soon as a usable date
// exists. effectiveMs() ignores anything that isn't a full YYYY-MM-DD, so
// half-typed dates are harmless.
for (const evt of ['input', 'change']) {
  els.effDate.addEventListener(evt, () => setOpt({ effDate: els.effDate.value, effDatePinned: false }));
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
