/*
 * Land facts — the open-data land record for farmland parcels, pre-baked per
 * municipality by r/build_landfacts.R into mb-parcel-data/landfacts/.
 *
 * WHAT A STAMP HOLDS. main.js sets `_landfacts` on each parcel from the shard:
 *
 *   { cp:  [0,12,0,20,...],       crop % of the parcel, one entry per year
 *     dom: [110,110,110,122,...], dominant AAFC class code, one per year
 *     rel: 5.9, slp: 0.63, z: [345,351],   relief m, mean slope deg, elevation m
 *     wet: 0.19, wc: '1',         wetland % (CWIM3A, 10 m) and classes present
 *     gsw: 0.0, gsi: 0.0 }        permanent / intermittent open water %
 *
 * The years are LANDFACTS_YEARS in order. A year the crop inventory did not
 * observe is null — never 0. Zero would read as "nothing grew"; null reads
 * as "not seen". Every derivation here skips nulls and says how many years
 * it actually had.
 *
 * WHY THE WHOLE SERIES SHIPS. The everyday read is the last year or the last
 * three; retrospective work wants the run. Both come out of the same 17
 * numbers, so the shard carries the numbers and this module derives the
 * views. That keeps a shard at ~215 bytes per parcel.
 *
 * THREE STATES, same as Flood and Water:
 *   `_landfacts` present         -> show it
 *   shard loaded, roll absent    -> not a farmland-scale parcel (under
 *                                   LANDFACTS_MIN_ACRES, or no MASC rating)
 *   shard never loaded           -> unknown; blank, not "None"
 *
 * NOT A CROPPING RECORD. The crop inventory is a satellite classifier; AAFC
 * targets 85% overall accuracy nationally and publishes none per parcel.
 * Read the pattern across years as evidence and any single year as an
 * indication. Nothing here is a wetland delineation, a drainage opinion or a
 * survey. Codes and years are declared in r/build_landfacts.R's `_meta`;
 * web/test/landfacts.test.js fails if the two drift.
 */

// Minimum parcel acreage in the shards. KEEP IN SYNC with MIN_ACRES in
// r/build_landfacts.R — the builder gates on the same value.
export const LANDFACTS_MIN_ACRES = 20;

// Year of each entry in `cp` / `dom`. Mirrors `_meta.years` in the shard index.
export const LANDFACTS_YEARS = Object.freeze([2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]);

// A year counts as cropped when annual crop covered at least this share.
export const CROP_YEAR_MIN_PCT = 50;

// AAFC Annual Crop Inventory class codes -> labels, from AAFC's own legend
// (aci_crop_classifications_iac_classifications_des_cultures.csv). Generated
// by gen_landfacts_lib.py; regenerate rather than hand-edit.
export const ACI_CLASS = Object.freeze({
  10: "Cloud",
  20: "Water",
  30: "Exposed land/barren",
  34: "Urban/developed",
  35: "Greenhouses",
  50: "Shrubland",
  60: "Forest fire/burnt area",
  80: "Wetland",
  85: "Peatland",
  110: "Grassland",
  120: "Agriculture (undifferentiated)",
  121: "Cropland",
  122: "Pasture/forages",
  130: "Too wet to be seeded",
  131: "Fallow",
  132: "Cereals",
  133: "Barley",
  134: "Other grains",
  135: "Millet",
  136: "Oats",
  137: "Rye",
  138: "Spelt",
  139: "Triticale",
  140: "Wheat",
  141: "Switchgrass",
  142: "Sorghum",
  143: "Quinoa",
  145: "Winter wheat",
  146: "Spring wheat",
  147: "Corn for grain",
  148: "Tobacco",
  149: "Ginseng",
  150: "Oilseeds",
  151: "Borage",
  152: "Camelina",
  153: "Canola/rapeseed",
  154: "Flaxseed",
  155: "Mustard",
  156: "Safflower",
  157: "Sunflower",
  158: "Soybeans",
  159: "Other oilseeds",
  160: "Pulses",
  161: "Other pulses",
  162: "Peas",
  163: "Chickpeas",
  167: "Beans",
  168: "Fababeans",
  174: "Lentils",
  175: "Vegetables",
  176: "Tomatoes",
  177: "Potatoes",
  178: "Sugarbeets",
  179: "Other vegetables",
  180: "Fruits",
  181: "Berries",
  182: "Blueberry",
  183: "Cranberry",
  185: "Other berries",
  188: "Orchards",
  189: "Other fruits",
  190: "Vineyards",
  191: "Hops",
  192: "Sod",
  193: "Herbs",
  194: "Nursery",
  195: "Buckwheat",
  196: "Canaryseed",
  197: "Hemp",
  198: "Vetch",
  199: "Other crops",
  200: "Forest (undifferentiated)",
  210: "Coniferous",
  220: "Broadleaf",
  230: "Mixedwood"
});

