// MASC soil-rating overlay helpers. Constructs quarter-section polygons
// from each rating's centroid lat/lon, plus the section-township grid
// (lines) by aggregating quarter centroids into section bounding boxes.
//
// The Dominion Land Survey divides Manitoba's farmland into townships of
// 6 mi × 6 mi, each with 36 sections of 1 sq mi, each with 4 quarter
// sections of ~800 m × ~800 m. The MASC CSV stores the centroid of every
// rated quarter section, so we can construct visually-faithful polygons
// without fetching a separate polygon layer:
//
//   QuarterSection ≈ 800 m square centred on (lat, lon)
//
// The square is computed in degrees with longitude scaled by cos(lat),
// so polygons stay roughly square at any latitude. Real DLS sections
// have minor irregularities near rivers, the meridian breaks, and the
// international border — for an appraisal-research overlay this
// approximation is more than accurate enough.

// Half-side in metres of one quarter-section. ~800 m × ~800 m total.
const QUARTER_HALF_SIDE_M = 400;

// One degree of latitude ≈ 111,320 m everywhere.
const M_PER_DEG_LAT = 111320;

/**
 * Build a Polygon GeoJSON Feature for a quarter-section, given its
 * centroid lat/lon and the rating attributes to carry along. Returns
 * null for nullish or out-of-range coordinates.
 */
export function quarterPolygon(row) {
  const lat = Number(row?.lat);
  const lon = Number(row?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Latitude offset is constant; longitude offset shrinks toward the poles.
  const dLat = QUARTER_HALF_SIDE_M / M_PER_DEG_LAT;
  const dLon = QUARTER_HALF_SIDE_M / (M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180));
  const w = lon - dLon;
  const e = lon + dLon;
  const s = lat - dLat;
  const n = lat + dLat;
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
    },
    properties: {
      q: row.q,
      s: row.s,
      t: row.t,
      r: row.r,
      d: row.d,
      rating: row.rating,
      ra: row.ra,
      lat, lon,
      // Pre-formatted human-readable label for the popup, e.g.
      // "NE 12-3-4W". Kept short so it fits the popup line.
      label: `${row.q} ${row.s}-${row.t}-${row.r}${row.d}`,
    },
  };
}

/**
 * Convert a list of MASC rows into a FeatureCollection of quarter
 * polygons. Rows missing lat/lon are skipped silently.
 */
