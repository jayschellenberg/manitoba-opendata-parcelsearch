// parcelHistory.js — which outline a roll had on a given date, from the
// parcel change history published in mb-parcel-history/changes/.
//
// WHERE THE DATA COMES FROM. r/build_parcel_history.R diffs every weekly
// RollEntry snapshot (and the semiannual archives) and r/build_change_shards.R
// publishes one shard per muni:
//
//   changes/_index.json     { first_snapshot, last_snapshot, snapshots, quarantined, ... }
//   changes/<muni_no>.json  { rolls: { "<Roll_No_Txt>": [version, ...] },
//                             outlines: FeatureCollection of superseded outlines }
//
// A version: { fs, ls?, onb, cna, o, c, a, p?, from?, to?, rel? } — first seen,
// last seen (absent = current, i.e. index.last_snapshot), open-not-before,
// close-not-after, opened/closed reason, area m2, provisional, lineage.
//
// WHAT IT CAN AND CANNOT SAY. The province publishes no change dates. A change
// is known only to have happened between the last snapshot showing the old
// outline and the first showing the new one. So a sale inside that window is
// AMBIGUOUS and both outlines are candidates — never a midpoint, never the
// detection date presented as the change date. Same rules as match_sales() in
// r/parcel_history_lib.R; the tests pin the two to the same answers.
//
// A roll with no entry in its muni's shard has had ONE outline since the
// first snapshot, so today's geometry is the parcel for any sale after that.
// Before it, nothing is known either way (`censored`).
//
// Dates are compared as 'YYYY-MM-DD' strings, which sort chronologically and
// sidestep the UTC-vs-local-midnight trap documented in saleDate.js.
//
// Pure: no DOM, no fetch.