// Cover groups for the one-letter cover string and the colour of a year.
//   C annual crop (130-199)   G grass / pasture (110, 122)
//   T trees / shrub (50, 200-230)   W water / wetland (20, 80, 85)
//   O barren / built / other   -  not observed
export const COVER_GROUPS = Object.freeze({
  C: { label: 'Annual crop', color: '#C25A10' },
  G: { label: 'Grass / pasture', color: '#8D9A22' },
  T: { label: 'Trees / shrub', color: '#0F7350' },
  W: { label: 'Water / wetland', color: '#1C7FB4' },
  O: { label: 'Barren / built', color: '#9A5FA8' },
});

export function coverGroup(code) {
  if (code == null || !Number.isFinite(Number(code))) return '-';
  const c = Number(code);
  if (c >= 130 && c < 200) return 'C';
  if (c === 110 || c === 122) return 'G';
  if (c === 50 || (c >= 200 && c <= 230)) return 'T';
  if (c === 20 || c === 80 || c === 85) return 'W';
  return 'O';
}

// Years-cropped ramp for the Crop History map overlay: one hue, light to
// dark, binned on the share of OBSERVED years that were at least half annual
// crop. A single hue by intensity reads "how much cropping" at a glance in a
// way five categorical colours cannot, and separates a quarter cropped 17 of
// 17 years from one cropped 5 of 17 -- the distinction that matters to an
// appraisal. Bins are on share, not count, so a parcel with cloudy years is
// not penalised for the years nobody saw. Lightness is monotone by
// construction (Jason, 2026-09-02).
export const CROP_RAMP = Object.freeze([
  { max: 0,    label: 'Never cropped',      color: '#F5E1CC' },
  { max: 0.25, label: 'Up to a quarter',    color: '#F3B77A' },
  { max: 0.5,  label: 'Up to half',         color: '#E8893A' },
  { max: 0.75, label: 'Up to three-quarters', color: '#C25A10' },
  { max: 1,    label: 'Mostly cropped',     color: '#7A360A' },
]);

/** Share of observed years that were cropped, 0..1, or null when nothing was observed. */
export function cropShare(lf) {
  const n = observedYears(lf);
  return n ? croppedYears(lf) / n : null;
}

/** The ramp step for a stamp, or null when nothing was observed. */
export function cropRampStep(lf) {
  const s = cropShare(lf);
  if (s == null) return null;
  return CROP_RAMP.find((b) => s <= b.max) || CROP_RAMP[CROP_RAMP.length - 1];
}

/** Map fill colour for the Crop History overlay, or null. */
export function cropRampColor(lf) {
  return cropRampStep(lf)?.color || null;
}

// Canadian Wetland Inventory v3A class digits in `wc`.
export const WETLAND_CLASSES = Object.freeze({ 1: 'Bog', 2: 'Fen', 3: 'Swamp', 4: 'Marsh', 5: 'Water' });

/**
 * Coerce a stamp to an object. MapLibre serialises nested feature
 * properties to JSON strings, so a popup can receive the stamp either way.
 */
export function readLandfacts(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (typeof v !== 'object' || !Array.isArray(v.cp) || !Array.isArray(v.dom)) return null;
  return v;
}

/** Per-year records, oldest first: { year, code, label, group, crop }. Unobserved years have crop === null. */
export function yearRecords(lf) {
  lf = readLandfacts(lf);
  if (!lf) return [];
  return LANDFACTS_YEARS.map((year, i) => {
    const crop = lf.cp[i];
    const code = lf.dom[i];
    const seen = crop != null && code != null;
    return {
      year,
      code: seen ? Number(code) : null,
      label: seen ? (ACI_CLASS[Number(code)] || `Class ${code}`) : null,
      group: seen ? coverGroup(code) : '-',
      crop: seen ? Number(crop) : null,
    };
  });
}

