/*
 * Multi-family new construction — where apartment-scale buildings landed on
 * the assessment roll, pre-baked per municipality by r/build_mf_newbuild.R
 * into mb-parcel-data/mf-newbuild/.
 *
 * WHAT A STAMP HOLDS. main.js sets `_mfnb` on each parcel from the shard:
 *
 *   { du: 270,                      CURRENT dwelling units
 *     ad: '1027 MANITOBA AVE',      civic address
 *     cl: 'R2',                     property classes in the latest tax year
 *     p:  2024,                     year of the primary (largest-gain) event
 *     e:  [ {y, k, b, bp, c}, ... ] every event, oldest first
 *     sdu:[[2015, 12], ...] }       at-sale dwelling units, where the roll sold
 *
 * Each event is a year `y`, a kind `k`, the building value `b` that year, the
 * value `bp` the year before, and a confidence `c`.
 *
 * WHY BUILDING VALUE AND NOT UNIT COUNT. MAO publishes dwelling units as a
 * CURRENT scalar with no history, so a year-over-year DU change cannot be
 * computed for any period before r/snapshot_dwelling_units.R first ran.
 * Assessed building value, by contrast, has 20 years of it on every roll —
 * and because Manitoba freezes values between biennial reassessments, a
 * within-biennium jump is almost pure physical change. That is the trigger;
 * dwelling units are only the filter that keeps it to multi-family.
 *
 * SO `du` IS TODAY'S COUNT, not the count at any one event. On a two-phase
 * roll it is both phases together — Selkirk's 1027 Manitoba Ave reads 270
 * units against a 2017 event AND a 2024 event. `sdu` is the one genuinely
 * historical unit count available, and only for rolls that sold.
 *
 * EVENT YEARS ARE ASSESSMENT YEARS. `y` is the first tax year the building is
 * assessed, which trails physical completion — typically by about a year, and
 * a partly built structure can be assessed at part value first. Every label
 * here says "on the roll", never "built", for that reason.
 *
 * THREE STATES, same as Flood, Water and Land Facts:
 *   `_mfnb` present            -> show it
 *   shard loaded, roll absent  -> no multi-family construction on this roll
 *   shard never loaded         -> unknown; blank, not "None"
 *
 * NOT A PERMIT RECORD. Outside Winnipeg there is no province-wide building
 * permit feed; this infers construction from what the assessor recorded.
 * A conversion that added units without adding value is invisible to it, and
 * a large non-residential building on a roll that happens to hold apartments
 * can move the value. Thresholds and the confidence rules live in
 * r/build_mf_newbuild.R's `_meta`; web/test/mfNewbuild.test.js fails if the
 * two drift.
 */

// Minimum dwelling units in the shards. KEEP IN SYNC with MIN_DU in
// r/build_mf_newbuild.R — the builder gates on the same value.
export const MFNB_MIN_DU = 3;

// First event year in the shards. KEEP IN SYNC with FROM_YEAR.
export const MFNB_FROM_YEAR = 2016;

export const MFNB_KINDS = Object.freeze({
  appeared: 'Building appeared on a roll that held nothing',
  expanded: 'Building value rose well above the general reassessment',
  new_roll: 'Roll created already improved (new parcel)',
});

export const MFNB_CONFIDENCE = Object.freeze({
  high: 'Within a reassessment cycle, when values are frozen — or a building landing on an empty roll. Physical change either way.',
  med:  'Roll created already improved, or a near-empty roll improved across a reassessment boundary.',
  low:  'Expansion across a reassessment boundary — an excess over the modelled revaluation factor, not a certainty.',
});

// Recency ramp for the year view. Sequential, dark = recent, so the newest
// construction reads first on a basemap of any brightness. Buckets rather
// than a continuous scale because the eye cannot rank 12 shades but can rank
// 6, and because assessment years arrive in pairs anyway.
export const YEAR_RAMP = Object.freeze([
  { max: 2017, color: '#fee5d9', label: '2016-17' },
  { max: 2019, color: '#fcae91', label: '2018-19' },
  { max: 2021, color: '#fb6a4a', label: '2020-21' },
  { max: 2023, color: '#de2d26', label: '2022-23' },
  { max: 2025, color: '#a50f15', label: '2024-25' },
  { max: Infinity, color: '#67000d', label: '2026+' },
]);

// Size ramp for the units view. Breaks are the ones that matter to an
// appraiser: the fourplex line, the small-block line, and 100+ where a
// property stops trading as a local asset.
export const UNITS_RAMP = Object.freeze([
  { max: 5,   color: '#eff3ff', label: '3-5' },
  { max: 11,  color: '#c6dbef', label: '6-11' },
  { max: 23,  color: '#6baed6', label: '12-23' },
  { max: 49,  color: '#3182bd', label: '24-49' },
  { max: 99,  color: '#08519c', label: '50-99' },
  { max: Infinity, color: '#08306b', label: '100+' },
]);

