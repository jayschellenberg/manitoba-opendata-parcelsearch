/*
 * Water-influence analysis for the Sales Charts "Water" tab — the land
 * template's water tabs (LandStatic.qmd ~8313-8760, WaterCharts = Y):
 * sales grouped Waterfront / Near water / No water, box plots by group,
 * class, flood status and water body, the water-premium regression and
 * paired sales.
 *
 * Pure: no DOM. The water/flood helpers it uses (lib/water.js,
 * lib/flood.js) are pure too.
 */

import { isWaterfront, isNearWater, waterClass, waterDistance, WATER_CLASSES } from './water.js';
import { floodZoneEntries, FLOOD_ZONES } from './flood.js';

export const WATER_GROUPS = ['Waterfront', 'Near water', 'No water'];

/**
 * A sale's water facts from its member parcels' stamps.
 *
 *   group    'Waterfront' when ANY member has frontage (a sale that includes
 *            a waterfront lot bought water); else 'Near water' when any is
 *            near water without frontage; else 'No water' when every
 *            member's shard loaded; else null — unknown, never "no water".
 *   cls      the strongest member class key (WATER_CLASSES order)
 *   body     that member's water body name, and `bodyType`
 *   distFt   the nearest member's distance to water, in feet
 *   flood    the most severe member flood zone's short label; 'None' when
 *            every member's flood shard loaded and none is in a zone; else null
 */
export function saleWaterFacts(rec) {
  const stamps = rec?.waters || [];
  let group = null;
  if (stamps.some((w) => isWaterfront(w))) group = 'Waterfront';
  else if (stamps.some((w) => isNearWater(w))) group = 'Near water';
  else if (rec?.waterLoaded) group = 'No water';

  let best = null;
  let bestRank = Infinity;
  let distFt = null;
  for (const w of stamps) {
    const c = waterClass(w);
    const rank = c ? WATER_CLASSES.indexOf(c) : Infinity;
    if (rank < bestRank) { bestRank = rank; best = w; }
    const d = waterDistance(w);
    if (d != null && (distFt == null || d < distFt)) distFt = d;
  }

  let flood = null;
  let floodRank = Infinity;
  for (const f of rec?.floods || []) {
    // floodZoneEntries sorts a stamp's zones strongest first; across member
    // parcels, severity is the zone's position in FLOOD_ZONES.
    const e = floodZoneEntries(f)[0];
    if (!e) continue;
    const rank = FLOOD_ZONES.indexOf(e.zone);
    if (flood == null || rank < floodRank) { flood = e.zone.short; floodRank = rank; }
  }
  if (flood == null && rec?.floodLoaded) flood = 'None';

  return {
    group,
    cls: waterClass(best)?.label || (group === 'No water' ? 'No water' : null),
    body: best?.b || null,
    bodyType: best?.t || null,
    distFt,
    flood,
  };
}

/** Sample quantile, R type 7 — duplicated from salesCharts.js's quantile7
 *  to keep this module free of cross-imports beyond the water/flood libs. */
function q7(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Box-plot figures, as ggplot's geom_boxplot draws them: quartiles (type 7),
 * whiskers to the furthest point within 1.5 IQR of the box, and the points
 * beyond as outliers.
 */
export function boxStats(values) {
  const v = (values || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const q1 = q7(v, 0.25);
  const med = q7(v, 0.5);
  const q3 = q7(v, 0.75);
  const iqr = q3 - q1;
  const loFence = q1 - 1.5 * iqr;
  const hiFence = q3 + 1.5 * iqr;
  const inside = v.filter((x) => x >= loFence && x <= hiFence);
  return {
    n: v.length, q1, median: med, q3,
    whiskerLo: inside.length ? inside[0] : q1,
    whiskerHi: inside.length ? inside[inside.length - 1] : q3,
    outliers: v.filter((x) => x < loFence || x > hiFence),
    min: v[0], max: v[v.length - 1],
  };
}

/**
 * Multiple OLS with coefficient standard errors: y = Xb, X including its
 * own intercept column. Returns null when X'X is singular or there are not
 * more rows than columns (no residual degrees of freedom → no SE).
 */
export function olsFit(X, y) {
  const n = X.length;
  const k = X[0]?.length || 0;
  if (!k || n <= k) return null;
  // X'X and X'y
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let r = 0; r < n; r++) {
    for (let i = 0; i < k; i++) {
      b[i] += X[r][i] * y[r];
      for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j];
    }
  }
  const inv = invert(A);
  if (!inv) return null;
  const coef = inv.map((row) => row.reduce((s, a, j) => s + a * b[j], 0));
  let sse = 0;
  let sst = 0;
  const my = y.reduce((s, v) => s + v, 0) / n;
  for (let r = 0; r < n; r++) {
    const fit = X[r].reduce((s, x, j) => s + x * coef[j], 0);
    sse += (y[r] - fit) ** 2;
    sst += (y[r] - my) ** 2;
  }
  const sigma2 = sse / (n - k);
  const se = inv.map((row, i) => Math.sqrt(Math.max(0, row[i] * sigma2)));
  return { coef, se, n, k, df: n - k, r2: sst > 0 ? 1 - sse / sst : 0 };
}

