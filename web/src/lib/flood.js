/*
 * Flood zones — the overlay's palette and the Flood Zone column's vocabulary.
 *
 * Two things share this module, and they answer the same question from
 * DIFFERENT geometry on purpose:
 *
 *   the map overlay  reads public/data/flood/*.geojson, built by
 *                    scripts/build-flood-overlay.js from MBFloodMapping's
 *                    web-simplified layers (3–30% of the original vertices).
 *   the grid column  reads a per-muni shard built by r/build_flood.R, which
 *                    joins the FULL-resolution layers to the parcel fabric.
 *
 * A boundary parcel can therefore look outside the DFA on screen and read
 * "RRV DFA" in its cell. That is the honest arrangement: 10% of the DFA's
 * vertices is right for drawing a provincial boundary at town zoom and wrong
 * for deciding whether one lot is inside it. If the two ever have to agree,
 * raise the overlay's fidelity — do not lower the column's.
 *
 * THREE STATES, same shape as Water Influence and Tile Drainage:
 *   `_flood` present            -> in at least one zone, show it
 *   shard loaded, roll absent   -> genuinely outside every zone
 *   shard never loaded          -> unknown; blank, NOT "No"
 * Only parcels intersecting at least one layer are shipped — most of
 * Manitoba is outside all of them — so absence from a LOADED shard is the
 * answer rather than missing data.
 *
 * The stamp is compact:
 *   { z: { RRVDFA: 100, F200: 62 } }
 *     keys    zone codes below
 *     values  integer % of the parcel's area inside that zone
 *
 * WHY THE PERCENT SHIPS. "In the flood zone" is not a yes/no for a parcel
 * that straddles the line — a quarter section 4% inside the DFA is not
 * encumbered the way a lot 100% inside it is, and the appraiser needs to see
 * which one they have. Same reasoning as WaterDistanceFt: show the
 * measurement rather than a bare verdict the reader has to take on trust.
 *
 * NOT A FLOOD DETERMINATION. These are screening layers. Two of them are
 * statutory boundaries whose authoritative source (MLI) stopped publishing
 * updates in February 2022 — see MBFloodMapping's README before quoting a
 * vintage. Nothing here is a survey, an engineering study, an insurance
 * determination, or a flood protection level.
 */

// Zone severity order, strongest constraint first. This is the order the
// grid cell picks its headline from, the order the tooltip lists, and the
// order the legend renders.
//
// The ranking is by LEGAL FORCE, not by water depth or recency:
//   statutory (WRA Act s.17)      binds construction and flood protection
//                                 levels — the strongest thing a flood layer
//                                 can say about a parcel
//   planning overlay              constrains subdivision and development
//   statistical (1-in-200)        the design flood; informs, does not itself
//                                 regulate
//   observed extents              historical fact, no legal force — but the
//                                 fact a lot was under water in 1997 is often
//                                 the most persuasive thing in the file
//   municipal setback by-law      real, but a riparian setback rather than a
//                                 flood extent, and Winnipeg-only
//
// Ordering observed extents by year (1997 first) is deliberate: 1997 is the
// flood of record and the largest extent, so a parcel inside 2011 is almost
// always inside 1997 too, and leading with the biggest reads truer than
// leading with the most recent.
export const FLOOD_ZONES = [
  {
    code: 'RRVDFA',
    label: 'Red River Valley Designated Flood Area',
    short: 'RRV DFA',
    kind: 'Statutory',
    authority: 'The Water Resources Administration Act, s.17',
    group: 'dfa',
    color: '#b3261e',
  },
  {
    code: 'LRDFA',
    label: 'Lower Red River Designated Flood Area',
    short: 'Lower Red DFA',
    kind: 'Statutory',
    authority: 'The Water Resources Administration Act, s.17',
    group: 'dfa',
    color: '#d4453b',
  },
  {
    code: 'SMA',
    label: 'Red River Valley Special Management Area',
    short: 'RRV SMA',
    kind: 'Planning overlay',
    authority: 'The Planning Act',
    group: 'sma',
    color: '#8e5bb5',
  },
  {
    code: 'F200',
    label: '1-in-200 Year Flood Extent (0.5% AEP)',
    short: '1-in-200',
    kind: 'Statistical',
    authority: 'Manitoba Infrastructure',
    group: 'f200',
    color: '#e07a24',
  },
  {
    code: 'FL1997',
    label: '1997 Red River Flood extent',
    short: '1997 flood',
    kind: 'Observed',
    authority: 'Data MB — observed inundation',
    group: 'hist',
    color: '#3f6395',
  },
  {
    code: 'FL2009',
    label: '2009 Red River Flood extent',
    short: '2009 flood',
    kind: 'Observed',
    authority: 'Data MB — observed inundation',
    group: 'hist',
    color: '#6f92c0',
  },
  {
    code: 'FL2011',
    label: '2011 Red River / Assiniboine Flood extent',
    short: '2011 flood',
    kind: 'Observed',
    authority: 'Data MB — observed inundation',
    group: 'hist',
    color: '#9bb7d9',
  },
  // The two corridor zones are MAP-ONLY in practice. They are clipped to the
  // City of Winnipeg, which does its own assessment and is absent from the
  // provincial Roll Entry fabric this app searches, so no parcel will ever
  // carry them in its cell. They stay in the table because the overlay draws
  // them, the legend names them, and a fabric that one day includes Winnipeg
  // would light the column up without a code change.
  {
    code: 'WWCR',
    label: 'Winnipeg waterway corridor — river (107 m)',
    short: 'River corridor',
    kind: 'Municipal by-law',
    authority: 'City of Winnipeg Waterway By-law 5888/92',
    group: 'corridor',
    color: '#128577',
  },
  {
    code: 'WWCC',
    label: 'Winnipeg waterway corridor — creek (76 m)',
    short: 'Creek corridor',
    kind: 'Municipal by-law',
    authority: 'City of Winnipeg Waterway By-law 5888/92',
    group: 'corridor',
    color: '#4aa89c',
  },
];