export function quartersToFc(rows) {
  if (!Array.isArray(rows)) return { type: 'FeatureCollection', features: [] };
  const features = [];
  for (const row of rows) {
    const f = quarterPolygon(row);
    if (f) features.push(f);
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Group MASC rows by section (s, t, r, d) and emit one rectangular line
 * feature per section — the four-edge bounding box of that section's
 * four quarters. When all four quarters are present this produces an
 * accurate section square; with fewer quarters (boundary cases) the
 * box still covers the rated area, which is good enough for a visual
 * grid overlay.
 */
export function sectionLinesFromRows(rows) {
  if (!Array.isArray(rows)) return { type: 'FeatureCollection', features: [] };
  // Normalize the meridian to just the W/E letter for both the group
  // key AND the stored direction. MB_LegalDesc returns the meridian
  // in mixed encodings ("E1", "1E", "E", "W1", "1") for the same
  // physical meridian; grouping on the raw value used to produce
  // multiple identical features per section, all rendering the same
  // label in the same place — looked like duplicates on the map.
  const normMeridian = (raw) => String(raw || '').replace(/[^EW]/gi, '').toUpperCase();
  const sections = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lon)) continue;
    const dir = normMeridian(row.d);
    const key = `${row.s}|${row.t}|${row.r}|${dir}`;
    if (!sections.has(key)) {
      sections.set(key, { s: row.s, t: row.t, r: row.r, d: dir, quarters: [] });
    }
    sections.get(key).quarters.push(row);
  }
  const features = [];
  for (const sec of sections.values()) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    let lat0 = NaN;
    for (const q of sec.quarters) {
      const lat = Number(q.lat), lon = Number(q.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      lat0 = lat;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    if (!Number.isFinite(lat0)) continue;
    // Pad each section's bbox by half a quarter on every side so a
    // section with only one or two known quarters still encloses the
    // full section. ~400 m pad to round it out to a proper 1 sq mi.
    const dLat = QUARTER_HALF_SIDE_M / M_PER_DEG_LAT;
    const dLon = QUARTER_HALF_SIDE_M / (M_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180));
    const w = minLon - dLon, e = maxLon + dLon;
    const s = minLat - dLat, n = maxLat + dLat;
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
      },
      properties: {
        section: sec.s, township: sec.t, range: sec.r, direction: sec.d,
        // sec.d is already the normalized W/E letter from the group
        // key — Manitoba short-form '7-5-6E' / '7-5-6W'.
        label: `${sec.s}-${sec.t}-${sec.r}${sec.d}`,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Emit one rectangular line feature per quarter section — denser variant
 * of sectionLinesFromRows. Each quarter is ~800m × 800m centred on its
 * (lat, lon); the label combines the quarter direction with the section
 * coords, e.g. "NE 12-3-4W".
 *
 * Use this for the Quarter-Section Grid overlay mode; for the broader
 * Section/Township Grid, sectionLinesFromRows aggregates 4 quarters into
 * one section bounding box, which is the right zoom-out granularity.
 */
export function quarterLinesFromRows(rows) {
  if (!Array.isArray(rows)) return { type: 'FeatureCollection', features: [] };
  const normMeridian = (raw) => String(raw || '').replace(/[^EW]/gi, '').toUpperCase();
  const features = [];
  for (const row of rows) {
    const lat = Number(row?.lat);
    const lon = Number(row?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const dLat = QUARTER_HALF_SIDE_M / M_PER_DEG_LAT;
    const dLon = QUARTER_HALF_SIDE_M / (M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180));
    const w = lon - dLon, e = lon + dLon;
    const s = lat - dLat, n = lat + dLat;
    const direction = normMeridian(row.d);
    const quarter = String(row.q || '').toUpperCase();
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
      },
      properties: {
        quarter,
        section: row.s,
        township: row.t,
        range: row.r,
        direction,
        // Short label e.g. "NE 7-5-6E" — matches the convention
        // quarterPolygon() uses for the MASC overlay popup.
        label: quarter
          ? `${quarter} ${row.s}-${row.t}-${row.r}${direction}`
          : `${row.s}-${row.t}-${row.r}${direction}`,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Convert the Manitoba Original Survey (MB_LegalDesc) FeatureCollection
 * — point features carrying QUARTER / SECTION / TOWNSHIP / RANGE /
 * MERIDIAN / TYPE — into the row shape sectionLinesFromRows() expects.
 * Keeps the section-township-grid construction agnostic of which
 * source produced the centroids (MASC CSV vs MB_LegalDesc REST query).
 */
export function surveyFcToRows(fc) {
  if (!fc?.features) return [];
  const rows = [];
  for (const f of fc.features) {
    const c = f.geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    const p = f.properties || {};
    const section = Number(p.SECTION);
    const township = Number(p.TOWNSHIP);
    const range = Number(p.RANGE);
    if (!Number.isFinite(section) || !Number.isFinite(township) || !Number.isFinite(range)) continue;
    rows.push({
      q: p.QUARTER || '',
      s: section,
      t: township,
      r: range,
      // MB_LegalDesc uses a numeric MERIDIAN (1 = principal meridian,
      // 2 = 2nd, etc.). MASC uses a W/E direction. Keying by meridian
      // number works for the grid since it just needs to distinguish
      // ranges across meridians; the line-key concatenates whatever's
      // here without interpretation.
      d: String(p.MERIDIAN ?? ''),
      lat: c[1],
      lon: c[0],
    });
  }
  return rows;
}

/**
 * MASC soil-rating colour ramp, A (best) → J (worst). Same scheme used
 * by Manitoba's own MASC publications: green for top ratings stepping
 * through yellow to red for the lowest. Returned as a flat
 * [code, color, ...] palette ready for MapLibre's `match` expression.
 */
// Quarter sections are about 800 m wide, which leaves enough room for a
// compact rating letter at zoom 11 without cluttering province-wide views.
export const MASC_RATING_LABEL_MIN_ZOOM = 11;

// The official Risk Areas layer has only 17 features. Preserve its source
// vertices instead of letting MapLibre simplify administrative boundaries.
export const MASC_RISK_SOURCE_OPTIONS = Object.freeze({
  maxzoom: 24,
  tolerance: 0,
});

// MASC's published "Soil Zones" palette: yellows for A/B (best), olive
// for C, greens D→F (mid range), pinks/red G→I, purple for J (worst).
// Mirrors the legend in MASC's own crop-insurance maps so the colours
// users see here match what they'd see in printed publications.
export const MASC_PALETTE = [
  'A', '#fff8c8',  // pale yellow
  'B', '#f2d640',  // golden yellow
  'C', '#847b14',  // dark olive
  'D', '#a6e29f',  // light green
  'E', '#4fab57',  // medium green
  'F', '#1a6b26',  // dark green
  'G', '#f4c2d1',  // light pink
  'H', '#e6228b',  // magenta
  'I', '#dc0000',  // red
  'J', '#9c27b0',  // purple
];

/** Lookup helper for the popup / legend — returns the hex for a code. */
export function masccolor(code) {
  for (let i = 0; i < MASC_PALETTE.length; i += 2) {
    if (MASC_PALETTE[i] === code) return MASC_PALETTE[i + 1];
  }
  return '#cccccc';
}
