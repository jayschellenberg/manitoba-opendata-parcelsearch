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
 * Colours come from the validated categorical palette; only the first
 * THREE series slots are used, because a scatter puts every pair of
 * series adjacent to every other and only those three clear the
 * colourblind-separation floor under that all-pairs test.
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

/** Categorical slots 1-3 plus the fold-to-Other gray. */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a'];
export const OTHER_COLOR = '#898781';
/** A sale unticked in the grid: drawn, clickable, fitted by nothing. Lighter
 *  than OTHER_COLOR so an excluded dot never reads as the "Other" series. */
export const EXCLUDED_COLOR = '#c3c2b7';

const VB_W = 760;
const VB_H = 400;
const PAD = { top: 16, right: 18, bottom: 46, left: 74 };

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
  'text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }',
  '.chart-tick { font-size: 10.5px; }',
  '.chart-axis-title { font-size: 11.5px; font-weight: 600; }',
  '.chart-ref-label { font-size: 10.5px; }',
].join('\n');

/**
 * Compose one chart as a standalone SVG — title, subtitle, the plot, legend
 * and stat figures — and rasterize it to a PNG download at 2x.
 *
 * Built from the chart's own spec rather than by screenshotting the card, so
 * the image carries no hover ring, tooltip or PNG button, and every string
 * goes in through textContent: addresses and zone codes are pasted-CSV text.
 */