const BY_CODE = new Map(FLOOD_ZONES.map((z) => [z.code, z]));
const RANK = new Map(FLOOD_ZONES.map((z, i) => [z.code, i]));

/**
 * Toggle-sized bundles. Five buttons rather than nine because the pairs
 * inside a group are the same instrument drawn twice (two DFAs, three flood
 * years, two corridor widths) — nobody wants the Red River Valley DFA
 * without the Lower Red River one. The zones stay separate underneath so
 * the column can still say WHICH.
 *
 * `file` is what scripts/build-flood-overlay.js writes into
 * public/data/flood/; `source`/`fill`/`line` are the MapLibre ids map.js
 * registers. One source per group, styled by the `code` property.
 */
export const FLOOD_GROUPS = [
  {
    key: 'dfa',
    label: 'Designated Flood Areas',
    file: 'dfa.geojson',
    // Statutory boundaries carry the heaviest fill and the firmest outline:
    // this is the one group that changes what may be built.
    opacity: 0.20,
  },
  { key: 'sma', label: 'Special Management Area', file: 'sma.geojson', opacity: 0.16 },
  { key: 'f200', label: '1-in-200 Year Flood', file: 'flood-1in200.geojson', opacity: 0.18 },
  {
    key: 'hist',
    label: 'Historical Flood Extents',
    file: 'historical.geojson',
    // Three extents that nest inside one another, so the fill has to stay
    // light enough that a parcel in all three is still readable underneath.
    opacity: 0.14,
  },
  { key: 'corridor', label: 'Winnipeg Waterway Corridors', file: 'wpg-corridors.geojson', opacity: 0.22 },
].map((g) => ({
  ...g,
  source: `flood-${g.key}`,
  fill: `flood-${g.key}-fill`,
  line: `flood-${g.key}-line`,
  zones: FLOOD_ZONES.filter((z) => z.group === g.key),
}));

/** Zone descriptor for a code, or null. */
export function floodZone(code) {
  return BY_CODE.get(code) || null;
}

/** Every zone's colour as a flat [code, color, code, color, …] run, ready to
 *  drop into a MapLibre `match` expression on the `code` property. */
export function floodColorStops() {
  return FLOOD_ZONES.flatMap((z) => [z.code, z.color]);
}

/**
 * The zones a stamp records, strongest first, as [{ zone, pct }].
 *
 * Unknown codes are dropped rather than rendered raw: a shard built by a
 * newer r/build_flood.R than the deployed app would otherwise print a bare
 * code like "FL2022" into a client-facing cell.
 */
export function floodZoneEntries(f) {
  const z = f?.z;
  if (!z || typeof z !== 'object') return [];
  return Object.entries(z)
    .map(([code, pct]) => {
      const zone = BY_CODE.get(code);
      if (!zone) return null;
      const n = Number(pct);
      return { zone, pct: Number.isFinite(n) ? n : null };
    })
    .filter(Boolean)
    .sort((a, b) => RANK.get(a.zone.code) - RANK.get(b.zone.code));
}

