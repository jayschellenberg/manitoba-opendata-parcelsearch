/*
 * Sale-level records + the regression math behind the Sales Charts tab.
 *
 * The grid holds one row PER PARCEL (see salesCsvParse.js), but every
 * appraisal rate the charts plot is a property of the SALE: a 3-parcel
 * assembly has one price, one date, and one blended $/acre. Plotting it
 * as three dots would give that single transaction triple weight in
 * every trendline. So the first thing this module does is collapse rows
 * back to one record per `_saleGroupId`, matching the convention in
 * Jason's ImportMAOSales QMD, which works at the sale level throughout.
 *
 * The rest is the arithmetic those charts need:
 *   - fitLinear   — OLS, the market-conditions line (slope in $/day)
 *   - fitPoly     — the cubic ggplot draws as `y ~ poly(x,3)`
 *   - timeAdjust  — the QMD's AdjPrice: rate + perDay * (effDate - saleDate)
 *
 * Pure: no DOM, no network, no app imports. Everything app-shaped
 * (date parsing, centroids) is injected, the same way saleGroups.js
 * does it, so the math can be unit tested against hand-worked numbers.
 */

const SQFT_PER_ACRE = 43560;
const MS_PER_DAY = 86400000;

/**
 * Portage & Main. Matches the RefLat/RefLon baked into the QMD's params
 * block, so a distance measured here and a distance measured there agree
 * on what "from Winnipeg" means.
 */
export const WINNIPEG_CENTRE = { lat: 49.8953944421782, lng: -97.13848940523296 };

/** Great-circle km. Same formula and radius as main.js's haversineKm —
 *  duplicated rather than imported to keep this module dependency-free. */
