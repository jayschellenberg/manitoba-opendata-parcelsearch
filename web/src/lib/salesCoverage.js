// salesCoverage.js — pure logic for the "Scrape coverage" view on the Sales
// tab: which municipalities the MAO sales archive covers, when each was last
// scraped, and which are still waiting.
//
// The data comes from the LOCAL export's manifest.json (salesStore keeps it in
// IndexedDB). Newer exports carry a `coverage` array listing every
// municipality the sweep tracks — scraped or not — with the scrape date from
// the sweep's own ledger. Older exports predate it; the fallback derives what
// it can from `munis` (shard-holding municipalities only), and the UI says so.
//
// Sales coverage deliberately never reaches the public Data Status tab — see
// SPEC-DATA-STATUS-TAB.md. This module renders subscriber-derived state only
// inside the panel that already holds the local folder handle.

/**
 * Normalise one coverage/munis entry. `status` falls back to 'done' for a
 * munis-derived row: holding a shard IS evidence of a completed scrape, even
 * when the export predates explicit statuses.
 */
function normaliseRow(m, { fromMunis = false } = {}) {
  const no = String(m.muni_no ?? '');
  return {
    no,
    label: m.list_name || m.municipality || `Muni ${no}`,
    region: m.region || null,
    status: m.status || (fromMunis ? (m.scrape_status || 'done') : 'never'),
    lastScraped: m.last_scraped || m.scraped_at || null,
    sales: Number.isFinite(Number(m.sales)) && m.sales != null ? Number(m.sales) : null,
    newestSale: m.newest_sale || null,
    cappedRows: Number.isFinite(Number(m.capped_rows)) && m.capped_rows != null
      ? Number(m.capped_rows) : null,
  };
}

/**
 * Coverage rows from a stored manifest, sorted by place name.
 *
 * Returns { rows, complete }:
 *   rows     — normalised entries (see above)
 *   complete — true when the export shipped the full coverage table
 *              (municipalities that were never scraped included); false when
 *              rows were derived from `munis` and show captured ones only.
 * Returns null when the manifest offers nothing usable.
 */
export function coverageRows(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  if (Array.isArray(manifest.coverage) && manifest.coverage.length) {
    return {
      rows: manifest.coverage.map((m) => normaliseRow(m))
        .sort((a, b) => a.label.localeCompare(b.label)),
      complete: true,
    };
  }
  if (Array.isArray(manifest.munis) && manifest.munis.length) {
    return {
      rows: manifest.munis.map((m) => normaliseRow(m, { fromMunis: true }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      complete: false,
    };
  }
  return null;
}

/**
 * One-line summary for the dialog header: scraped count, tracked count,
 * most recent scrape date. `total` is null for an incomplete (munis-derived)
 * table, where the true universe is unknown.
 */
export function coverageSummary(coverage) {
  if (!coverage?.rows?.length) return null;
  const scraped = coverage.rows.filter((r) => r.status === 'done').length;
  let latest = null;
  for (const r of coverage.rows) {
    if (r.lastScraped && (latest == null || r.lastScraped > latest)) latest = r.lastScraped;
  }
  return {
    scraped,
    total: coverage.complete ? coverage.rows.length : null,
    latest,
  };
}

/** Human wording for a row's scrape state. Raw statuses pass through. */
export function statusLabel(row) {
  if (row.status === 'done') return row.lastScraped ? `scraped ${row.lastScraped}` : 'scraped';
  if (row.status === 'never') return 'not yet scraped';
  if (row.status === 'error' || row.status === 'suspect') {
    return `${row.status} — retried automatically`;
  }
  return row.status;
}
