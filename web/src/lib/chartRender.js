/*
 * A small scatter-plot renderer for the Sales Charts tab.
 *
 * Hand-rolled inline SVG rather than a charting library, for three
 * reasons: the production CSP is `script-src 'self'` with no eval, so
 * nothing can be pulled from a CDN; the app already hand-rolls its map
 * legend and image output, so this matches; and the charts have to
 * reproduce a specific ggplot recipe (points + an OLS line + a cubic,
 * with reference lines) that a general-purpose library would fight.
 *
 * Everything is drawn into a fixed 760x400 viewBox scaled to the
 * container width, so one set of type sizes works at any card width.
 *
 * The look — fonts, point size and colour, line styles, the zoning Set2
 * palette — follows Jason's R land template (see R_STYLE), by his choice
 * (2026-09-22), so the website and the report charts read as one. That
 * palette puts up to eight zone colours on one scatter, more than a
 * colourblind all-pairs test passes; the tooltip and table carry the
 * zone code for every point.
 *
 * Untrusted text — addresses, zone codes, municipality names, all of it
 * out of a pasted CSV — is inserted with textContent, never innerHTML.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export const INK = {
  surface: '#fcfcfb',
  primary: '#0b0b0b',
  secondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
};

/**
 * The look of Jason's R land template (Jason, 2026-09-22: "resemble the R
 * project charts as much as possible"). The template shows its echarts
 * build on screen and uses ggplot for PNGs; values are the echarts ones,
 * with ggplot's filling the places echarts leaves at library defaults
 * (gridlines, tick labels, axis titles). Sources, all in
 * appraisal-templates: base-files/helpers.R ec_live_scatter (~5792-6047)
 * and land/LandStatic.qmd theme_custom / point themes (788-902).
 */
export const R_STYLE = {
  font: 'Arial, Helvetica, sans-serif',
  bg: '#ffffff',
  title: '#8B0000',          // red4, bold
  subtitle: '#333333',
  tick: '#4D4D4D',           // grey30, theme_minimal's tick text
  axisTitle: '#000000',      // bold
  grid: '#D3D3D3',           // lightgray hairlines
  pointFill: '#63B8FF',      // steelblue1
  pointStroke: '#36648B',    // steelblue4
  pointOpacity: 0.6,
  pointR: 4.5,               // echarts symbolSize 9
  zoneStroke: '#404040',     // grey25, on the zoning-coloured chart
  zoneOpacity: 0.75,
  excludedFill: '#cccccc',   // a clicked-off point
  excludedStroke: '#bbbbbb',
  excludedOpacity: 0.4,
  linear: '#000000',
  cubic: '#8B0000',
  power: '#9932CC',          // darkorchid, dotted
  subject: '#1C86EE',        // dodgerblue2
  caption: '#8B0000',        // the ggplot caption: red4 bold, right-aligned
};

/** Zoning palette: RColorBrewer Set2, in rank order, as the template's
 *  top-8 ZoningTop; everything past eight folds into Other. */
export const ZONE_COLORS = ['#66C2A5', '#FC8D62', '#8DA0CB', '#E78AC3', '#A6D854', '#FFD92F', '#E5C494', '#B3B3B3'];
/** Default series colour first, so `SERIES_COLORS[0]` still means "a point". */
export const SERIES_COLORS = [R_STYLE.pointFill, ...ZONE_COLORS];
export const OTHER_COLOR = '#9e9e9e';
/** A sale unticked in the grid: drawn, clickable, fitted by nothing. */
export const EXCLUDED_COLOR = R_STYLE.excludedFill;

const VB_W = 760;
const VB_H = 400;
// Room for the template-sized axis text (ggplot 10pt at the 6.5in export
// width is ~15 viewBox units) and full-dollar tick labels.
const PAD = { top: 16, right: 20, bottom: 56, left: 96 };

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, String(v));
  }
  return node;
}

/** SVG text node. Content is set via textContent — never markup. */
function text(str, attrs = {}) {
  const node = el('text', attrs);
  node.textContent = str;
  return node;
}

// ---------- scales -------------------------------------------------

/**
 * "Nice" round tick values spanning [lo, hi] — the 1/2/2.5/5/10 ladder.
 * Returns `{ticks, lo, hi}` with the bounds widened to the outer ticks
 * so the axis starts and ends on a round number.
 */
export function niceTicks(lo, hi, target = 6) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ticks: [], lo: 0, hi: 1 };
  if (hi === lo) {
    const pad = Math.abs(hi) || 1;
    lo -= pad; hi += pad;
  }
  const raw = (hi - lo) / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks = [];
  // Index multiplication rather than `t += step` (which compounds error),
  // AND a round to the step's own precision — on a $/SF axis the step is
  // 0.05 and even `start + 3 * 0.05` lands on 0.15000000000000002, which
  // would print verbatim as an axis label.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const count = Math.round((end - start) / step);
  for (let i = 0; i <= count; i++) {
    ticks.push(Number((start + i * step).toFixed(decimals)));
  }
  return { ticks, lo: start, hi: end };
}

const MS_DAY = 86400000;

/**
 * Date-axis ticks on month boundaries. The interval follows the same
 * ladder the QMD uses (`date_break_interval`): 3 months under 1.5 years
 * of span, 6 months under 3, 12 under 6, 24 beyond — so an in-app chart
 * and its QMD counterpart break at the same places.
 */