export function haversineKm(a, b) {
  if (!a || !b) return NaN;
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Finite positive number, or null. The charts treat 0 and negative
 *  rates as missing — a $0 consideration is a non-market transfer, not
 *  a data point worth fitting a line through. */
function pos(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Collapse per-parcel grid rows into one record per sale.
 *
 * Injected deps:
 *   parseDate(raw) → Date|null   (main.js: parseSaleDate)
 *   centroid(feature) → {lng,lat}|null (lib/geometryText: parcelCentrePoint)
 *
 * The group-level rates (_saleGroupPpl/Ppa/Ppsf) are already stamped on
 * every member by computeSaleGroups, so they're read from whichever
 * member is seen first. Rows with no `_saleGroupId` are skipped: without
 * one there's no way to tell a 2-parcel sale from two 1-parcel sales,
 * and guessing would corrupt the very weighting this function exists to
 * get right.
 *
 * `lotAcres` is the per-parcel size (group acres ÷ parcel count) — the
 * QMD's LotAcres. That is the right x for a size chart: a buyer of a
 * 3-lot assembly was buying three ~5-acre lots, not one 15-acre parcel,
 * and the $/lot on the y-axis is per-lot too.
 */
export function saleRecordsFromRows(rows, { parseDate, centroid } = {}) {
  const byGroup = new Map();

  for (const row of rows || []) {
    const p = row?.parcel?.properties;
    if (!p) continue;
    const gid = p._saleGroupId;
    if (gid == null) continue;

    if (!byGroup.has(gid)) {
      const d = parseDate ? parseDate(p._saleDate) : null;
      const acres = Number(p._saleGroupTotalAcres);
      const count = Number(p._saleGroupSize) || 1;
      const acresComplete = !p._saleGroupAcresIncomplete;
      const lotAcres = acresComplete && Number.isFinite(acres) && acres > 0
        ? acres / count
        : null;
      byGroup.set(gid, {
        saleId: gid,
        dateMs: d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null,
        dateText: p._saleDate ?? '',
        price: pos(p._saleGroupTotalPriceNum),
        parcelCount: count,
        acres: acresComplete ? pos(acres) : null,
        acresComplete,
        lotAcres,
        lotSf: lotAcres != null ? lotAcres * SQFT_PER_ACRE : null,
        // Rates are suppressed upstream when group acres are incomplete,
        // so a null here already means "not safely computable".
        ppl: pos(p._saleGroupPpl),
        ppa: pos(p._saleGroupPpa),
        ppsf: pos(p._saleGroupPpsf),
        saleToAsmt: pos(p._saleGroupSaleToAsmt),
        zone: p._zoneCode || '',
        muni: p.Muni_Name_With_Typ || p.Municipality || '',
        address: p.Property_Address || '',
        rolls: Array.isArray(p._saleGroupRolls) && p._saleGroupRolls.length
          ? p._saleGroupRolls.slice()
          : [p.Roll_No_Txt].filter(Boolean),
        // Subject distance as already stamped by main.js. Null when no
        // subject roll is set; the chart page recomputes from lat/lng
        // when the reference point is Winnipeg instead.
        distanceKm: Number.isFinite(Number(p._distanceKm)) ? Number(p._distanceKm) : null,
        lat: null,
        lng: null,
        _pts: [],
      });
    }

    // Sale position = mean of its members' centroids, so a multi-parcel
    // assembly plots at the middle of the deal rather than at whichever
    // parcel the CSV happened to list first.
    const c = centroid ? centroid(row.parcel) : null;
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) byGroup.get(gid)._pts.push(c);
  }

  const out = [];
  for (const rec of byGroup.values()) {
    if (rec._pts.length) {
      rec.lat = rec._pts.reduce((s, c) => s + c.lat, 0) / rec._pts.length;
      rec.lng = rec._pts.reduce((s, c) => s + c.lng, 0) / rec._pts.length;
    }
    delete rec._pts;
    out.push(rec);
  }
  // Chronological, so anything that walks the array (the table view,
  // the tooltip's tie-breaking) sees a stable, meaningful order.
  out.sort((a, b) => (a.dateMs ?? 0) - (b.dateMs ?? 0));
  return out;
}

/**
 * Median of the finite values in `values`, or null when there are none.
 *
 * Nulls are rejected BEFORE coercion, not after: `Number(null)` is 0, so
 * a plain `.map(Number).filter(isFinite)` would silently count every
 * missing rate as a zero-dollar sale and drag the median down. The
 * chart's captions are built on this figure.
 */
export function median(values) {
  const nums = (values || [])
    .filter((v) => v != null && v !== '')
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = nums.length >> 1;
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * Ordinary least squares through {x, y} points.
 *
 * Returns `{slope, intercept, n, r2, predict}` in whatever units x was
 * handed in — callers pass DAYS (not milliseconds) so `slope` reads
 * directly as dollars per day, which is the market-conditions figure
 * the QMD extracts with `coef(lm(...))[2]`.
 *
 * Null below 3 points, or when every x is identical (a vertical line
 * has no slope, and the naive formula would divide by zero).
 */
export function fitLinear(points) {
  const pts = (points || []).filter(
    (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y),
  );
  const n = pts.length;
  if (n < 3) return null;

  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;

  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  // r² is 0 when y is constant — the line fits perfectly but explains
  // nothing, and 0/0 would otherwise surface as NaN in the stat strip.
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, n, r2, predict: (x) => slope * x + intercept };
}

/**
 * Least-squares polynomial of the given degree, the JS equivalent of
 * ggplot's `geom_smooth(method="lm", formula = y ~ poly(x, degree))`.
 *
 * x is mapped to [-1, 1] before the normal equations are formed. This
 * matters: sale dates as epoch milliseconds are ~1.7e12, so x³ would be
 * ~5e36 and the 4×4 normal matrix would lose every significant digit to
 * rounding. On [-1, 1] the same matrix is well conditioned in float64.
 * `predict` re-applies the mapping, so callers work in original units
 * and never see the normalization.
 *
 * Null when there aren't at least `degree + 5` points. A cubic through
 * 5 points is an interpolation dressed up as a trend — it will swing
 * wildly at the ends and invite reading a market turn that isn't there.
 */
export function fitPoly(points, degree = 3) {
  const pts = (points || []).filter(
    (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y),
  );
  const n = pts.length;
  if (!Number.isInteger(degree) || degree < 1) return null;
  if (n < degree + 5) return null;

  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { if (p.x < lo) lo = p.x; if (p.x > hi) hi = p.x; }
  if (!(hi > lo)) return null;
  const norm = (x) => ((x - lo) / (hi - lo)) * 2 - 1;

  // Normal equations: (VᵀV)c = Vᵀy, built directly as power sums so the
  // full Vandermonde is never materialized.
  const m = degree + 1;
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const p of pts) {
    const t = norm(p.x);
    const powers = new Array(2 * degree + 1);
    powers[0] = 1;
    for (let k = 1; k <= 2 * degree; k++) powers[k] = powers[k - 1] * t;
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) A[i][j] += powers[i + j];
      A[i][m] += powers[i] * p.y;
    }
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null; // singular — collinear x, or duplicate points
    if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; }
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let c = col; c <= m; c++) A[r][c] -= f * A[col][c];
    }
  }
  const coeffs = A.map((row, i) => row[m] / A[i][i]);
  if (coeffs.some((c) => !Number.isFinite(c))) return null;

  return {
    coeffs,
    degree,
    n,
    predict(x) {
      const t = norm(x);
      let y = 0;
      for (let i = coeffs.length - 1; i >= 0; i--) y = y * t + coeffs[i];
      return y;
    },
  };
}

