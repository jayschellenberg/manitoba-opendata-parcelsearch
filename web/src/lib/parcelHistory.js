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
 *          'not_yet'   — the roll was not yet on the province's parcel map (it may
 *                        well have existed in MAO: new lots are assessed and
 *                        sold before they are mapped). `from` = its parents.
 *          'retired'   — sale after the roll was retired (data mismatch)
 *          'realigned' — the outline that sold (or both, if ambiguous) was
 *                        replaced only by map realignments since: the same
 *                        parcel, redrawn by the province at the same area
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
  if (cands.length > 1) {
    if (redrawnOnly(versions, cands)) return { state: 'realigned', candidates: cands, certain: false, censored: false };
    return { state: 'ambiguous', candidates: cands, certain: false, censored: false };
  }
  const v = cands[0];
  const observed = saleIso >= v.fs && saleIso <= lastSeen(v, index);
  const censored = v.onb == null && saleIso < v.fs;
  if (v.cna != null && redrawnOnly(versions, cands)) return { state: 'realigned', candidates: [v], certain: observed, censored };
  return { state: v.cna == null ? 'current' : 'prior', candidates: [v], certain: observed, censored };
}

/**
 * True when every change after the earliest closed candidate is a map
 * realignment (r/parcel_history_lib.R tag_realignments): the parcel that sold
 * is today's, redrawn. Same rule as build_change_shards.R uses to drop the
 * outline, so a 'realigned' sale never needs one.
 */
function redrawnOnly(versions, cands) {
  const closed = cands.filter((v) => v.cna != null);
  if (!closed.length) return false;
  const from = closed.reduce((a, b) => (b.fs < a.fs ? b : a));
  if (from.c !== 'realigned') return false;
  const later = versions.filter((v) => v.fs > from.fs);
  return later.length > 0 && later.every((v) => v.o === 'realigned');
}

const LABELS = {
  current:   'Same as today',
  prior:     'Changed since sale',
  ambiguous: 'Changed near sale',
  not_yet:   'Not yet mapped at sale',
  retired:   'Roll retired',
  realigned: 'Same parcel, map redrawn',
};

/** Grid cell text; null for "no claim" (no date, or no history loaded). */
export function historyLabel(m) {
  if (!m || m.state === 'unknown') return null;
  if (m.state === 'current' && m.censored) return 'Same since history began';
  return LABELS[m.state] || null;
}

/**
 * The Outline filter's reading of one sale: 'unchanged' only when today's
 * outline is KNOWN to be the one that sold, 'changed' for any change claim,
 * null for no claim. A censored "same since history began" sale predates the
 * first snapshot, so it is neither: the outline may have changed before then.
 */
export function outlineStatus(m) {
  if (!m) return null;
  if (m.state === 'current') return m.censored ? null : 'unchanged';
  // Redrawn at the same area: today's acreage and parcel still describe the sale.
  if (m.state === 'realigned') return m.censored ? null : 'unchanged';
  if (['prior', 'ambiguous', 'not_yet', 'retired'].includes(m.state)) return 'changed';
  return null;
}

/**
 * One sale's status from its parcels' statuses, so an assembly is kept or
 * dropped whole: changed if ANY parcel changed (the group acreage no longer
 * describes today's land), unchanged only if EVERY parcel is, else null.
 */
export function groupOutlineStatus(statuses) {
  const list = statuses || [];
  if (list.includes('changed')) return 'changed';
  if (list.length && list.every((s) => s === 'unchanged')) return 'unchanged';
  return null;
}

/**
 * CSV cells for a sale: [label, change window, outline acres at sale].
 * The window is two SNAPSHOT dates ('YYYY-MM-DD to YYYY-MM-DD') bracketing
 * the change, never a change date: the province publishes none. Acres only
 * when one earlier outline is certainly the one that sold ('prior').
 */
export function outlineCsvCells(m, index) {
  const label = historyLabel(m) || '';
  if (!m) return [label, '', ''];
  let win = '';
  let acres = '';
  if (m.state === 'prior' || m.state === 'ambiguous' || m.state === 'realigned') {
    const v = (m.candidates || []).find((c) => c.cna != null);
    if (v) win = `${lastSeen(v, index)} to ${v.cna}`;
    const a = Number(v?.a);
    if (m.state === 'prior' && Number.isFinite(a) && a > 0) acres = (a / 4046.8564224).toFixed(3);
  } else if (m.state === 'not_yet' && m.earliest?.onb) {
    win = `${m.earliest.onb} to ${m.earliest.fs}`;
  }
  return [label, win, acres];
}

