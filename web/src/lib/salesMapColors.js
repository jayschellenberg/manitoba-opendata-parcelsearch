/*
 * Colouring for the Sales Charts map — the land template's CMS maps
 * (LandStatic.qmd ~6798-7303): sales coloured by price-per-unit quantile,
 * by sale year, by zoning, or by water influence.
 *
 * Pure: every function takes values and returns colours / legend entries.
 */

/** Five price buckets, low to high: RColorBrewer YlOrRd, the sequential
 *  ramp the template's heatmap reads as "cheap to dear". */
export const PRICE_RAMP = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'];

/** Sale year ramp: pale to deep orange-red, older to newer (the template's
 *  "Map by Year of Sale" orange-red ramp). */
export const YEAR_LO = [254, 232, 200]; // #fee8c8
export const YEAR_HI = [179, 0, 0];     // #b30000

/**
 * Quantile buckets for the price map: breaks at the 20/40/60/80th
 * percentiles (R type 7, as the template's quantile()), so each colour holds
 * about a fifth of the sales. Returns {breaks, colorOf(v), legend} or null
 * when there are no values. Ties collapse duplicate breaks rather than
 * inventing empty buckets.
 */
export function priceBuckets(values, fmt = (v) => String(Math.round(v))) {
  const v = (values || []).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => {
    const h = (v.length - 1) * p;
    const lo = Math.floor(h);
    return v[lo] + (h - lo) * (v[Math.ceil(h)] - v[lo]);
  };
  const breaks = [...new Set([0.2, 0.4, 0.6, 0.8].map(q))];
  const colorFor = (i) => PRICE_RAMP[Math.round((i * (PRICE_RAMP.length - 1)) / Math.max(1, breaks.length))];
  const colorOf = (x) => {
    if (!Number.isFinite(x)) return null;
    let i = 0;
    while (i < breaks.length && x > breaks[i]) i += 1;
    return colorFor(i);
  };
  const edges = [v[0], ...breaks, v[v.length - 1]];
  const legend = edges.slice(0, -1).map((lo, i) => ({
    label: `${fmt(lo)} – ${fmt(edges[i + 1])}`,
    color: colorFor(i),
  }));
  return { breaks, colorOf, legend };
}

/** Linear blend between two RGB triples, as a hex colour. */
function mix(a, b, t) {
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * t));
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Colour per sale year across the years present. One colour per year
 * (the template's discrete year legend), oldest palest.
 */
export function yearColors(years) {
  const ys = [...new Set((years || []).filter(Number.isFinite))].sort((a, b) => a - b);
  const map = new Map(ys.map((y, i) => [y, mix(YEAR_LO, YEAR_HI, ys.length > 1 ? i / (ys.length - 1) : 1)]));
  return {
    colorOf: (y) => map.get(y) || null,
    legend: ys.map((y) => ({ label: String(y), color: map.get(y) })),
  };
}

/** A circle of `km` around {lat,lng} as a GeoJSON ring (64 steps). */
export function circleRing(center, km, steps = 64) {
  const R = 6371;
  const lat = (center.lat * Math.PI) / 180;
  const lng = (center.lng * Math.PI) / 180;
  const d = km / R;
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const b = (2 * Math.PI * i) / steps;
    const la = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(b));
    const lo = lng + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(la));
    coords.push([(lo * 180) / Math.PI, (la * 180) / Math.PI]);
  }
  return coords;
}