/** Gauss-Jordan inverse with partial pivoting, or null when singular. */
function invert(M) {
  const k = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    const scale = Math.max(1, ...A.map((row) => Math.abs(row[c])));
    if (Math.abs(A[p][c]) < 1e-12 * scale) return null;
    [A[p], A[c]] = [A[c], A[p]];
    const pv = A[c][c];
    for (let j = 0; j < 2 * k; j++) A[c][j] /= pv;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (!f) continue;
      for (let j = 0; j < 2 * k; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row) => row.slice(k));
}

/**
 * Two-sided 95% t critical value, qt(0.975, df). Exact (R's values) to 30
 * df; beyond that the Cornish-Fisher expansion, within 1e-4 of R — a flat
 * 1.96 would understate the range noticeably at 40-60 df, which is where
 * a municipality's comp set usually sits.
 */
const T95 = [0, 12.706205, 4.302653, 3.182446, 2.776445, 2.570582, 2.446912, 2.364624,
  2.306004, 2.262157, 2.228139, 2.200985, 2.178813, 2.160369, 2.144787, 2.131450,
  2.119905, 2.109816, 2.100922, 2.093024, 2.085963, 2.079614, 2.073873, 2.068658,
  2.063899, 2.059539, 2.055529, 2.051831, 2.048407, 2.045230, 2.042272];
export function t95(df) {
  if (!(df >= 1)) return NaN;
  if (df <= 30) return T95[Math.floor(df)];
  const z = 1.959964;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}

/**
 * The template's water premium (water_premium_rows):
 *   lm(log(rate) ~ log(size) + group)   with 'No water' as the base level
 * on time-adjusted rates. A group coefficient b is a log-difference, so the
 * premium over dry land is exp(b) - 1, with its 95% range exp(b ± t·se) - 1.
 * Controlling for size is the point: waterfront lots are often smaller, and
 * a raw median comparison of $/acre would credit the water with the size
 * effect.
 *
 * rows: [{rate, size, group}] with rate > 0, size > 0, group in WATER_GROUPS.
 * Returns {n, r2, sizeElasticity, groups:[{group, n, premium, lo, hi}]} or
 * null when the base group is missing or the fit is singular.
 */
export function waterPremium(rows) {
  const use = (rows || []).filter((r) => r.rate > 0 && r.size > 0 && WATER_GROUPS.includes(r.group));
  if (!use.some((r) => r.group === 'No water')) return null;
  const levels = WATER_GROUPS.filter((g) => g !== 'No water' && use.some((r) => r.group === g));
  if (!levels.length) return null;
  const X = use.map((r) => [1, Math.log(r.size), ...levels.map((g) => (r.group === g ? 1 : 0))]);
  const y = use.map((r) => Math.log(r.rate));
  const fit = olsFit(X, y);
  if (!fit) return null;
  const t = t95(fit.df);
  return {
    n: fit.n,
    r2: fit.r2,
    df: fit.df,
    sizeElasticity: fit.coef[1],
    groups: levels.map((g, i) => {
      const b = fit.coef[2 + i];
      const se = fit.se[2 + i];
      return {
        group: g,
        n: use.filter((r) => r.group === g).length,
        premium: Math.exp(b) - 1,
        lo: Math.exp(b - t * se) - 1,
        hi: Math.exp(b + t * se) - 1,
      };
    }),
    baseN: use.filter((r) => r.group === 'No water').length,
  };
}

/**
 * The template's paired sales: each waterfront sale matched to the no-water
 * sale closest in size, provided that size is within half to double its own
 * (a 0.3 ac lot is not a pair for a 40 ac one). Closeness is measured on the
 * log scale, so 0.5x and 2x are equally far. A dry sale may pair with more
 * than one waterfront sale, as in the template.
 *
 * items: [{id, size, rate, group, ...}]  → [{wet, dry, ratio, diff}]
 * where diff = wet.rate / dry.rate - 1.
 */
export function pairedSales(items) {
  const wet = (items || []).filter((r) => r.group === 'Waterfront' && r.size > 0 && r.rate > 0);
  const dry = (items || []).filter((r) => r.group === 'No water' && r.size > 0 && r.rate > 0);
  const out = [];
  for (const w of wet) {
    let best = null;
    let bestD = Infinity;
    for (const d of dry) {
      const ratio = d.size / w.size;
      if (ratio < 0.5 || ratio > 2) continue;
      const dist = Math.abs(Math.log(ratio));
      if (dist < bestD) { bestD = dist; best = d; }
    }
    if (best) out.push({ wet: w, dry: best, ratio: best.size / w.size, diff: w.rate / best.rate - 1 });
  }
  return out;
}