/** Epoch milliseconds → days. The x unit every date-axis fit uses, so a
 *  slope reads as dollars per day without a conversion at the call site. */
export function msToDays(ms) { return ms / MS_PER_DAY; }

/**
 * The market-conditions regression: how fast `metric` is moving, in
 * dollars per day, across the supplied sales.
 *
 * Mirrors the QMD's `lm(PriceAcre ~ DateSold)` and the annualized
 * figures its captions carry. `pctPerYear` is the annual dollar change
 * over the MEDIAN rate rather than the mean — one estate sale at $2/sf
 * shouldn't decide the percentage the whole chart is captioned with.
 *
 * Null when fewer than 3 sales carry both a date and the metric.
 */
export function marketConditions(records, metric) {
  const pts = [];
  const vals = [];
  for (const r of records || []) {
    const y = pos(r?.[metric]);
    if (y == null || !Number.isFinite(r?.dateMs)) continue;
    pts.push({ x: msToDays(r.dateMs), y });
    vals.push(y);
  }
  const fit = fitLinear(pts);
  if (!fit) return null;
  const med = median(vals);
  const perYear = fit.slope * 365;
  return {
    perDay: fit.slope,
    perYear,
    median: med,
    pctPerYear: med != null && med !== 0 ? perYear / med : null,
    r2: fit.r2,
    n: fit.n,
    fit,
  };
}

/**
 * Normalize a user-entered annual adjustment rate. Matches the R
 * engine's rule, so "5" and "0.05" both mean five percent a year and a
 * value typed either way behaves the same in both tools.
 *
 * Returns null for blank, zero, or unparseable input — all of which
 * mean "no override, use the regression".
 */
export function normalizeOverrideRate(input) {
  const n = Number(input);
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.abs(n) > 1 ? n / 100 : n;
}

/**
 * A sale's rate carried forward to the effective date — the QMD's
 * `AdjPrice = MktCondAdj * ChgInDays + Price`.
 *
 * Two bases, mirroring land_time_adjust()'s single `adj()` entry point:
 *   - default: the fitted regression, a flat DOLLAR amount per day;
 *   - `overrideRate`: a judgement PERCENT per year, applied
 *     proportionally (`price * (1 + rate * days/365)`), for when the
 *     appraiser is overriding what the sample happens to measure.
 * They differ in kind, not just size — the dollar basis moves cheap and
 * expensive comps by the same amount, the percent basis moves them
 * proportionally — which is exactly why the chart has to say which one
 * it used.
 *
 * Returns the unadjusted rate when there's no usable trend or date, so
 * a chart never silently drops a comp just because the regression
 * didn't converge. Clamped at zero: a steep downward trend applied
 * across a long gap can drive an old low sale negative, and a negative
 * $/acre is not a value an appraiser should ever be shown.
 */
export function timeAdjust(record, metric, perDay, effectiveMs, { overrideRate = null } = {}) {
  const raw = pos(record?.[metric]);
  if (raw == null) return null;
  if (!Number.isFinite(record?.dateMs) || !Number.isFinite(effectiveMs)) return raw;
  const days = (effectiveMs - record.dateMs) / MS_PER_DAY;

  if (Number.isFinite(overrideRate) && overrideRate !== 0) {
    return Math.max(0, raw * (1 + overrideRate * (days / 365)));
  }
  if (!Number.isFinite(perDay)) return raw;
  return Math.max(0, raw + perDay * days);
}

/**
 * Which zone codes get their own colour on the zoning-coloured chart,
 * and which fold into "Other".
 *
 * Capped at 3 by the palette, not by taste: a scatter puts every pair of
 * series adjacent to every other, and only the first three categorical
 * slots clear the colourblind-separation floor under that all-pairs
 * test (see references/palette.md). A 4th hue would put yellow beside
 * orange and fail it. Ties break alphabetically so the same filtered set
 * always produces the same colours.
 */
export function topZones(records, max = 3) {
  const counts = new Map();
  for (const r of records || []) {
    const z = String(r?.zone || '').trim();
    if (!z) continue;
    counts.set(z, (counts.get(z) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key, count]) => ({ key, count }));
}

/** Dot radius encoding parcel count. Single-parcel sales sit at r=4 (an
 *  8px mark, the spec floor); assemblies grow logarithmically and cap at
 *  7 so one 18-parcel portfolio can't dominate the plot. */
export function dotRadius(parcelCount) {
  const c = Number(parcelCount);
  if (!Number.isFinite(c) || c <= 1) return 4;
  return Math.min(7, 4 + Math.log2(c) * 1.6);
}