/** Local calendar day of a Date as 'YYYY-MM-DD' (null for a bad date). */
export function toIsoDay(d) {
  if (!(d instanceof Date) || !Number.isFinite(d.valueOf())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Last date a version was observed: its own `ls`, or the latest snapshot if current. */
export function lastSeen(v, index) {
  return v.ls || index?.last_snapshot || v.fs;
}

/**
 * Match one sale to the roll's outline history.
 *
 * @param {object|null} versionsByRoll  shard.rolls
 * @param {string} roll                 Roll_No_Txt
 * @param {string} saleIso              'YYYY-MM-DD'
 * @param {object} index                changes/_index.json
 * @returns {{state:string, candidates:object[], certain:boolean, censored:boolean}}
 *   state: 'current'   — today's outline is the one that sold
 *          'prior'     — an earlier outline sold (see candidates[0])
 *          'ambiguous' — the outline changed in a window that spans the sale
 *          'not_yet'   — the roll did not exist yet (see `from` for its parents)
 *          'retired'   — sale after the roll was retired (data mismatch)
 *          'unknown'   — no usable sale date
 */
export function matchSaleToHistory(versionsByRoll, roll, saleIso, index) {
  if (!saleIso) return { state: 'unknown', candidates: [], certain: false, censored: false };
  const first = index?.first_snapshot || null;
  const versions = versionsByRoll?.[roll];
  if (!versions || !versions.length) {
    const censored = Boolean(first) && saleIso < first;
    return { state: 'current', candidates: [], certain: !censored, censored, noRecord: true };
  }
  const cands = versions.filter((v) =>
    (v.onb == null || saleIso >= v.onb) && (v.cna == null || saleIso <= v.cna));
  if (cands.length === 0) {
    const earliest = versions.reduce((m, v) => (v.fs < m ? v.fs : m), versions[0].fs);
    return { state: saleIso < earliest ? 'not_yet' : 'retired', candidates: [],
             certain: false, censored: false, earliest: versions.find((v) => v.fs === earliest) };
  }
  if (cands.length > 1) return { state: 'ambiguous', candidates: cands, certain: false, censored: false };
  const v = cands[0];
  const observed = saleIso >= v.fs && saleIso <= lastSeen(v, index);
  const censored = v.onb == null && saleIso < v.fs;
  return { state: v.cna == null ? 'current' : 'prior', candidates: [v], certain: observed, censored };
}

const LABELS = {
  current:   'Same as today',
  prior:     'Changed since sale',
  ambiguous: 'Changed near sale',
  not_yet:   'Roll created after sale',
  retired:   'Roll retired',
};

/** Grid cell text; null for "no claim" (no date, or no history loaded). */
export function historyLabel(m) {
  if (!m || m.state === 'unknown') return null;
  if (m.state === 'current' && m.censored) return 'Same since history began';
  return LABELS[m.state] || null;
}

/** Sort rank for the grid column: most-changed first, no-claim last. */
export function historyRank(m) {
  const order = { prior: 0, ambiguous: 1, not_yet: 2, retired: 3, current: 4 };
  if (!m || !(m.state in order)) return 9;
  return m.state === 'current' && m.censored ? 5 : order[m.state];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> 'Feb 12, 2025'. */
export function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** 4047 -> '4,047 m² (1.00 ac)'. */
export function fmtArea(m2) {
  const n = Number(m2);
  if (!Number.isFinite(n)) return '?';
  return `${Math.round(n).toLocaleString('en-CA')} m² (${(n / 4046.8564224).toFixed(2)} ac)`;
}

/** "between Feb 12, 2025 and Jul 1, 2026" for a closed version. */
export function changeWindowText(v, index) {
  return `between ${fmtDay(lastSeen(v, index))} and ${fmtDay(v.cna)}`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const WINDOW_NOTE = 'snapshot dates; the province does not publish the actual change date';

function lineageLine(rel, rolls, arrow) {
  if (!rolls || !rolls.length) return '';
  const list = rolls.slice(0, 6).map(esc).join(', ') + (rolls.length > 6 ? ` +${rolls.length - 6} more` : '');
  return `<br>${arrow} ${list}${rel ? ` <span style="color:#888">(${esc(rel.replace(/_/g, ' '))}, inferred)</span>` : ''}`;
}

/**
 * Popup HTML for a prior-outline overlay feature. `p` is the outline's
 * properties as published: roll, fs, ls, cna, c, a, a2, to, rel, p.
 */
export function priorOutlineHtml(p, index) {
  const what = p.c === 'retired'
    ? (p.p ? 'Roll retired (not yet confirmed by a later snapshot)' : 'Roll retired')
    : p.c === 'reshaped_during_gap' ? 'Outline changed (roll briefly missing from the data)' : 'Outline changed';
  const area = p.c === 'retired' || p.a2 == null ? fmtArea(p.a) : `${fmtArea(p.a)} → ${fmtArea(p.a2)}`;
  const now = p.c === 'retired'
    ? (p.to || 'none found')
    : `${esc(p.roll)} (same roll)${p.to ? `, ${esc(p.to)}` : ''}`;
  return `<strong>Prior outline · roll ${esc(p.roll)}</strong><br>`
    + `${esc(what)} ${esc(changeWindowText({ ls: p.ls, cna: p.cna }, index))}<br>`
    + `<small style="color:#888">(${WINDOW_NOTE})</small><br>`
    + `Area: ${esc(area)}<br>`
    + `Roll(s) now: ${esc(now)}`
    + (p.rel ? `<br><span style="color:#888">Lineage: ${esc(String(p.rel).replace(/_/g, ' '))} (inferred from overlap)</span>` : '');
}

/**
 * Popup section for a sale feature, from the match stamped on it. Returns ''
 * when there is nothing to say beyond "same as today" after the history began.
 */
export function saleHistoryHtml(m, index) {
  if (!m || m.state === 'unknown') return '';
  if (m.state === 'current' && !m.censored && m.noRecord) return '';
  const first = fmtDay(index?.first_snapshot);
  const rows = [];
  if (m.state === 'current') {
    if (m.censored) {
      rows.push(`Outline unchanged since history began (${esc(first)}); the sale predates it, so earlier changes are not known.`);
    } else {
      const v = m.candidates[0];
      rows.push(`Today's outline was already in place: it appeared ${esc(changeWindowText({ ls: v.onb, cna: v.fs }, index))}, before the sale.`);
    }
  } else if (m.state === 'prior') {
    const v = m.candidates[0];
    rows.push(`<strong>The parcel that sold is not today's outline.</strong> It changed ${esc(changeWindowText(v, index))}, after the sale.`);
    rows.push(`Area at sale: ${esc(fmtArea(v.a))}`);
    if (m.censored) rows.push(`<small>Outline as of ${esc(first)}; the sale predates the history.</small>`);
    rows.push(lineageLine(v.rel, v.to, '→ now part of').replace(/^<br>/, ''));
    rows.push('The dashed outline on the map is the parcel as it was.');
  } else if (m.state === 'ambiguous') {
    const old = m.candidates.find((v) => v.cna != null) || m.candidates[0];
    rows.push(`<strong>The outline changed ${esc(changeWindowText(old, index))}</strong> and the sale falls in that window: it may have sold as either shape. Check the registered plan.`);
    rows.push(`Areas: ${m.candidates.map((v) => esc(fmtArea(v.a))).join(' or ')}`);
  } else if (m.state === 'not_yet') {
    const v = m.earliest;
    rows.push(`<strong>This roll did not exist on the sale date</strong>; it first appears ${esc(fmtDay(v?.fs))}.`);
    if (v?.from?.length) rows.push(lineageLine(v.rel, v.from, '← carved from').replace(/^<br>/, ''));
  } else if (m.state === 'retired') {
    rows.push('The sale is dated after this roll was retired; check the roll number.');
  }
  return `<div style="margin-top:5px;border-top:1px solid #eee;padding-top:4px">`
    + `<strong style="color:#be185d">Parcel history</strong> <span style="color:#888">(${WINDOW_NOTE})</span><br>`
    + rows.filter(Boolean).join('<br>')
    + `</div>`;
}

/**
 * Outline features to draw for a sale whose parcel was a superseded outline
 * ('prior') or might have been ('ambiguous'). Looked up in the shard's
 * outlines by roll + first-seen date.
 */
export function saleOutlineFeatures(shard, roll, m, extraProps = {}) {
  if (!shard?.outlines?.features || !m || !['prior', 'ambiguous'].includes(m.state)) return [];
  const want = new Set(m.candidates.filter((v) => v.cna != null).map((v) => v.fs));
  return shard.outlines.features
    .filter((f) => f.properties?.roll === roll && want.has(f.properties?.fs))
    .map((f) => ({ type: 'Feature', geometry: f.geometry,
                   properties: { ...f.properties, _histState: m.state, ...extraProps } }));
}
