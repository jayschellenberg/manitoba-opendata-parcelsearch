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

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "2026-08-01" → "Aug 1, 2026" (Jason's display preference, 2026-08-17).
 * Parsed by hand rather than through Date: `new Date('2026-08-01')` is UTC
 * midnight, which toLocaleDateString renders as the PREVIOUS day anywhere
 * west of Greenwich — Manitoba included. Non-dates pass through untouched.
 */
export function dateLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return iso == null ? null : String(iso);
  const mi = Number(m[2]) - 1;
  if (mi < 0 || mi > 11) return String(iso);
  return `${MONTHS_SHORT[mi]} ${Number(m[3])}, ${m[1]}`;
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
    // The exact refresh day when the ledger recorded one; the cohort month
    // otherwise. Never both — the date IS that month's refresh.
    label: r.last_refreshed_date
      ? dateLabel(r.last_refreshed_date)
      : (r.last_refreshed ? monthLabel(r.last_refreshed) : null),
    // When the next full refresh is due under this municipality's cadence.
    // Month + year only — the nightly queue decides the day.
    next: nextCycleLabel(r.last_refreshed_date || r.last_refreshed, r.cadence_months),
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
 * @param {Object} [opts.mascMeta]  masc/_index.json `_meta` entry
 * @param {Object} [opts.waterMeta] water/_index.json `_meta` entry
 * @param {Date}   [opts.now]       injectable clock for the schedule rules
 */
export function publishedRows({ manifest, rollSnap, histIndex, revision, mascMeta,
                                waterMeta, now = new Date() } = {}) {
  const rows = [];
  const ds = manifest?.datasets || {};
  // Schedules, as registered in Task Scheduler on the build machine:
  // mb-parcelsearch-monthly-refresh on the 15th (indexes + RollEntry
  // snapshot), mb-parcelsearch-semiannual-archive on Jan 1 / Jul 1.
  const monthly = nextMonthlyLabel(now);
  const semiannual = nextSemiannualLabel(now);

  const idx = (name, label) => {
    const e = ds[name];
    rows.push({
      label,
      vintage: dateLabel(datePart(e?.generated_at || e?.modified_at)),
      detail: e?.row_count != null ? `${Number(e.row_count).toLocaleString()} rows` : null,
      next: monthly,
    });
  };
  idx('legal_index', 'Legal descriptions index');
  idx('assessment_index', 'Assessment index');

  rows.push({
    label: 'Roll Entry snapshot (offline fallback)',
    vintage: dateLabel(rollSnap?.snapshot_date || null),
    detail: rollSnap?.source || null,
    next: monthly,
  });

  const snap = newestSnapshot(histIndex);
  for (const [key, label] of [
    ['zoning', 'Zoning by-laws (archived snapshot)'],
    ['devplan', 'Development plan (archived snapshot)'],
    ['parcels', 'Parcels (archived snapshot)'],
  ]) {
    rows.push({
      label,
      vintage: dateLabel(snap?.layers?.[key]?.source_date || null),
      detail: snap ? `snapshot ${snap.id}` : null,
      next: semiannual,
    });
  }

  rows.push({
    label: 'MASC soil productivity ratings',
    vintage: dateLabel(mascRunDate(mascMeta) || datePart(mascMeta?.generated_at)),
    detail: mascMeta?.run ? `scrape ${mascMeta.run}` : (mascMeta?.source || null),
    // A target, not a schedule — the scrape is run by hand (see mascNextLabel).
    next: mascNextLabel(mascMeta),
  });

  // Land cover's base file is fixed: the Canada Lands Cover Register 2020
  // (Jason, 2026-08-17). A pipeline timestamp would only say when the shards
  // were re-cut; the data's vintage is the register itself.
  rows.push({
    label: 'Land cover',
    vintage: '2020',
    detail: 'Canada Lands Cover Register 2020 (base file)',
    next: 'static',
  });

  // Like the MASC row, the run date embedded in the source parquet's name
  // beats generated_at — a shard rebuild day says nothing about when the
  // waterfront detection actually ran.
  rows.push({
    label: 'Water shards (CDN)',
    vintage: dateLabel(assemblyRunDate(waterMeta) || datePart(waterMeta?.generated_at)),
    detail: revision ? `pinned at revision ${String(revision).slice(0, 7)}` : null,
    next: null,
  });

  return rows;
}

// ---- "next scheduled" helpers (Jason, 2026-08-17) ---------------------------
// All month-and-year by design: the schedules are month-granular (cohorts,
// the monthly refresh, the semiannual archive), so a day would be invented.

/**
 * The month `months` after a YYYY-MM or YYYY-MM-DD vintage, as "February
 * 2027". The next cycle for anything cadence-driven. Null in, null out.
 */
export function nextCycleLabel(last, months) {
  const m = /^(\d{4})-(\d{2})/.exec(String(last ?? ''));
  if (!m || !Number.isFinite(months)) return null;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + Number(months);
  return monthLabel(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`);
}

/** Next run of the monthly index refresh (the 15th), as month + year. */
export function nextMonthlyLabel(now = new Date()) {
  const y = now.getFullYear(); const mo = now.getMonth();
  const passed = now.getDate() > 15;
  const total = y * 12 + mo + (passed ? 1 : 0);
  return monthLabel(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`);
}

/** Next semiannual archive capture (Jan 1 / Jul 1), as month + year. */
export function nextSemiannualLabel(now = new Date()) {
  const y = now.getFullYear(); const mo = now.getMonth();
  if (mo === 0 && now.getDate() === 1) return `January ${y}`;
  return mo < 6 ? `July ${y}` : `January ${y + 1}`;
}

/**
 * MASC's next-update target: a year after the last scrape run. The scrape is
 * run by hand — no scheduled task exists — so this is a TARGET, hence the
 * tilde (Jason's call, 2026-08-17).
 */
export function mascNextLabel(meta) {
  const next = nextCycleLabel(mascRunDate(meta), 12);
  return next ? `~${next}` : null;
}

/**
 * The assembly run date out of a water/landcover `_meta` entry — the source
 * parquet is named MAOParcelOutput[Ag]<YYYYMMDD>.parquet, and that date IS
 * the data's vintage; generated_at only says when the shards were re-cut.
 */
export function assemblyRunDate(meta) {
  const m = /(\d{4})(\d{2})(\d{2})\.parquet$/.exec(meta?.source || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * The MASC scrape date out of the masc/_index.json `_meta` entry — the
 * run dir name (run_YYYYMMDD_HHMMSS) IS the scrape date, and it beats
 * generated_at, which only says when the shards were rebuilt.
 */
export function mascRunDate(meta) {
  const m = /^run_(\d{4})(\d{2})(\d{2})_/.exec(meta?.run || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * A WALLAS-style statistics response ({features:[{attributes:{newest}}]})
 * → ISO date of the newest record, or null. The provincial MapServer is
 * ArcGIS 10.51 and publishes no editingInfo, so the newest record's
 * APPLICATION_DATE is the best available currency signal.
 */
export function statMaxDate(json) {
  const ms = json?.features?.[0]?.attributes?.newest;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString().slice(0, 10);
}