export function dateTicks(loMs, hiMs) {
  if (!Number.isFinite(loMs) || !Number.isFinite(hiMs) || hiMs < loMs) {
    return { ticks: [], lo: loMs, hi: hiMs, format: (d) => String(d) };
  }
  const years = (hiMs - loMs) / (365 * MS_DAY);
  const stepMonths = years <= 1.5 ? 3 : years <= 3 ? 6 : years <= 6 ? 12 : 24;
  const showMonth = years <= 3;

  const start = new Date(loMs);
  // Back up to the previous multiple-of-step month boundary.
  const startMonth = Math.floor(start.getUTCMonth() / stepMonths) * stepMonths;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), startMonth, 1));
  const ticks = [];
  // Hard cap: a corrupt date (year 1900 against year 2100) would
  // otherwise spin here for millions of iterations and hang the tab.
  while (cursor.getTime() <= hiMs && ticks.length < 200) {
    ticks.push(cursor.getTime());
    cursor.setUTCMonth(cursor.getUTCMonth() + stepMonths);
  }
  ticks.push(cursor.getTime()); // one past the end, so the axis closes on a boundary
  const fmt = new Intl.DateTimeFormat('en-CA', showMonth
    ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
    : { year: 'numeric', timeZone: 'UTC' });
  return {
    ticks,
    lo: ticks[0],
    hi: ticks[ticks.length - 1],
    format: (ms) => fmt.format(new Date(ms)),
  };
}

// ---------- formatting ---------------------------------------------

export const fmtMoney0 = (n) => (Number.isFinite(n)
  ? `$${Math.round(n).toLocaleString('en-US')}` : '—');
export const fmtMoney2 = (n) => (Number.isFinite(n)
  ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');
export const fmtNum = (n) => (Number.isFinite(n)
  ? n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 0 }) : '—');
export const fmtDate = (ms) => (Number.isFinite(ms)
  ? new Date(ms).toISOString().slice(0, 10) : '—');

/** Compact axis money: $1.2M / $450K / $85. Keeps the y-axis narrow
 *  enough that the plot area isn't eaten by six-digit tick labels. */
export function fmtAxisMoney(n) {
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })}M`;
  if (abs >= 1e4) return `$${Math.round(n / 1e3).toLocaleString('en-US')}K`;
  if (abs >= 100) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (abs >= 1) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** Full-dollar axis labels, the template's scales::dollar: "$12,345", no
 *  K/M. Cents only where the steps need them ($/SF). */
export function fmtAxisDollar(n) {
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const cents = abs > 0 && abs < 10 && !Number.isInteger(n);
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

/** Comma-grouped axis numbers, the template's number_format(big.mark=","). */
export function fmtAxisComma(n) {
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 10 ? 1 : 0 });
}

/** ggplot's %b-%Y date label: "Jan-2024". */
const MON_FMT = new Intl.DateTimeFormat('en-CA', { month: 'short', timeZone: 'UTC' });
export function fmtMonYear(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${MON_FMT.format(d).replace('.', '')}-${d.getUTCFullYear()}`;
}

