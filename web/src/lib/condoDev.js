/*
 * New condo developments — row housing and apartment condos, pre-baked per
 * municipality by r/build_condo_dev.R into mb-parcel-data/condo-dev/.
 *
 * WHAT A STAMP HOLDS. main.js sets `_condoDev` on each parcel from the shard.
 * Every unit roll of a development carries the DEVELOPMENT's attributes, not
 * its own — the development is the thing worth seeing:
 *
 *   { p:  '57857',            condo plan number, the development key
 *     y:  2017,               first tax year any of its rolls was assessed
 *     u:  122,                units (rolls) in the development
 *     k:  'row',              'row' | 'apt' | 'mixed' | 'unknown'
 *     kn: 4,                  how many rolls carried a MAO descriptor
 *     b:  30128400,           the development's total building value
 *     ad: '123 COBALT CRES' } a representative address
 *
 * WHY THIS IS A SEPARATE LAYER FROM NEW MULTI-FAMILY. That layer gates on
 * `dwelling_units >= 3`, which is right for rental blocks and wrong for
 * everything else: 92% of the rolls MAO labels as row housing carry
 * dwelling_units = 1, because row housing is condo-titled — one roll per unit.
 * Row housing is not under-represented in that layer, it is absent from it,
 * which is why New Multi-Family is in practice already "new apartments". This
 * layer reassembles the single-unit rolls into projects via their shared condo
 * plan, which is the only handle that does it.
 *
 * WHY `unknown` IS A REAL ANSWER AND NOT A GAP TO FILL. A development is typed
 * only where MAO's own Primary Property descriptor labels at least one of its
 * rolls — a condo plan is one architectural project, and 98.7% of plans are
 * internally consistent in that labelling, so one labelled unit can speak for
 * the rest. Where nothing is labelled the answer is `unknown`.
 *
 * The tempting heuristic is the civic address: row-housing units get their own
 * street address ("49 WHEATGRASS BAY") while apartment condos get "Unit 105 -
 * 3400 MCDONALD AVE". Validated against 2,843 labelled condo rolls it reaches
 * 76% accuracy per roll but only 36.5% row-housing PRECISION, and 61.7% even
 * when a whole development votes. A six-plex at 31 Main St and a six-unit row
 * house at 31 Main St are identical in that field. Unit density is worse
 * still. So neither is used: in an appraisal tool a confidently wrong label
 * costs more than a blank one.
 *
 * `kn` IS THE EVIDENCE COUNT, and worth reading. A development typed from 40
 * of its 40 rolls is a different proposition from one typed off 4 of 122.
 *
 * YEARS ARE ASSESSMENT YEARS and trail physical completion, typically by
 * about a year — same caveat as New Multi-Family, same reason.
 *
 * Thresholds live in r/build_condo_dev.R's `_meta`; web/test/condoDev.test.js
 * fails if the two drift.
 */

// KEEP IN SYNC with MIN_UNITS / FROM_YEAR in r/build_condo_dev.R.
export const CONDO_MIN_UNITS = 3;
export const CONDO_FROM_YEAR = 2016;

export const CONDO_TYPES = Object.freeze({
  row:     { label: 'Row housing',  color: '#31a354',
             blurb: 'Ground-oriented: MAO labels at least one unit row housing / townhouse.' },
  apt:     { label: 'Apartment',    color: '#756bb1',
             blurb: 'Stacked: MAO labels at least one unit an apartment.' },
  mixed:   { label: 'Mixed',        color: '#fd8d3c',
             blurb: 'MAO labels some units row housing and others apartment — read the development itself.' },
  unknown: { label: 'Not typed',    color: '#bdbdbd',
             blurb: 'No unit has sold with a MAO structure descriptor, so the type is unknown. It is left blank rather than guessed — the address and density heuristics are not accurate enough to label.' },
});

