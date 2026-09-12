// Per-CLI-class rollup of a parcel's soil composition.
//
// The composition rows are per SOIL (Red River 2W, Osborne 3W, …) and the
// popup caps them at three plus an "Other" remainder. An appraiser also
// wants the parcel by CAPABILITY — how much of it is class 2, how much 3W —
// which is the same numbers summed across soils. Computed from the FULL
// (uncapped) rows, so a class that only appears in soils folded into
// "Other" still counts. Pure; the popup renders it.

/**
 * @param {Array<{agriCap?:string, agcapCls?:string, parcelPct:number,
 *   areaAcres?:number, isOther?:boolean}>} rows  uncapped composition rows
 * @param {{ maxRows?: number }} [opts]  cap on classes shown; the rest fold
 *   into an "Other classes" row
 * @returns {Array<{cls:string, agcapCls:string, parcelPct:number,
 *   areaAcres:number|null, isOther?:boolean}>}  sorted by share, desc
 */
export function cliClassRollup(rows, { maxRows = 5 } = {}) {
  const byClass = new Map();
  for (const r of rows || []) {
    if (!r || r.isOther) continue;
    const pct = Number(r.parcelPct);
    if (!Number.isFinite(pct) || pct <= 0) continue;
    const cls = String(r.agriCap || r.agcapCls || '').trim() || 'Unrated';
    const cur = byClass.get(cls) || { cls, agcapCls: String(r.agcapCls || cls).trim(), parcelPct: 0, areaAcres: 0, hasAcres: false };
    cur.parcelPct += pct;
    if (Number.isFinite(Number(r.areaAcres))) { cur.areaAcres += Number(r.areaAcres); cur.hasAcres = true; }
    byClass.set(cls, cur);
  }
  const out = [...byClass.values()]
    .map(({ hasAcres, ...c }) => ({ ...c, parcelPct: Math.min(100, c.parcelPct), areaAcres: hasAcres ? c.areaAcres : null }))
    .sort((a, b) => b.parcelPct - a.parcelPct || a.cls.localeCompare(b.cls));
  if (!Number.isFinite(maxRows) || out.length <= maxRows) return out;
  const shown = out.slice(0, maxRows);
  const rest = out.slice(maxRows);
  const pct = rest.reduce((s, c) => s + c.parcelPct, 0);
  const acres = rest.every((c) => c.areaAcres == null) ? null : rest.reduce((s, c) => s + (c.areaAcres || 0), 0);
  if (pct > 0) shown.push({ cls: 'Other classes', agcapCls: '', parcelPct: Math.min(100, pct), areaAcres: acres, isOther: true });
  return shown;
}