/** Compact axis count: 1.2M / 450K / 85. */
export function fmtAxisNum(n) {
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })}M`;
  if (abs >= 1e4) return `${Math.round(n / 1e3).toLocaleString('en-US')}K`;
  return n.toLocaleString('en-US', { maximumFractionDigits: abs < 10 ? 2 : 0 });
}

// ---------- PNG export -----------------------------------------------

/**
 * Greedy word wrap by estimated width. SVG text does not wrap, and the
 * export has no layout engine to ask, so this budgets ~0.55em per
 * character — generous for system-ui, so a line never runs off the image.
 */
export function wrapText(str, fontPx, maxW) {
  const words = String(str || '').split(/\s+/).filter(Boolean);
  const maxChars = Math.max(10, Math.floor(maxW / (fontPx * 0.55)));
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > maxChars && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** A file-name stem from a chart title: "Price per acre by lot size" →
 *  "price-per-acre-by-lot-size". */
export function slugify(str) {
  return String(str || 'chart').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'chart';
}

const EXPORT_STYLE = [
  `text { font-family: ${R_STYLE.font}; }`,
  '.chart-tick { font-size: 14px; }',
  '.chart-axis-title { font-size: 15px; font-weight: 700; }',
  '.chart-ref-label { font-size: 14px; }',
].join('\n');

/** The template exports at 6.5in wide x 300 dpi; the image is rasterized
 *  to that width. */
const EXPORT_PX_WIDTH = 1950;

/**
 * Compose one chart as a standalone SVG — title, subtitle, the plot, legend
 * and stat figures — and rasterize it to a PNG download at 2x.
 *
 * Built from the chart's own spec rather than by screenshotting the card, so
 * the image carries no hover ring, tooltip or PNG button, and every string
 * goes in through textContent: addresses and zone codes are pasted-CSV text.
 */
export function exportChartPng({ svg, title, subtitle, legend, stats, note, filename }) {
  const W = VB_W;
  const M = 16;
  const root = el('svg', { xmlns: SVG_NS, width: W, viewBox: '' });
  const style = el('style');
  style.textContent = EXPORT_STYLE;
  root.appendChild(style);
  const bg = el('rect', { x: 0, y: 0, width: W, fill: R_STYLE.bg });
  root.appendChild(bg);

  // The template's title and subtitle: red4 bold, then the criteria line.
  let y = M + 14;
  root.appendChild(text(title || '', {
    x: M, y, 'font-size': 16, 'font-weight': 700, fill: R_STYLE.title,
  }));
  for (const line of wrapText(subtitle, 12, W - 2 * M)) {
    y += 17;
    root.appendChild(text(line, { x: M, y, 'font-size': 12, fill: R_STYLE.subtitle }));
  }
  y += 8;

  // The plot itself, cloned so the live chart keeps its listeners, minus
  // the hover highlight ring (the last circle with pointer-events none).
  const plot = svg.cloneNode(true);
  for (const n of plot.querySelectorAll('[pointer-events="none"]')) n.remove();
  plot.removeAttribute('class');
  plot.removeAttribute('tabindex');
  plot.setAttribute('x', '0');
  plot.setAttribute('y', String(y));
  plot.setAttribute('width', String(VB_W));
  // The plot's own height: scatters are VB_H tall, box plots grow a row per
  // group. Forcing VB_H would squash a box plot into the wrong aspect.
  const plotH = Number(String(svg.getAttribute('viewBox') || '').split(/\s+/)[3]) || VB_H;
  plot.setAttribute('height', String(plotH));
  root.appendChild(plot);
  y += plotH + 6;

  if (legend && legend.length > 1) {
    let x = M;
    y += 14;
    for (const item of legend) {
      const w = 28 + String(item.label).length * 6.2;
      if (x + w > W - M && x > M) { x = M; y += 18; }
      if (item.dot) {
        const pale = item.dot === 'pale';
        root.appendChild(el('circle', {
          cx: x + 6, cy: y - 4, r: 4.5,
          fill: pale ? R_STYLE.excludedFill
            : item.dot === 'hollow' ? R_STYLE.bg
              : item.dot === 'swatch' ? item.color : R_STYLE.pointFill,
          stroke: item.dot === 'ring' ? INK.primary
            : pale ? R_STYLE.excludedStroke : item.stroke || R_STYLE.pointStroke,
          'stroke-width': item.dot === 'ring' ? 1.75 : 1,
        }));
      } else {
        root.appendChild(el('line', {
          x1: x, x2: x + 14, y1: y - 4, y2: y - 4,
          stroke: item.color || INK.primary, 'stroke-width': 3,
          'stroke-dasharray': item.dash ? '4 3' : null,
        }));
      }
      root.appendChild(text(item.label, { x: x + 20, y, 'font-size': 11.5, fill: INK.secondary }));
      x += w;
    }
  }

  if (note) {
    y += 6;
    for (const line of wrapText(note, 10, W - 2 * M)) {
      y += 14;
      root.appendChild(text(line, { x: M, y, 'font-size': 10, fill: INK.muted }));
    }
  }

  // The figures as the template's caption: red4 bold, right-aligned,
  // "Label: value; Label: value".
  if (stats && stats.length) {
    const statLine = stats.map((s) => `${s.label}: ${s.value}`).join('; ');
    y += 8;
    for (const line of wrapText(statLine, 10, W - 2 * M)) {
      y += 15;
      root.appendChild(text(line, {
        x: W - M, y, 'font-size': 10, 'font-weight': 700, 'text-anchor': 'end', fill: R_STYLE.caption,
      }));
    }
  }

  const H = Math.ceil(y + M);
  root.setAttribute('height', String(H));
  root.setAttribute('viewBox', `0 0 ${W} ${H}`);
  bg.setAttribute('height', String(H));

  const xml = new XMLSerializer().serializeToString(root);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = EXPORT_PX_WIDTH / W;
        const canvas = document.createElement('canvas');
        canvas.width = W * scale;
        canvas.height = H * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, W, H);
        URL.revokeObjectURL(url);
        canvas.toBlob((png) => {
          if (!png) { reject(new Error('canvas produced no image')); return; }
          const a = document.createElement('a');
          const href = URL.createObjectURL(png);
          a.href = href;
          a.download = `${filename}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(href), 2000);
          resolve();
        }, 'image/png');
      } catch (err) { URL.revokeObjectURL(url); reject(err); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG failed to load as an image')); };
    img.src = url;
  });
}

// ---------- the chart ----------------------------------------------

/**
 * Draw one scatter chart.
 *
 * spec:
 *   title, subtitle       — strings (subtitle carries the criteria line)
 *   points                — [{x, y, r, colorIndex, rec}]
 *   xIsDate               — date axis vs numeric
 *   xLabel, yLabel
 *   yFormat               — full-precision formatter for tooltip/labels
 *   yAxisFormat           — compact formatter for ticks
 *   xFormat, xAxisFormat  — same pair for x (numeric axes only)
 *   fits                  — [{predict, color, dash, label}] drawn as paths
 *   refLines              — [{x|y, label}] dashed annotations
 *   legend                — [{label, color}] (omitted for a single series)
 *   tooltipRows(rec, pt)  — [[label, value], …] for the hover readout
 *   empty                 — message shown when there's nothing to plot
 *   onPointClick(rec, pt) — click / Enter on a point; omitted = not clickable
 *   pngName               — file stem for the PNG button; omitted = no button
 *
 * A point may carry `state`: 'in' (default — fitted), 'trimmed' (outside
 * the percentile band: drawn hollow, fitted by nothing) or 'excluded'
 * (unticked in the grid: drawn pale). And `flagged`: a dark ring, for a
 * sale whose sale/assessment ratio is out of line. The CALLER fits only
 * the 'in' points; this only draws them differently, and keeps the fitted
 * curves inside the span of the 'in' points.
 *
 * Returns a <figure> element. The caller appends it; nothing here
 * touches the document outside the returned subtree.
 */