export function exportChartPng({ svg, title, subtitle, legend, stats, filename }) {
  const W = VB_W;
  const M = 16;
  const root = el('svg', { xmlns: SVG_NS, width: W, viewBox: '' });
  const style = el('style');
  style.textContent = EXPORT_STYLE;
  root.appendChild(style);
  const bg = el('rect', { x: 0, y: 0, width: W, fill: INK.surface });
  root.appendChild(bg);

  let y = M + 14;
  root.appendChild(text(title || '', {
    x: M, y, 'font-size': 16, 'font-weight': 600, fill: INK.primary,
  }));
  for (const line of wrapText(subtitle, 11, W - 2 * M)) {
    y += 16;
    root.appendChild(text(line, { x: M, y, 'font-size': 11, fill: INK.muted }));
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
  plot.setAttribute('height', String(VB_H));
  root.appendChild(plot);
  y += VB_H + 6;

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
          fill: pale ? EXCLUDED_COLOR : item.dot === 'hollow' ? INK.surface : SERIES_COLORS[0],
          stroke: item.dot === 'ring' ? INK.primary : item.color || EXCLUDED_COLOR,
          'stroke-width': 1.5,
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

  if (stats && stats.length) {
    const statLine = stats.map((s) => `${s.label}: ${s.value}`).join('   ·   ');
    y += 8;
    for (const line of wrapText(statLine, 12, W - 2 * M)) {
      y += 17;
      root.appendChild(text(line, { x: M, y, 'font-size': 12, 'font-weight': 600, fill: INK.primary }));
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
        const scale = 2;
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
  const xFmtTick = xIsDate ? xScaleInfo.format : xAxisFormat;

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
  const grid = el('g');
  for (const t of yScaleInfo.ticks) {
    grid.appendChild(el('line', {
      x1: PAD.left, x2: PAD.left + plotW, y1: sy(t), y2: sy(t),
      stroke: INK.grid, 'stroke-width': 1,
    }));
  }
  for (const t of xScaleInfo.ticks) {
    if (t < xScaleInfo.lo || t > xScaleInfo.hi) continue;
    grid.appendChild(el('line', {
      x1: sx(t), x2: sx(t), y1: PAD.top, y2: PAD.top + plotH,
      stroke: INK.grid, 'stroke-width': 1,
    }));
  }
  svg.appendChild(grid);

  // ---- axes
  svg.appendChild(el('line', {
    x1: PAD.left, x2: PAD.left + plotW, y1: PAD.top + plotH, y2: PAD.top + plotH,
    stroke: INK.axis, 'stroke-width': 1,
  }));
  svg.appendChild(el('line', {
    x1: PAD.left, x2: PAD.left, y1: PAD.top, y2: PAD.top + plotH,
    stroke: INK.axis, 'stroke-width': 1,
  }));

  for (const t of yScaleInfo.ticks) {
    svg.appendChild(text(yAxisFormat(t), {
      x: PAD.left - 8, y: sy(t) + 4, 'text-anchor': 'end',
      class: 'chart-tick', fill: INK.muted,
    }));
  }
  for (const t of xScaleInfo.ticks) {
    if (t < xScaleInfo.lo || t > xScaleInfo.hi) continue;
    svg.appendChild(text(xFmtTick(t), {
      x: sx(t), y: PAD.top + plotH + 18, 'text-anchor': 'middle',
      class: 'chart-tick', fill: INK.muted,
    }));
  }
  if (xLabel) {
    svg.appendChild(text(xLabel, {
      x: PAD.left + plotW / 2, y: VB_H - 8, 'text-anchor': 'middle',
      class: 'chart-axis-title', fill: INK.secondary,
    }));
  }
  if (yLabel) {
    svg.appendChild(text(yLabel, {
      x: 14, y: PAD.top + plotH / 2, 'text-anchor': 'middle',
      class: 'chart-axis-title', fill: INK.secondary,
      transform: `rotate(-90 14 ${PAD.top + plotH / 2})`,
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
      svg.appendChild(el('line', {
        x1: x, x2: x, y1: PAD.top, y2: PAD.top + plotH,
        stroke: ref.color || INK.muted, 'stroke-width': 1.5, 'stroke-dasharray': '5 3',
      }));
      if (ref.label) {
        svg.appendChild(text(ref.label, {
          x: x + 5, y: PAD.top + 12, 'text-anchor': 'start',
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
    const color = p.color || SERIES_COLORS[0];
    let attrs;
    if (state === 'excluded') {
      attrs = { fill: EXCLUDED_COLOR, 'fill-opacity': 0.55, stroke: INK.surface, 'stroke-width': 1.5 };
    } else if (state === 'trimmed') {
      // Hollow in the series colour: still the same kind of sale, but
      // outside the band the fit was taken over.
      attrs = { fill: INK.surface, 'fill-opacity': 1, stroke: color, 'stroke-width': 1.75 };
    } else {
      attrs = { fill: color, 'fill-opacity': 0.72, stroke: INK.surface, 'stroke-width': 2 };
    }
    // A flagged sale keeps its fill and trades the surface ring for a dark
    // one — visible at a glance without a fourth colour.
    if (p.flagged && state !== 'excluded') {
      attrs.stroke = INK.primary;
      attrs['stroke-width'] = 1.5;
    }
    const c = el('circle', {
      cx: p.cx.toFixed(2), cy: p.cy.toFixed(2), r: p.r || 4, ...attrs,
    });
    dots.appendChild(c);
    p.node = c;
  }
  svg.appendChild(dots);
  // Above the dots by construction — see the note where trendLines is built.
  svg.appendChild(trendLines);

  // Highlight ring for the hovered/focused point, drawn above both.
  const highlight = el('circle', {
    r: 9, fill: 'none', stroke: INK.primary, 'stroke-width': 2, opacity: 0,
    'pointer-events': 'none',
  });
  svg.appendChild(highlight);

  figure.appendChild(svg);

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
        if (item.color) swatch.style.borderColor = item.color;
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

  const strip = statStrip();
  if (strip) figure.appendChild(strip);

  // ---- PNG export (the land template's per-chart PNG, for a report).
  if (pngName) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chart-png-btn';
    btn.textContent = 'PNG';
    btn.title = 'Download this chart as a PNG image';
    btn.addEventListener('click', () => {
      exportChartPng({ svg, title, subtitle, legend, stats, filename: pngName })
        .catch((err) => {
          console.warn('Chart PNG export failed', err);
          btn.textContent = 'Failed';
          setTimeout(() => { btn.textContent = 'PNG'; }, 2000);
        });
    });
    figure.appendChild(btn);
  }

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

  return figure;
}