/** Sort rank for the grid column: most-changed first, no-claim last. */
export function historyRank(m) {
  const order = { prior: 0, ambiguous: 1, not_yet: 2, retired: 3, realigned: 4, current: 5 };
  if (!m || !(m.state in order)) return 9;
  return m.state === 'current' && m.censored ? 6 : order[m.state];
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
    : p.c === 'reshaped_during_gap' ? 'Outline changed (roll briefly missing from the data)'
    : p.c === 'realigned' ? 'Map redrawn (same parcel, area within 1%)' : 'Outline changed';
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
  } else if (m.state === 'prior' && m.candidates[0]?.c === 'retired') {
    const v = m.candidates[0];
    rows.push(`<strong>This roll no longer exists.</strong> It was retired ${esc(changeWindowText(v, index))}, after the sale; the parcel is drawn from its last outline in the history.`);
    rows.push(`Area at sale: ${esc(fmtArea(v.a))}`);
    if (m.censored) rows.push(`<small>Outline as of ${esc(first)}; the sale predates the history.</small>`);
    rows.push(lineageLine(v.rel, v.to, '→ land now in').replace(/^<br>/, ''));
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
  } else if (m.state === 'realigned') {
    const v = m.candidates.find((c) => c.cna != null) || m.candidates[0];
    rows.push(`<strong>Same parcel, map redrawn.</strong> The province redrew the parcel map here ${esc(changeWindowText(v, index))}, moving the outline without changing its area (within 1%), so today's outline is the parcel that sold.`);
    rows.push(`Area at sale: ${esc(fmtArea(v.a))}`);
    if (m.censored) rows.push(`<small>Outline as of ${esc(first)}; the sale predates the history.</small>`);
  } else if (m.state === 'not_yet') {
    const v = m.earliest;
    rows.push(`<strong>This roll was not yet on the province's parcel map on the sale date</strong>; it first appears ${esc(fmtDay(v?.fs))}. New lots are often assessed and sold before they are mapped, so the outline shown is today's.`);
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
 * Lineage for the Historical (as-of) view, from the weekly change shard: per
 * roll, the version alive on the snapshot date and the rolls it came from /
 * became. Replaces the semiannual lineage/<muni>.json, which compared only the
 * archived snapshots and was rebuilt by hand. Shape is what map.js
 * lineageHtml() reads: { type, predecessors: [{roll}], successors: [{roll}] }.
 * Rolls with no lineage at that date are absent; null when there is no shard.
 */
export function lineageByRoll(shard, snapIso, index) {
  if (!shard?.rolls || !snapIso) return null;
  const out = {};
  for (const [roll, versions] of Object.entries(shard.rolls)) {
    const v = (versions || []).find((x) => x.fs <= snapIso && snapIso <= lastSeen(x, index));
    if (!v || (!v.from?.length && !v.to?.length)) continue;
    out[roll] = {
      type: v.rel || null,
      predecessors: (v.from || []).map((r) => ({ roll: r })),
      successors: (v.to || []).map((r) => ({ roll: r })),
    };
  }
  return out;
}

const normName = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

/**
 * Muni number for a Roll Entry muni name ("RITCHOT (RM)"), from the change
 * index's per-muni `name`. Null when the index does not list the muni — which
 * also means it has no retired rolls to find.
 */
export function historyMuniNoForName(index, name) {
  const want = normName(name);
  if (!want || !index?.munis) return null;
  for (const [no, info] of Object.entries(index.munis)) {
    if (normName(info?.name) === want) return Number(no);
  }
  return null;
}

// OBJECTIDs for parcels drawn from the history. ROLL_ENTRY's own run to
// about 450k, so these can never collide with a live parcel — anything that
// looks one up in the service simply finds nothing.
const HISTORY_OID_BASE = 2_000_000_000;
let historyOidSeq = 0;

/**
 * Parcel features for rolls that are NOT in today's Roll_Entry but are in the
 * change history: retired rolls, drawn from the last outline they had. One
 * feature per roll (the sales pipeline clones it per sale); the per-sale
 * outline, where a roll had several, is drawn by saleOutlineFeatures.
 *
 * A roll whose history still has a CURRENT version is skipped: it exists
 * today, so a Roll_Entry miss is some other problem and must stay unmatched
 * rather than be papered over with an old outline.
 *
 * @param {object} shard   changes/<muni_no>.json
 * @param {string[]} rolls Roll_No_Txt values Roll_Entry did not return
 * @param {{muniNo:number, muniName:string}} muni
 * @returns {object[]} GeoJSON features with Roll_Entry-shaped properties
 */
export function historicalRollFeatures(shard, rolls, { muniNo, muniName }) {
  const out = [];
  for (const roll of rolls || []) {
    const versions = shard?.rolls?.[roll];
    if (!versions?.length || versions.some((v) => v.cna == null)) continue;
    const outlines = (shard.outlines?.features || []).filter((f) => f.properties?.roll === roll && f.geometry);
    if (!outlines.length) continue;
    const last = outlines.reduce((a, b) => (b.properties.fs > a.properties.fs ? b : a));
    out.push({
      type: 'Feature',
      geometry: last.geometry,
      properties: {
        OBJECTID: HISTORY_OID_BASE + (++historyOidSeq),
        Roll_No_Txt: roll,
        Municipality: `${muniNo} - ${muniName}`,
        Muni_Name_With_Typ: muniName,
        Property_Address: null,
        // Marks the row and popup: this parcel is from the history, not Roll_Entry.
        _fromHistory: true,
        _retiredWindow: changeWindowText(last.properties, null),
      },
    });
  }
  return out;
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