export function drawChart(spec) {
  const {
    title, subtitle, points = [], xIsDate = false,
    xLabel = '', yLabel = '',
    yFormat = fmtMoney0, yAxisFormat = fmtAxisMoney,
    xFormat = fmtNum, xAxisFormat = fmtAxisNum,
    fits = [], refLines = [], legend = null, stats = [],
    tooltipRows = () => [],
    empty = 'No sales in the current filter carry the values this chart needs.',
    onPointClick = null,
    pngName = '',
    // Explanatory notes (adjustment basis, trim, what the toggle reaches).
    // Kept OUT of the subtitle, which carries the template's criteria line.
    note = '',
  } = spec;

  /** The figures the QMD puts in its caption (median, daily change,
   *  annual %), rendered as a compact strip so they're readable without
   *  the full report chrome. */
  function statStrip() {
    if (!stats.length) return null;
    const dl = document.createElement('dl');
    dl.className = 'chart-stats';
    for (const s of stats) {
      const dt = document.createElement('dt');
      dt.textContent = s.label;
      const dd = document.createElement('dd');
      dd.textContent = s.value;
      if (s.title) { dt.title = s.title; dd.title = s.title; }
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    return dl;
  }

  const figure = document.createElement('figure');
  figure.className = 'chart-card';

  const cap = document.createElement('figcaption');
  const h = document.createElement('h3');
  h.textContent = title || '';
  cap.appendChild(h);
  if (subtitle) {
    const sub = document.createElement('p');
    sub.className = 'chart-sub';
    sub.textContent = subtitle;
    cap.appendChild(sub);
  }
  figure.appendChild(cap);

  const usable = points.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (!usable.length) {
    const none = document.createElement('p');
    none.className = 'chart-empty';
    none.textContent = empty;
    figure.appendChild(none);
    const strip = statStrip();
    if (strip) figure.appendChild(strip);
    return figure;
  }

  // ---- domains. y always includes 0, matching the QMD's
  // limits = c(0, NA): a $/acre axis that starts at $8,000 exaggerates
  // every wiggle into a trend.
  let xLo = Infinity, xHi = -Infinity, yHi = -Infinity;
  for (const p of usable) {
    if (p.x < xLo) xLo = p.x;
    if (p.x > xHi) xHi = p.x;
    if (p.y > yHi) yHi = p.y;
  }
  // The span the fitted curves may cover: the points they were fitted TO.
  // An excluded or trimmed sale out at the edge widens the axis so it can
  // be seen and clicked back in, but a curve carried out to it would be an
  // extrapolation over evidence the fit deliberately left out.
  let fitLo = Infinity, fitHi = -Infinity;
  for (const p of usable) {
    if ((p.state || 'in') !== 'in') continue;
    if (p.x < fitLo) fitLo = p.x;
    if (p.x > fitHi) fitHi = p.x;
  }
  if (!(fitHi >= fitLo)) { fitLo = xLo; fitHi = xHi; }
  for (const r of refLines) {
    if (Number.isFinite(r?.x)) { xLo = Math.min(xLo, r.x); xHi = Math.max(xHi, r.x); }
    if (Number.isFinite(r?.y)) yHi = Math.max(yHi, r.y);
  }

  const xScaleInfo = xIsDate ? dateTicks(xLo, xHi) : niceTicks(xLo, xHi, 6);
  const yScaleInfo = niceTicks(0, yHi, 6);
  // Dates as the template's ggplot labels them ("Jan-2024"); dateTicks still
  // decides WHERE the breaks fall.
  const xFmtTick = xIsDate ? fmtMonYear : xAxisFormat;

  const plotW = VB_W - PAD.left - PAD.right;
  const plotH = VB_H - PAD.top - PAD.bottom;
  const xSpan = (xScaleInfo.hi - xScaleInfo.lo) || 1;
  const ySpan = (yScaleInfo.hi - yScaleInfo.lo) || 1;
  const sx = (x) => PAD.left + ((x - xScaleInfo.lo) / xSpan) * plotW;
  const sy = (y) => PAD.top + plotH - ((y - yScaleInfo.lo) / ySpan) * plotH;

  const svg = el('svg', {
    viewBox: `0 0 ${VB_W} ${VB_H}`,
    class: 'chart-svg',
    role: 'img',
    tabindex: '0',
    'aria-label': `${title}. ${usable.length} sales. Use arrow keys to step through points.`,
  });

  // ---- gridlines: solid hairlines one step off the surface. Never
  // dashed — a dashed grid reads as a threshold when it is just a grid.
  // White plot panel, as both template builds draw on white.
  svg.appendChild(el('rect', {
    x: 0, y: 0, width: VB_W, height: VB_H, fill: R_STYLE.bg,
  }));
  // Gridlines: the template's theme_custom — lightgray hairlines both ways,
  // no axis lines.
  const grid = el('g');
  for (const t of yScaleInfo.ticks) {
    grid.appendChild(el('line', {
      x1: PAD.left, x2: PAD.left + plotW, y1: sy(t), y2: sy(t),
      stroke: R_STYLE.grid, 'stroke-width': 0.75,
    }));
  }
  for (const t of xScaleInfo.ticks) {
    if (t < xScaleInfo.lo || t > xScaleInfo.hi) continue;
    grid.appendChild(el('line', {
      x1: sx(t), x2: sx(t), y1: PAD.top, y2: PAD.top + plotH,
      stroke: R_STYLE.grid, 'stroke-width': 0.75,
    }));
  }
  svg.appendChild(grid);

  for (const t of yScaleInfo.ticks) {
    svg.appendChild(text(yAxisFormat(t), {
      x: PAD.left - 8, y: sy(t) + 5, 'text-anchor': 'end',
      class: 'chart-tick', fill: R_STYLE.tick,
    }));
  }
  for (const t of xScaleInfo.ticks) {
    if (t < xScaleInfo.lo || t > xScaleInfo.hi) continue;
    // A label on the last tick sits at the right edge of the viewBox; centred
    // there, "Jan-2028" runs half off the image. Anchor it inward instead.
    const atRightEdge = sx(t) > VB_W - PAD.right - 30;
    svg.appendChild(text(xFmtTick(t), {
      x: sx(t), y: PAD.top + plotH + 22, 'text-anchor': atRightEdge ? 'end' : 'middle',
      class: 'chart-tick', fill: R_STYLE.tick,
    }));
  }
  if (xLabel) {
    svg.appendChild(text(xLabel, {
      x: PAD.left + plotW / 2, y: VB_H - 10, 'text-anchor': 'middle',
      class: 'chart-axis-title', fill: R_STYLE.axisTitle,
    }));
  }
  if (yLabel) {
    svg.appendChild(text(yLabel, {
      x: 18, y: PAD.top + plotH / 2, 'text-anchor': 'middle',
      class: 'chart-axis-title', fill: R_STYLE.axisTitle,
      transform: `rotate(-90 18 ${PAD.top + plotH / 2})`,
    }));
  }

  // ---- reference lines (median, subject size). Dashed on purpose:
  // these ARE thresholds, which is exactly what a dashed rule should
  // mean once the grid itself is solid.
  for (const ref of refLines) {
    if (Number.isFinite(ref?.y)) {
      const y = sy(ref.y);
      if (y < PAD.top || y > PAD.top + plotH) continue;
      svg.appendChild(el('line', {
        x1: PAD.left, x2: PAD.left + plotW, y1: y, y2: y,
        stroke: INK.muted, 'stroke-width': 1, 'stroke-dasharray': '4 3',
      }));
      if (ref.label) {
        svg.appendChild(text(ref.label, {
          x: PAD.left + plotW - 4, y: y - 5, 'text-anchor': 'end',
          class: 'chart-ref-label', fill: INK.muted,
        }));
      }
    }
    if (Number.isFinite(ref?.x)) {
      const x = sx(ref.x);
      if (x < PAD.left || x > PAD.left + plotW) continue;
      // The template's subject markLine: dashed, width 2, bold label in
      // the line's own colour.
      svg.appendChild(el('line', {
        x1: x, x2: x, y1: PAD.top, y2: PAD.top + plotH,
        stroke: ref.color || INK.muted, 'stroke-width': 2, 'stroke-dasharray': '6 4',
      }));
      if (ref.label) {
        svg.appendChild(text(ref.label, {
          x: x + 5, y: PAD.top + 12, 'text-anchor': 'start', 'font-weight': 700,
          class: 'chart-ref-label', fill: ref.color || INK.muted,
        }));
      }
    }
  }

  // ---- fitted curves, sampled across the visible x range and clipped
  // to the y domain so a cubic that dives below zero at the edges
  // doesn't paint over the axis.
  // Trendlines are collected here and appended AFTER the dots below, so the
  // fitted line reads ON TOP of the scatter (Jason, 2026-08-18). Painted
  // before the dots, a fit vanished into a dense cloud exactly where it
  // matters most — the part of the range carrying the most sales.
  const trendLines = el('g');
  for (const fit of fits) {
    if (typeof fit?.predict !== 'function') continue;
    const STEPS = 96;
    const segs = [];
    let run = [];
    for (let i = 0; i <= STEPS; i++) {
      const x = xScaleInfo.lo + (xSpan * i) / STEPS;
      // Only draw across the span the FITTED data covers — extrapolating
      // a cubic into the empty margin invents a trend nobody measured.
      if (x < fitLo || x > fitHi) { if (run.length > 1) segs.push(run); run = []; continue; }
      const y = fit.predict(x);
      if (!Number.isFinite(y) || y < yScaleInfo.lo || y > yScaleInfo.hi) {
        if (run.length > 1) segs.push(run);
        run = [];
        continue;
      }
      run.push(`${sx(x).toFixed(2)},${sy(y).toFixed(2)}`);
    }
    if (run.length > 1) segs.push(run);
    for (const seg of segs) {
      trendLines.appendChild(el('polyline', {
        points: seg.join(' '),
        fill: 'none',
        stroke: fit.color || INK.primary,
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-dasharray': fit.dash || null,
      }));
    }
  }

  // ---- points. A 2px ring in the surface colour keeps overlapping
  // dots legible without drawing a border around each mark.
  // Painted excluded → trimmed → in, so the evidence the fit actually used
  // is never hidden under a dot it ignored.
  const dots = el('g');
  const LAYER = { excluded: 0, trimmed: 1, in: 2 };
  const placed = usable.map((p) => ({ ...p, cx: sx(p.x), cy: sy(p.y) }));
  const paintOrder = placed.slice()
    .sort((a, b) => (LAYER[a.state || 'in'] ?? 2) - (LAYER[b.state || 'in'] ?? 2));
  for (const p of paintOrder) {
    const state = p.state || 'in';
    const color = p.color || R_STYLE.pointFill;
    const stroke = p.stroke || R_STYLE.pointStroke;
    let attrs;
    if (state === 'excluded') {
      // The template's greyed-out clicked point.
      attrs = {
        fill: R_STYLE.excludedFill, stroke: R_STYLE.excludedStroke,
        'stroke-width': 0.75, opacity: R_STYLE.excludedOpacity,
      };
    } else if (state === 'trimmed') {
      // Hollow: still the same kind of sale, but outside the band the fit
      // was taken over. (The template has no drawn state for this.)
      attrs = { fill: R_STYLE.bg, 'fill-opacity': 1, stroke, 'stroke-width': 1.5 };
    } else {
      // The template's point: steelblue1 fill, steelblue4 edge, 0.6 alpha.
      attrs = {
        fill: color, 'fill-opacity': p.opacity ?? R_STYLE.pointOpacity,
        stroke, 'stroke-width': 0.75,
      };
    }
    // A flagged sale keeps its fill and trades its edge for a heavy dark
    // ring — visible at a glance without another colour.
    if (p.flagged && state !== 'excluded') {
      attrs.stroke = INK.primary;
      attrs['stroke-width'] = 1.75;
    }
    const c = el('circle', {
      cx: p.cx.toFixed(2), cy: p.cy.toFixed(2), r: p.r || R_STYLE.pointR, ...attrs,
    });
    dots.appendChild(c);
    p.node = c;
  }
  svg.appendChild(dots);
  // Above the dots by construction — see the note where trendLines is built.
  svg.appendChild(trendLines);

  figure.appendChild(svg);
  appendChartFooter(figure, {
    svg, title, subtitle, legend, stats, note, pngName, strip: statStrip(),
  });
  wirePointInteraction({ figure, svg, cap, placed, tooltipRows, onPointClick });
  return figure;
}

/**
 * Legend, note, stat strip and PNG button under a chart. Shared by the
 * scatter (drawChart) and the box plot (drawBoxChart) so the two read, and
 * export, alike.
 */
function appendChartFooter(figure, { svg, title, subtitle, legend, stats, note, pngName, strip }) {
  if (legend && legend.length > 1) {
    const key = document.createElement('ul');
    key.className = 'chart-legend';
    for (const item of legend) {
      const li = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'chart-key';
      if (item.dot) {
        // A point-state key ('pale' / 'hollow' / 'ring') — drawn as the dot
        // it describes rather than as a line.
        swatch.classList.add('chart-key-dot', `chart-key-dot-${item.dot}`);
        if (item.dot === 'swatch') {
          // A category's own dot (the zoning chart), as the template's
          // legend keys are points, not lines.
          swatch.style.background = item.color;
          swatch.style.borderColor = item.stroke || R_STYLE.zoneStroke;
        } else if (item.color) {
          swatch.style.borderColor = item.color;
        }
      } else {
        swatch.style.background = item.color;
      }
      if (item.dash) swatch.classList.add('chart-key-dashed');
      const label = document.createElement('span');
      label.textContent = item.label;
      li.appendChild(swatch);
      li.appendChild(label);
      key.appendChild(li);
    }
    figure.appendChild(key);
  }

  if (note) {
    const p = document.createElement('p');
    p.className = 'chart-note';
    p.textContent = note;
    figure.appendChild(p);
  }

  if (strip) figure.appendChild(strip);

  // ---- PNG export (the land template's per-chart PNG, for a report).
  if (pngName) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chart-png-btn';
    btn.textContent = 'PNG';
    btn.title = 'Download this chart as a PNG image';
    btn.addEventListener('click', () => {
      exportChartPng({ svg, title, subtitle, legend, stats, note, filename: pngName })
        .catch((err) => {
          console.warn('Chart PNG export failed', err);
          btn.textContent = 'Failed';
          setTimeout(() => { btn.textContent = 'PNG'; }, 2000);
        });
    });
    figure.appendChild(btn);
  }

}

