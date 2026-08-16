// dataStatus.js — pure logic for the Data Status tab: normalising each data
// source's vintage into table rows. DOM and fetching live in
// src/dataStatusTab.js; everything here is testable without a browser.
//
// Sales coverage is deliberately absent — it is subscriber-derived and renders
// only inside the Sales Analysis panel (SPEC-DATA-STATUS-TAB.md).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/**
 * "2026-07" → "July 2026". The assessment ledger is MONTH precision — a
 * cohort, not a scrape day — so this is the only honest rendering. Anything
 * that isn't YYYY-MM passes through untouched.
 */
export function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym ?? ''));
  if (!m) return ym == null ? null : String(ym);
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return String(ym);
  return `${MONTHS[idx]} ${m[1]}`;
}

/** ISO timestamp → date part, for table cells. Null-safe. */
export function datePart(ts) {
  if (!ts || typeof ts !== 'string') return null;
  return ts.slice(0, 10);
}

/**
 * Rows for the per-municipality table from data/muni-vintage.json.
 * Returns null when the file is missing/empty so the UI can say so.
 */
export function vintageRows(json) {
  const rows = json?.rows;
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows.map((r) => ({
    no: String(r.muni_no ?? ''),
    name: r.name || `Muni ${r.muni_no}`,
    region: r.region || null,
    month: r.last_refreshed || null,
    label: r.last_refreshed ? monthLabel(r.last_refreshed) : null,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * An ArcGIS service's ?f=json response → its last-edit date (ISO date), or
 * null when the service doesn't expose one. dataLastEditDate is epoch ms.
 */
export function serviceEditDate(json) {
  const ms = json?.editingInfo?.dataLastEditDate;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The newest snapshot entry from the historical archive index
 * ({snapshots: {"2026-07-01": {layers: {...}}}}). Snapshot ids are ISO dates,
 * so a string sort finds the newest. Returns {id, layers} or null.
 */
export function newestSnapshot(histIndex) {
  const snaps = histIndex?.snapshots;
  if (!snaps || typeof snaps !== 'object') return null;
  const ids = Object.keys(snaps).sort();
  if (!ids.length) return null;
  const id = ids[ids.length - 1];
  return { id, layers: snaps[id]?.layers || {} };
}

/**
 * Rows for the "Published site data" table. Every input is optional — a
 * fetch that failed contributes a row with vintage null rather than
 * disappearing, so the table always says what it could not learn.
 *
 * @param {Object} opts
 * @param {Object} [opts.manifest]  /data/manifest.json (datasets.*)
 * @param {Object} [opts.rollSnap]  rollentry-snapshot/_index.json off the CDN
 * @param {Object} [opts.histIndex] mb-parcel-history index.json
 * @param {string} [opts.revision]  pinned mb-parcel-data commit SHA
 */
export function publishedRows({ manifest, rollSnap, histIndex, revision } = {}) {
  const rows = [];
  const ds = manifest?.datasets || {};

  const idx = (name, label) => {
    const e = ds[name];
    rows.push({
      label,
      vintage: datePart(e?.generated_at || e?.modified_at),
      detail: e?.row_count != null ? `${Number(e.row_count).toLocaleString()} rows` : null,
    });
  };
  idx('legal_index', 'Legal descriptions index');
  idx('assessment_index', 'Assessment index');

  rows.push({
    label: 'Roll Entry snapshot (offline fallback)',
    vintage: rollSnap?.snapshot_date || null,
    detail: rollSnap?.source || null,
  });

  const snap = newestSnapshot(histIndex);
  for (const [key, label] of [
    ['zoning', 'Zoning by-laws (archived snapshot)'],
    ['devplan', 'Development plan (archived snapshot)'],
    ['parcels', 'Parcels (archived snapshot)'],
  ]) {
    rows.push({
      label,
      vintage: snap?.layers?.[key]?.source_date || null,
      detail: snap ? `snapshot ${snap.id}` : null,
    });
  }

  rows.push({
    label: 'MASC ratings, land cover & water shards (CDN)',
    vintage: null,
    detail: revision ? `pinned at revision ${String(revision).slice(0, 7)}` : null,
  });

  return rows;
}