/** Years the inventory actually observed. */
export function observedYears(lf) {
  return yearRecords(lf).filter((r) => r.crop != null).length;
}

/** Years annual crop covered at least CROP_YEAR_MIN_PCT of the parcel. */
export function croppedYears(lf) {
  return yearRecords(lf).filter((r) => r.crop != null && r.crop >= CROP_YEAR_MIN_PCT).length;
}

/** Most recent observed year, or null. */
export function lastObserved(lf) {
  const seen = yearRecords(lf).filter((r) => r.crop != null);
  return seen.length ? seen[seen.length - 1] : null;
}

/** Up to the last three observed years, newest first. */
export function lastThree(lf) {
  return yearRecords(lf).filter((r) => r.crop != null).slice(-3).reverse();
}

/** One letter per year, oldest first — e.g. "GGGGGGGGGGGGGTTTG". */
export function coverString(lf) {
  return yearRecords(lf).map((r) => r.group).join('');
}

export function wetlandClassNames(wc) {
  return String(wc || '').split('').map((d) => WETLAND_CLASSES[d]).filter(Boolean).join(', ');
}

/**
 * Grid cell text: the last observed year's dominant class and how many of
 * the observed years were cropped — e.g. "Canola/rapeseed 2025 · 17/17".
 * '' when there is nothing to say.
 */
export function landfactsCellText(lf) {
  const last = lastObserved(lf);
  if (!last) return '';
  return `${last.label} ${last.year} · ${croppedYears(lf)}/${observedYears(lf)}`;
}

/**
 * Sort rank for the grid: most-cropped first (share of observed years),
 * ties broken by the last year's crop %, unstamped last.
 */
export function landfactsSortRank(lf) {
  const n = observedYears(lf);
  if (!n) return Number.POSITIVE_INFINITY;
  const last = lastObserved(lf);
  return -(croppedYears(lf) / n) * 1000 - (last?.crop || 0);
}

/** Multi-line hover text for the grid cell. */
export function landfactsTooltip(lf) {
  lf = readLandfacts(lf);
  if (!lf) return '';
  const recs = yearRecords(lf).filter((r) => r.crop != null);
  const lines = [];
  lines.push(`Crop inventory, ${recs.length} of ${LANDFACTS_YEARS.length} years observed`);
  for (const r of recs.slice().reverse()) lines.push(`  ${r.year}  ${r.label}  (crop ${r.crop}%)`);
  if (lf.rel != null) lines.push(`Relief ${lf.rel} m, mean slope ${lf.slp}°, ${lf.z?.[0]}–${lf.z?.[1]} m (MRDEM 30 m)`);
  if (lf.wet != null) lines.push(`Wetland ${lf.wet}%${lf.wc ? ' (' + wetlandClassNames(lf.wc) + ')' : ''} (CWIM3A 10 m)`);
  if (lf.gsw != null) lines.push(`Open water: permanent ${lf.gsw}%, intermittent ${lf.gsi}% (1984–2021)`);
  return lines.join('\n');
}

/** CSV headers, in the order of landfactsCsvCells(). */
export function landfactsCsvHeaders() {
  return ['Crop Last Yr', 'Crop Last Class', 'Crop Last %', 'Yrs Cropped', 'Yrs Observed',
    'Cover 2009-25', 'Relief m', 'Slope deg', 'Wetland %', 'Wetland Classes',
    'Water Perm %', 'Water Interm %'];
}

export function landfactsCsvCells(lf, loaded) {
  lf = readLandfacts(lf);
  if (!lf) return landfactsCsvHeaders().map(() => (loaded ? 'n/a' : ''));
  const last = lastObserved(lf);
  return [
    last ? last.year : '', last ? last.label : '', last ? last.crop : '',
    croppedYears(lf), observedYears(lf), coverString(lf),
    lf.rel ?? '', lf.slp ?? '', lf.wet ?? '', wetlandClassNames(lf.wc),
    lf.gsw ?? '', lf.gsi ?? '',
  ];
}