/**
 * Hover readout, click-to-exclude and keyboard stepping over a chart's
 * placed points ({cx, cy, rec, …} in viewBox units). Shared by the scatter
 * and the box plot.
 */
function wirePointInteraction({ figure, svg, cap, placed, tooltipRows = () => [], onPointClick = null }) {
  // Highlight ring for the hovered/focused point, drawn above everything.
  const highlight = el('circle', {
    r: 9, fill: 'none', stroke: INK.primary, 'stroke-width': 2, opacity: 0,
    'pointer-events': 'none',
  });
  svg.appendChild(highlight);

  // ---- hover / focus readout.
  //
  // A nearest-point layer rather than per-dot hit targets: an 8px dot is
  // a pinpoint nobody lands on, and these plots get dense enough that
  // padded per-dot targets would overlap anyway. The pointer only has to
  // be CLOSEST, not on the mark.
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  figure.appendChild(tip);

  const byX = placed.slice().sort((a, b) => a.cx - b.cx);
  let activeIdx = -1;

  function showPoint(idx, anchorClientRect) {
    const p = byX[idx];
    if (!p) return;
    activeIdx = idx;
    highlight.setAttribute('cx', p.cx.toFixed(2));
    highlight.setAttribute('cy', p.cy.toFixed(2));
    highlight.setAttribute('opacity', '1');

    tip.textContent = '';
    for (const [label, value] of tooltipRows(p.rec, p)) {
      const rowEl = document.createElement('div');
      rowEl.className = 'chart-tip-row';
      const v = document.createElement('strong');
      v.textContent = value;
      const l = document.createElement('span');
      l.textContent = label;
      // Values lead, labels follow — the reader already knows which
      // point they are on and wants the number.
      rowEl.appendChild(v);
      rowEl.appendChild(l);
      tip.appendChild(rowEl);
    }
    tip.hidden = false;

    // Position in figure-local pixels, flipping left of the point when
    // it would otherwise run off the right edge.
    const rect = anchorClientRect || svg.getBoundingClientRect();
    const scale = rect.width / VB_W;
    const px = p.cx * scale;
    const py = p.cy * scale;
    const capH = cap.offsetHeight || 0;
    tip.style.left = `${px}px`;
    tip.style.top = `${capH + py}px`;
    tip.classList.toggle('flip-x', px > rect.width * 0.6);
    tip.classList.toggle('flip-y', py < 90);
  }

  function hide() {
    activeIdx = -1;
    highlight.setAttribute('opacity', '0');
    tip.hidden = true;
  }

  /** Index into byX of the point nearest the pointer, or -1 beyond the
   *  slack. Shared by hover and click so a click always acts on the point
   *  the tooltip is showing. */
  function nearest(e, rect) {
    const scale = VB_W / rect.width;
    const mx = (e.clientX - rect.left) * scale;
    const my = (e.clientY - rect.top) * scale;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < byX.length; i++) {
      const d = (byX[i].cx - mx) ** 2 + (byX[i].cy - my) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    // ~40 viewBox units of slack: close enough to be aiming at a point,
    // far enough that sweeping empty plot area doesn't flash a tooltip.
    return best >= 0 && bestD <= 40 * 40 ? best : -1;
  }

  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const idx = nearest(e, rect);
    if (idx >= 0) showPoint(idx, rect);
    else hide();
  });
  if (typeof onPointClick === 'function') {
    svg.classList.add('is-clickable');
    svg.addEventListener('click', (e) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const idx = nearest(e, rect);
      if (idx >= 0) onPointClick(byX[idx].rec, byX[idx]);
    });
  }
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && activeIdx >= 0 && typeof onPointClick === 'function') {
      e.preventDefault();
      onPointClick(byX[activeIdx].rec, byX[activeIdx]);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = activeIdx < 0
        ? 0
        : Math.min(byX.length - 1, Math.max(0, activeIdx + (e.key === 'ArrowRight' ? 1 : -1)));
      showPoint(next, null);
    } else if (e.key === 'Escape') {
      hide();
    }
  });

}