// Recency ramp for the year view. Purples, deliberately not the New
// Multi-Family reds: the two layers can be on together and must not read as
// one dataset.
export const CONDO_YEAR_RAMP = Object.freeze([
  { max: 2017, color: '#f2f0f7', label: '2016-17' },
  { max: 2019, color: '#dadaeb', label: '2018-19' },
  { max: 2021, color: '#bcbddc', label: '2020-21' },
  { max: 2023, color: '#9e9ac8', label: '2022-23' },
  { max: 2025, color: '#756bb1', label: '2024-25' },
  { max: Infinity, color: '#54278f', label: '2026+' },
]);

export const CONDO_MODES = Object.freeze({
  type: { label: 'Type', legend: 'New condo developments' },
  year: { label: 'Year', legend: 'Condo development on the roll by' },
});

/** Tolerant read of the stamp. Returns null for anything without a plan. */
export function readCondoDev(v) {
  if (!v || typeof v !== 'object') return null;
  if (!v.p) return null;
  return v;
}

export function condoType(c) {
  const v = readCondoDev(c);
  if (!v) return null;
  return CONDO_TYPES[v.k] ? v.k : 'unknown';
}

export function condoFillColor(c, mode) {
  const v = readCondoDev(c);
  if (!v) return null;
  if (mode === 'year') {
    const y = Number(v.y);
    if (!Number.isFinite(y)) return null;
    for (const step of CONDO_YEAR_RAMP) if (y <= step.max) return step.color;
    return CONDO_YEAR_RAMP[CONDO_YEAR_RAMP.length - 1].color;
  }
  return CONDO_TYPES[condoType(v)].color;
}

function money(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

/** Grid cell: the development, not this one unit. */
export function condoCellText(c) {
  const v = readCondoDev(c);
  if (!v) return '';
  return `${v.y} · ${CONDO_TYPES[condoType(v)].label} · ${v.u} unit${v.u === 1 ? '' : 's'}`;
}

/** Sort: typed developments ahead of untyped, then most recent, then largest.
 *  Untyped still sorts above unstamped rows — "we looked and could not tell"
 *  outranks "not a condo development". */
export function condoSortRank(c) {
  const v = readCondoDev(c);
  if (!v) return -Infinity;
  const typedBonus = condoType(v) === 'unknown' ? 0 : 1e12;
  return typedBonus + Number(v.y) * 1e6 + Math.min(v.u, 999999);
}

export function condoTooltip(c) {
  const v = readCondoDev(c);
  if (!v) return '';
  const t = condoType(v);
  const lines = [
    `Condo plan ${v.p} · ${v.u} unit${v.u === 1 ? '' : 's'} · first assessed ${v.y}`,
    `${CONDO_TYPES[t].label} — ${CONDO_TYPES[t].blurb}`,
  ];
  if (t !== 'unknown') {
    lines.push(`Typed from ${v.kn} of ${v.u} unit${v.u === 1 ? '' : 's'} carrying a MAO descriptor.`);
  }
  if (Number.isFinite(v.b)) lines.push(`Development building value ${money(v.b)}.`);
  if (v.ad) lines.push(v.ad);
  lines.push('Assessment years trail completion by about a year.');
  return lines.join('\n');
}

export function condoCsvHeaders() {
  return ['Condo plan', 'Condo dev year', 'Condo dev units', 'Condo dev type',
          'Condo type evidence (rolls)', 'Condo dev building value'];
}

export function condoCsvCells(c, loaded) {
  const v = readCondoDev(c);
  // Unloaded is unknown, not "none" — same rule as the other overlays, so a
  // failed fetch never reads as a negative finding in someone's spreadsheet.
  if (!v) return loaded ? ['None', '', '', '', '', ''] : ['', '', '', '', '', ''];
  return [
    String(v.p), String(v.y), String(v.u),
    CONDO_TYPES[condoType(v)].label,
    condoType(v) === 'unknown' ? '' : String(v.kn),
    Number.isFinite(v.b) ? String(Math.round(v.b)) : '',
  ];
}

/** Legend rows for the active mode. */
export function condoLegendSteps(mode) {
  if (mode === 'year') {
    return CONDO_YEAR_RAMP.map((s) => ({ color: s.color, label: s.label }));
  }
  return Object.keys(CONDO_TYPES).map((k) => ({
    color: CONDO_TYPES[k].color, label: CONDO_TYPES[k].label,
  }));
}
