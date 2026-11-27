// Assessed-value history for one roll: expand the change-point encoding of
// the assessment-history shards (r/build_assessment_history.R) into a yearly
// series, summarise it, and draw it as a small inline SVG. Pure; tested in
// test/assessmentHistory.test.js. Used by the parcel summary card, the
// as-of-date popup and the preliminary report.
//
// Shard rows are [year, land, buildings] at the years a value CHANGED, plus
// the roll's first and last year; total = land + buildings. Manitoba freezes
// values between reassessments, so carrying each point forward is exact.
//
// Assessed values only. These are not tax amounts.

/** Yearly series [{year, land, buildings, total}] from change points. */
export function expandHistory(points) {
  if (!Array.isArray(points) || !points.length) return [];
  const pts = [...points].filter((p) => Array.isArray(p) && Number.isFinite(p[0])).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const [y, land, buildings] = pts[i];
    const until = i + 1 < pts.length ? pts[i + 1][0] - 1 : y;
    for (let yr = y; yr <= until; yr++) out.push({ year: yr, land, buildings, total: land + buildings });
  }
  return out;
}

/** Value for a given tax year from a yearly series (or null). */
export function valueInYear(series, year) {
  return series.find((r) => r.year === Number(year)) || null;
}

/**
 * Years the total changed, with the percentage change from the prior
 * value: these are the reassessments (and any physical change).
 */
export function changeRows(series) {
  const rows = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    if (a.total === b.total && a.land === b.land) continue;
    rows.push({ year: b.year, total: b.total, land: b.land, buildings: b.buildings,
      pct: a.total > 0 ? (100 * (b.total - a.total)) / a.total : null });
  }
  return rows;
}

/** Compound annual change in total between two years (null if unusable). */
export function cagr(series, fromYear, toYear) {
  const a = valueInYear(series, fromYear);
  const b = valueInYear(series, toYear);
  const n = Number(toYear) - Number(fromYear);
  if (!a || !b || n <= 0 || !(a.total > 0) || !(b.total > 0)) return null;
  return 100 * ((b.total / a.total) ** (1 / n) - 1);
}

/** One-line summary for the card: latest change and the 10-year trend. */
export function historySummary(series) {
  if (series.length < 2) return '';
  const last = series.at(-1);
  const changes = changeRows(series);
  const recent = changes.at(-1);
  const from = Math.max(series[0].year, last.year - 10);
  const g = cagr(series, from, last.year);
  const parts = [];
  if (recent && recent.pct != null) parts.push(`${fmtSigned(recent.pct)} in ${recent.year}`);
  if (g != null) parts.push(`${fmtSigned(g)}/yr since ${from}`);
  return parts.join(' · ');
}

function fmtSigned(n) {
  const s = `${Math.abs(n) < 10 ? n.toFixed(1) : Math.round(n)}%`;
  return n > 0 ? `+${s}` : s;
}

const money = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`);

/**
 * Stacked land / buildings bars by year as an SVG string. `compact` drops
 * the axis labels for the summary card. Colours are fixed (it prints).
 */
export function historySvg(series, { width = 640, height = 200, compact = false } = {}) {
  if (!series.length) return '';
  const pad = compact ? { l: 2, r: 2, t: 4, b: 4 } : { l: 48, r: 8, t: 10, b: 22 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const max = Math.max(...series.map((r) => r.total), 1);
  const step = w / series.length;
  const bw = Math.max(1, step * 0.72);
  const y = (v) => pad.t + h - (h * v) / max;
  const bars = series.map((r, i) => {
    const x = pad.l + i * step + (step - bw) / 2;
    const landTop = y(r.land);
    const totTop = y(r.total);
    return `<rect x="${x.toFixed(1)}" y="${landTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${(pad.t + h - landTop).toFixed(1)}" fill="#9cb7cf"><title>${r.year} land ${money(r.land)}</title></rect>`
      + `<rect x="${x.toFixed(1)}" y="${totTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${(landTop - totTop).toFixed(1)}" fill="#1f5f8b"><title>${r.year} buildings ${money(r.buildings)} · total ${money(r.total)}</title></rect>`;
  }).join('');
  if (compact) {
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Assessed value by year">${bars}</svg>`;
  }
  const ticks = [0, 0.5, 1].map((f) => {
    const v = max * f;
    return `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#d9dee3"/>`
      + `<text x="${pad.l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#5b6670">${money(v)}</text>`;
  }).join('');
  const every = series.length > 12 ? 2 : 1;
  const labels = series.map((r, i) => (i % every === 0 || i === series.length - 1
    ? `<text x="${(pad.l + i * step + step / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="10" fill="#5b6670">${String(r.year).slice(2)}</text>` : '')).join('');
  const legend = `<rect x="${pad.l}" y="0" width="9" height="9" fill="#9cb7cf"/><text x="${pad.l + 13}" y="8" font-size="10" fill="#5b6670">Land</text>`
    + `<rect x="${pad.l + 50}" y="0" width="9" height="9" fill="#1f5f8b"/><text x="${pad.l + 63}" y="8" font-size="10" fill="#5b6670">Buildings</text>`;
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Assessed land and building value by tax year">${ticks}${bars}${labels}${legend}</svg>`;
}

/** Tax year a snapshot's Asmt_Roll text refers to ("2027 Spring ..."). */
export function rollYear(asmtRoll, fallbackDate) {
  const m = /\b(20\d\d)\b/.exec(String(asmtRoll || ''));
  if (m) return Number(m[1]);
  const d = /^(\d{4})/.exec(String(fallbackDate || ''));
  return d ? Number(d[1]) : null;
}