// ---------- box plot -------------------------------------------------

/**
 * Horizontal box plot, one row per group, with every sale jittered over its
 * box — the template's ec_live_box_h / geom_boxplot + geom_jitter. Rows run
 * top to bottom in the order given.
 *
 * spec:
 *   title, subtitle, note, stats, legend, pngName — as drawChart
 *   groups       [{label, stats: boxStats(), points: [{v, rec, state, flagged}]}]
 *   valueLabel   the value axis title
 *   valueFormat  full-precision formatter (median labels)
 *   axisFormat   tick formatter
 *   tooltipRows, onPointClick — as drawChart
 *   empty        message when no group has a value
 *
 * Boxes and whiskers are drawn from each group's `stats` (the caller fits
 * them to the 'in' points only); points in other states are drawn as the
 * scatter draws them, so an excluded sale is visible and clickable.
 */
export function drawBoxChart(spec) {
  const {
    title, subtitle = '', note = '', stats = [], legend = null, pngName = '',
    groups = [], valueLabel = '', valueFormat = fmtMoney0, axisFormat = fmtAxisDollar,
    tooltipRows = () => [], onPointClick = null,
    empty = 'No sales in the current filter carry the values this chart needs.',
  } = spec;

  const figure = document.createElement('figure');
  figure.className = 'chart-card';
  const cap = document.createElement('figcaption');
  const h = document.createElement('h3');
  h.textContent = title || '';
  cap.appendChild(h);
  if (subtitle) {
    const sub = document.createElement('p');
    sub.className = 'chart-sub';
    sub.textContent = subtitle;
    cap.appendChild(sub);
  }
  figure.appendChild(cap);

  const rows = groups.filter((g) => g.points?.length);
  if (!rows.length) {
    const none = document.createElement('p');
    none.className = 'chart-empty';
    none.textContent = empty;
    figure.appendChild(none);
    return figure;
  }

  const LEFT = 200;       // room for the group labels
  // Long names ("Winnipeg River / Rivière Winnipeg") are cut to fit; the
  // hover card names the full water body for every point.
  const MAX_LABEL = 22;
  const clip = (s) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);
  const ROW_H = 46;
  const TOP = 20;
  const BOTTOM = 56;
  const H = TOP + rows.length * ROW_H + BOTTOM;
  const plotW = VB_W - LEFT - PAD.right;

  let vHi = 0;
  for (const g of rows) for (const p of g.points) if (p.v > vHi) vHi = p.v;
  // Four ticks, not six: the value axis is narrower than a scatter's (the
  // labels take its left), and full-dollar labels like "$1,200,000" collide
  // at six.
  const scale = niceTicks(0, vHi, 4);
  const span = (scale.hi - scale.lo) || 1;
  const sx = (v) => LEFT + ((v - scale.lo) / span) * plotW;
  const rowY = (i) => TOP + i * ROW_H + ROW_H / 2;
  const plotBottom = TOP + rows.length * ROW_H;

  const svg = el('svg', {
    viewBox: `0 0 ${VB_W} ${H}`,
    class: 'chart-svg',
    role: 'img',
    tabindex: '0',
    'aria-label': `${title}. ${rows.length} groups. Use arrow keys to step through points.`,
  });
  svg.appendChild(el('rect', { x: 0, y: 0, width: VB_W, height: H, fill: R_STYLE.bg }));

  // Vertical gridlines + value ticks.
  for (const t of scale.ticks) {
    svg.appendChild(el('line', {
      x1: sx(t), x2: sx(t), y1: TOP, y2: plotBottom,
      stroke: R_STYLE.grid, 'stroke-width': 0.75,
    }));
    svg.appendChild(text(axisFormat(t), {
      x: sx(t), y: plotBottom + 22, 'text-anchor': sx(t) > VB_W - PAD.right - 30 ? 'end' : 'middle',
      class: 'chart-tick', fill: R_STYLE.tick,
    }));
  }
  if (valueLabel) {
    svg.appendChild(text(valueLabel, {
      x: LEFT + plotW / 2, y: H - 10, 'text-anchor': 'middle',
      class: 'chart-axis-title', fill: R_STYLE.axisTitle,
    }));
  }

  const placed = [];
  rows.forEach((g, i) => {
    const cy = rowY(i);
    // Group label with its count, right-aligned against the plot.
    svg.appendChild(text(`${clip(String(g.label))} (${g.stats?.n ?? 0})`, {
      x: LEFT - 10, y: cy + 5, 'text-anchor': 'end', class: 'chart-tick', fill: R_STYLE.axisTitle,
    }));
    const st = g.stats;
    if (st) {
      const bh = ROW_H * 0.5;
      // Whisker line and caps.
      svg.appendChild(el('line', {
        x1: sx(st.whiskerLo), x2: sx(st.whiskerHi), y1: cy, y2: cy,
        stroke: R_STYLE.pointStroke, 'stroke-width': 1.25,
      }));
      for (const w of [st.whiskerLo, st.whiskerHi]) {
        svg.appendChild(el('line', {
          x1: sx(w), x2: sx(w), y1: cy - bh * 0.35, y2: cy + bh * 0.35,
          stroke: R_STYLE.pointStroke, 'stroke-width': 1.25,
        }));
      }
      svg.appendChild(el('rect', {
        x: sx(st.q1), y: cy - bh / 2, width: Math.max(1, sx(st.q3) - sx(st.q1)), height: bh,
        fill: g.color || R_STYLE.pointFill, 'fill-opacity': 0.3,
        stroke: R_STYLE.pointStroke, 'stroke-width': 1.25,
      }));
      // Median bar in the template's red4, with its value above the box.
      svg.appendChild(el('line', {
        x1: sx(st.median), x2: sx(st.median), y1: cy - bh / 2, y2: cy + bh / 2,
        stroke: R_STYLE.cubic, 'stroke-width': 2.5,
      }));
      svg.appendChild(text(valueFormat(st.median), {
        x: sx(st.median), y: cy - bh / 2 - 4, 'text-anchor': 'middle',
        class: 'chart-ref-label', 'font-weight': 700, fill: R_STYLE.cubic,
      }));
    }
    // Jittered sale points. Deterministic jitter (from the sale id) so a
    // re-render on every filter keystroke does not make the dots dance.
    for (const p of g.points) {
      const jitter = (hashUnit(String(p.rec?.saleId ?? p.v)) - 0.5) * ROW_H * 0.45;
      placed.push({ ...p, cx: sx(p.v), cy: cy + jitter });
    }
  });

  const LAYER = { excluded: 0, trimmed: 1, in: 2 };
  const dots = el('g');
  const order = placed.slice()
    .sort((a, b) => (LAYER[a.state || 'in'] ?? 2) - (LAYER[b.state || 'in'] ?? 2));
  for (const p of order) {
    const state = p.state || 'in';
    let attrs;
    if (state === 'excluded') {
      attrs = {
        fill: R_STYLE.excludedFill, stroke: R_STYLE.excludedStroke,
        'stroke-width': 0.75, opacity: R_STYLE.excludedOpacity,
      };
    } else if (state === 'trimmed') {
      attrs = { fill: R_STYLE.bg, stroke: R_STYLE.pointStroke, 'stroke-width': 1.5 };
    } else {
      attrs = {
        fill: R_STYLE.pointFill, 'fill-opacity': R_STYLE.pointOpacity,
        stroke: R_STYLE.pointStroke, 'stroke-width': 0.75,
      };
    }
    if (p.flagged && state !== 'excluded') { attrs.stroke = INK.primary; attrs['stroke-width'] = 1.75; }
    dots.appendChild(el('circle', { cx: p.cx.toFixed(2), cy: p.cy.toFixed(2), r: 4, ...attrs }));
  }
  svg.appendChild(dots);

  figure.appendChild(svg);
  appendChartFooter(figure, {
    svg, title, subtitle, legend, stats, note, pngName, strip: statStripEl(stats),
  });
  wirePointInteraction({ figure, svg, cap, placed, tooltipRows, onPointClick });
  return figure;
}