export const MFNB_MODES = Object.freeze({
  year:  { label: 'Year', legend: 'Multi-family on the roll by', ramp: YEAR_RAMP },
  units: { label: 'Units', legend: 'Dwelling units (current)', ramp: UNITS_RAMP },
});

/** Tolerant read of the stamp — main.js may hand back a parsed object or
 *  nothing at all. Returns null for anything without at least one event. */
export function readMfnb(v) {
  if (!v || typeof v !== 'object') return null;
  if (!Array.isArray(v.e) || v.e.length === 0) return null;
  return v;
}

function rampColor(ramp, value) {
  if (!Number.isFinite(value)) return null;
  for (const step of ramp) if (value <= step.max) return step.color;
  return ramp[ramp.length - 1].color;
}

/** Year of the primary event — the one that created the most building value.
 *  Falls back to the latest event if the shard predates the `p` field. */
export function primaryYear(m) {
  const v = readMfnb(m);
  if (!v) return null;
  if (Number.isFinite(v.p)) return v.p;
  return Math.max(...v.e.map((e) => e.y));
}

/** The primary event object itself, for the popup and the tooltip. */
export function primaryEvent(m) {
  const v = readMfnb(m);
  if (!v) return null;
  const y = primaryYear(v);
  return v.e.find((e) => e.y === y) || v.e[v.e.length - 1];
}

/** Best confidence across the roll's events — a roll with one certain event
 *  and one soft one is not a soft roll. */
export function bestConfidence(m) {
  const v = readMfnb(m);
  if (!v) return null;
  const order = ['high', 'med', 'low'];
  let best = null;
  for (const e of v.e) {
    const i = order.indexOf(e.c);
    if (i >= 0 && (best === null || i < best)) best = i;
  }
  return best === null ? null : order[best];
}

export function mfnbFillColor(m, mode) {
  const v = readMfnb(m);
  if (!v) return null;
  if (mode === 'units') return rampColor(UNITS_RAMP, v.du);
  return rampColor(YEAR_RAMP, primaryYear(v));
}

/** Total building value created across every event on the roll. Two phases
 *  seven years apart are two buildings, so their gains add. */
export function totalGain(m) {
  const v = readMfnb(m);
  if (!v) return null;
  return v.e.reduce((sum, e) => sum + Math.max(0, (e.b || 0) - (e.bp || 0)), 0);
}

function money(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

/** Grid cell: the headline is when and how big. */
export function mfnbCellText(m) {
  const v = readMfnb(m);
  if (!v) return '';
  const y = primaryYear(v);
  const extra = v.e.length > 1 ? ` +${v.e.length - 1}` : '';
  return `${y}${extra} · ${v.du} DU`;
}

/** Sort rank: most recent first, then most units. Rolls without a stamp sort
 *  last, matching how the other overlays rank a blank. */
export function mfnbSortRank(m) {
  const v = readMfnb(m);
  if (!v) return -Infinity;
  return primaryYear(v) * 1e6 + Math.min(v.du, 999999);
}

export function mfnbTooltip(m) {
  const v = readMfnb(m);
  if (!v) return '';
  const lines = v.e.map((e) => {
    const gain = Math.max(0, (e.b || 0) - (e.bp || 0));
    return `${e.y}  ${e.k}  ${money(e.bp)} → ${money(e.b)}  (+${money(gain)}, ${e.c})`;
  });
  if (Array.isArray(v.sdu) && v.sdu.length) {
    lines.push(`at sale: ${v.sdu.map(([yy, dd]) => `${yy}: ${dd} DU`).join(', ')}`);
  }
  lines.push(`${v.du} dwelling units today · class ${v.cl || '?'}`);
  lines.push('Years are assessment years and trail completion by about a year.');
  return lines.join('\n');
}

export function mfnbCsvHeaders() {
  return ['MF on roll by', 'MF events', 'MF units (current)', 'MF value created',
          'MF confidence', 'MF at-sale DU'];
}

export function mfnbCsvCells(m, loaded) {
  const v = readMfnb(m);
  // An unloaded shard is unknown, not "none" — blank both, exactly as the
  // land-facts and flood exports do, so a failed fetch never reads as a
  // negative finding in a spreadsheet someone later relies on.
  if (!v) return loaded ? ['None', '', '', '', '', ''] : ['', '', '', '', '', ''];
  return [
    String(primaryYear(v)),
    v.e.map((e) => `${e.y} ${e.k}`).join('; '),
    String(v.du),
    String(Math.round(totalGain(v))),
    bestConfidence(v) || '',
    Array.isArray(v.sdu) ? v.sdu.map(([yy, dd]) => `${yy}: ${dd}`).join('; ') : '',
  ];
}

/** Legend rows for the active mode. */
export function mfnbLegendSteps(mode) {
  return (MFNB_MODES[mode] || MFNB_MODES.year).ramp.map((s) => ({
    color: s.color, label: s.label,
  }));
}