/** True when the parcel is in at least one recognised zone. */
export function inFloodZone(f) {
  return floodZoneEntries(f).length > 0;
}

/** The strongest zone a parcel sits in, or null. */
export function primaryFloodZone(f) {
  return floodZoneEntries(f)[0]?.zone || null;
}

/**
 * Percent-coverage suffix, or '' when the parcel is wholly inside.
 *
 * Rounded percentages hide both ends: build_flood.R clamps a sliver to 1 and
 * a near-total to 99 so neither can print as "0%" (which reads as "not in
 * it") or vanish into a bare "RRV DFA" (which claims the whole parcel).
 */
function pctSuffix(pct) {
  if (!Number.isFinite(pct) || pct >= 100) return '';
  return ` ${pct}%`;
}

/**
 * Grid cell text — strongest zone, its coverage, and how many more.
 *
 *   "RRV DFA"            wholly inside one zone
 *   "RRV DFA 62%"        straddling the line
 *   "RRV DFA +2"         inside two more, listed in the tooltip
 *
 * Leads with the strongest zone because the cell is one line and the
 * statutory answer is the one that changes what may be built. The count
 * rather than a list keeps the column narrow; the tooltip carries the rest.
 *
 * Returns '' when there is no stamp — callers decide between blank (shard
 * not loaded) and an explicit "outside" label.
 */
export function floodCellText(f) {
  const entries = floodZoneEntries(f);
  if (entries.length === 0) return '';
  const [first, ...rest] = entries;
  const more = rest.length ? ` +${rest.length}` : '';
  return `${first.zone.short}${pctSuffix(first.pct)}${more}`;
}

/** Grid/map colour for a stamp, or null. */
export function floodColor(f) {
  return primaryFloodZone(f)?.color || null;
}

/**
 * Sort key: zone severity, with coverage as the tie-break within a zone.
 *
 * The integer part is the severity index so every statutory parcel sorts
 * above every observed-extent one; the fraction is (100 - pct)/101, so
 * within a zone the fully-enclosed parcels come first and a 4% sliver last.
 * Unstamped parcels sort after everything.
 */
export function floodSortRank(f) {
  const entries = floodZoneEntries(f);
  if (entries.length === 0) return FLOOD_ZONES.length;
  const { zone, pct } = entries[0];
  const within = Number.isFinite(pct) ? (100 - Math.min(100, Math.max(0, pct))) / 101 : 0;
  return RANK.get(zone.code) + within;
}

/**
 * CSV cells for the export columns: Flood Zone / Flood Zone Type /
 * Flood Zone Coverage (%) / Flood Zones (all).
 *
 * Bare values, one fact per column, the way Water splits its five — a
 * spreadsheet filters on "Statutory", not on "RRV DFA 62% +2".
 *
 * Three states, and the difference matters:
 *   - shard never loaded (`loaded` false) -> all blank. We do not know, and
 *     "No flood zone" here would be a confident lie about a hazard.
 *   - loaded, no stamp -> "None", rest blank. The parcel is outside every
 *     layer this app screens against.
 *   - stamped -> strongest zone, its kind, its coverage, then every zone.
 */
export function floodCsvCells(f, loaded) {
  const entries = floodZoneEntries(f);
  if (entries.length === 0) return loaded ? ['None', '', '', ''] : ['', '', '', ''];
  const [first] = entries;
  return [
    first.zone.label,
    first.zone.kind,
    Number.isFinite(first.pct) ? first.pct : '',
    entries.map((e) => (Number.isFinite(e.pct) && e.pct < 100
      ? `${e.zone.label} (${e.pct}%)`
      : e.zone.label)).join('; '),
  ];
}

/** Hover detail — every zone with its coverage and legal character. */
export function floodTooltip(f) {
  const entries = floodZoneEntries(f);
  if (entries.length === 0) return '';
  const out = [];
  for (const { zone, pct } of entries) {
    const cover = Number.isFinite(pct) && pct < 100 ? ` — ${pct}% of the parcel` : '';
    out.push(`${zone.label}${cover}`);
    out.push(`   ${zone.kind} · ${zone.authority}`);
  }
  out.push('');
  out.push('Screening aid from published provincial mapping. Not a survey, an');
  out.push('engineering flood study, or an insurance determination.');
  return out.join('\n');
}