/** A stable pseudo-random number in [0, 1) from a string (FNV-1a). */
function hashUnit(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** The stat strip as a standalone element (drawChart builds its own). */
function statStripEl(stats) {
  if (!stats?.length) return null;
  const dl = document.createElement('dl');
  dl.className = 'chart-stats';
  for (const s of stats) {
    const dt = document.createElement('dt');
    dt.textContent = s.label;
    const dd = document.createElement('dd');
    dd.textContent = s.value;
    if (s.title) { dt.title = s.title; dd.title = s.title; }
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  return dl;
}

// ---------- table card -----------------------------------------------

/**
 * A chart-card holding a small table — the water tab's summary, premium
 * and paired-sales tables sit in the same grid as the charts. Cells go in
 * through textContent.
 *
 *   columns  [{label, num?}]      rows [[cell, …]]
 */
export function drawTableCard({ title, subtitle = '', note = '', columns = [], rows = [], empty = 'Nothing to show.' }) {
  const figure = document.createElement('figure');
  figure.className = 'chart-card table-card';
  const cap = document.createElement('figcaption');
  const h = document.createElement('h3');
  h.textContent = title || '';
  cap.appendChild(h);
  if (subtitle) {
    const sub = document.createElement('p');
    sub.className = 'chart-sub';
    sub.textContent = subtitle;
    cap.appendChild(sub);
  }
  figure.appendChild(cap);
  if (!rows.length) {
    const none = document.createElement('p');
    none.className = 'chart-empty';
    none.textContent = empty;
    figure.appendChild(none);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    const table = document.createElement('table');
    table.className = 'card-table';
    const trh = document.createElement('tr');
    for (const c of columns) {
      const th = document.createElement('th');
      th.textContent = c.label;
      if (c.num) th.className = 'num';
      trh.appendChild(th);
    }
    table.createTHead().appendChild(trh);
    const tb = table.createTBody();
    for (const r of rows) {
      const tr = document.createElement('tr');
      r.forEach((cell, i) => {
        const td = document.createElement('td');
        td.textContent = cell ?? '';
        if (columns[i]?.num) td.className = 'num';
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    }
    wrap.appendChild(table);
    figure.appendChild(wrap);
  }
  if (note) {
    const p = document.createElement('p');
    p.className = 'chart-note';
    p.textContent = note;
    figure.appendChild(p);
  }
  return figure;
}
