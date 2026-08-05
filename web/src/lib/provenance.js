/*
 * Evidence-export provenance.
 *
 * Every CSV and parcel-snapshot export this app produces can end up pasted
 * into an appraisal report, so each one should be able to answer, on its own
 * face: WHEN was this pulled, by WHICH version of the tool, from WHAT sources,
 * and with WHAT caveats. This module builds that record and renders it two
 * ways:
 *   - provenanceCsvLines() — a `#`-prefixed comment preamble prepended to the
 *     CSV (single column, so it reads cleanly at the top of a spreadsheet and
 *     is trivial to delete; a re-import can skip `#` lines).
 *   - provenanceText()     — a plain-text block written as PROVENANCE.txt
 *     inside the snapshot ZIP.
 *
 * Nothing here touches the DOM or fetches — callers pass in the runtime facts
 * (row count, sales/historical context, the cached data manifest) so the
 * builders stay pure and unit-testable.
 */

import { SERVICE_SOURCES } from '../arcgis.js';
import { WALLAS_SOURCES } from '../wallas.js';

// Build identity, baked in by Vite `define` (see vite.config.js). The typeof
// guards keep dev/test runs — where `define` hasn't substituted them — working
// instead of throwing ReferenceError on the bare identifiers.
export const APP_COMMIT =
  typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : 'dev';
export const APP_BUILD_TIME =
  typeof __APP_BUILD_TIME__ !== 'undefined' ? __APP_BUILD_TIME__ : null;

// The standing caveat that travels with every export. Deliberately blunt: the
// figures are research-grade pointers, not legal determinations or survey
// measurements.
export const EXPORT_DISCLAIMER =
  'Research-grade data compiled to support appraisal work — not a legal or survey product. ' +
  "Areas (acres/SF) are the assessor's recorded area from the provincial roll where one is " +
  'published, and are otherwise computed by this app from the parcel polygon; the "Acres Src" ' +
  'column states which was used for each row. Both are approximate. The "Area Check" column is ' +
  'populated when the recorded area and the polygon disagree by more than 2%, which can indicate ' +
  'a subdivision or consolidation that has reached only one of them. Note also that the provincial ' +
  'roll extract trails Manitoba Assessment Online, so a recent parcel change may not appear here at ' +
  'all, in either figure. Confirm against the registered plan, certificate of title, and the ' +
  'assessment roll. ' +
  'Zoning and Development Plan designations are matched by spatial overlap and are pointers to verify ' +
  'with the municipality, planning district, or Manitoba Assessment Online — they are not zoning ' +
  'determinations. Land-cover percentages derive from the 2020 provincial land-cover raster and are ' +
  'visualization estimates. Verify every figure before relying on it.';

// Appended only when the export actually carries water-rights data. The
// lag is the part that matters: WALLAS's tile-drainage polygon layer runs
// roughly a year or more behind its own application tracker, and only
// licensed works are ever in it. A blank Tile column is therefore weak
// evidence of anything, and saying so on the face of the export is the
// only way that survives being pasted into a report.
export const WATER_RIGHTS_CAVEAT =
  'Tile-drainage and irrigation figures come from Manitoba Water Rights Licensing (WALLAS) and cover ' +
  'LICENSED works only — unlicensed or older installations do not appear. The tile-drainage polygon ' +
  'layer lags its own application tracker by a year or more, and its area/depth/spacing detail fields ' +
  'are populated on a small minority of records. Absence of a tile-drainage record is NOT evidence that ' +
  'land is undrained; confirm with the landowner, the municipality, or Manitoba Water Rights Licensing.';

/**
 * Assemble the structured provenance record for one export.
 *
 * @param {Object} opts
 * @param {number} [opts.rowCount]       rows in the export (CSV) — omitted for maps.
 * @param {string} [opts.kind]           'csv' | 'parcel-snapshots' (free-text label).
 * @param {boolean} [opts.salesMode]     true when the CSV is a sales-comp export.
 * @param {boolean} [opts.starredOnly]   true when only starred rows were exported.
 * @param {Object|null} [opts.manifest]  the data manifest (manifest.getManifestSync()).
 * @param {Object|null} [opts.historical] historical-overlay context, when active:
 *        { active:true, snap:'YYYY-MM-DD', layerDates:{roll,zoning,devplan} }.
 * @param {Date} [opts.now]              export timestamp (injectable for tests).
 * @param {string} [opts.imagery]        basemap/imagery credit (snapshot exports).
 * @param {boolean} [opts.waterRights]   true when the export carries WALLAS
 *        tile-drainage / irrigation data — adds those endpoints to the cited
 *        sources and appends WATER_RIGHTS_CAVEAT. Left off otherwise so an
 *        export never cites a service it didn't read.
 * @returns {Object} the provenance record.
 */
export function buildProvenance(opts = {}) {
  const {
    rowCount,
    kind = 'export',
    salesMode = false,
    starredOnly = false,
    manifest = null,
    historical = null,
    now = new Date(),
    imagery = null,
    waterRights = false,
  } = opts;

  const liveSources = waterRights
    ? [...SERVICE_SOURCES, ...WALLAS_SOURCES]
    : SERVICE_SOURCES;

  return {
    tool: 'Manitoba Parcel Search',
    kind,
    exported_at: now.toISOString(),
    app_commit: APP_COMMIT,
    app_build_time: APP_BUILD_TIME,
    row_count: Number.isFinite(rowCount) ? rowCount : null,
    sales_mode: !!salesMode,
    starred_only: !!starredOnly,
    live_sources: liveSources.map((s) => ({ label: s.label, url: s.url })),
    data_refreshed: manifestFreshness(manifest),
    datasets: manifestDatasets(manifest),
    historical: normalizeHistorical(historical),
    imagery: imagery || null,
    disclaimer: EXPORT_DISCLAIMER,
    // Kept separate from `disclaimer` rather than concatenated so the
    // standing caveat stays byte-identical across every export.
    water_rights_caveat: waterRights ? WATER_RIGHTS_CAVEAT : null,
  };
}

// Most-recent generated_at/modified_at across the manifest's datasets — the
// "local enrichment data refreshed" date. Mirrors manifest.getOverallFreshness
// but works on an already-resolved object (sync path).
function manifestFreshness(m) {
  if (!m) return null;
  let latest = null;
  for (const entry of Object.values(m.datasets || {})) {
    const ts = entry?.generated_at || entry?.modified_at;
    if (ts && (latest == null || ts > latest)) latest = ts;
  }
  return latest || m.generated_at || null;
}

// Compact per-dataset list (name, schema version, refresh date) for the
// detailed text block. Empty array when no manifest is available.
function manifestDatasets(m) {
  if (!m?.datasets) return [];
  return Object.entries(m.datasets).map(([name, e]) => ({
    name,
    schema_version: e?.schema_version ?? null,
    refreshed: e?.generated_at || e?.modified_at || null,
    row_count: Number.isFinite(e?.row_count) ? e.row_count : null,
  }));
}

function normalizeHistorical(h) {
  if (!h?.active || !h?.snap) return null;
  const d = h.layerDates || {};
  return {
    active: true,
    snapshot: h.snap,
    layer_dates: { roll: d.roll || null, zoning: d.zoning || null, devplan: d.devplan || null },
  };
}

// ---- renderers ---------------------------------------------------------

/**
 * Provenance as an array of CSV preamble lines — each a single cell, caller
 * escapes them (so escaping stays in one place). Returns raw strings; the
 * leading `#` marks them as comments. A blank string in the array becomes a
 * blank CSV row separating the preamble from the table.
 */
export function provenanceCsvLines(prov) {
  const L = [];
  L.push(`# ${prov.tool} — evidence export`);
  L.push(`# Exported (UTC): ${prov.exported_at}`);
  L.push(`# App build: commit ${prov.app_commit}${prov.app_build_time ? ` · built ${prov.app_build_time}` : ''}`);
  if (prov.row_count != null) {
    const tags = [];
    if (prov.sales_mode) tags.push('sales comps');
    if (prov.starred_only) tags.push('starred only');
    L.push(`# Rows: ${prov.row_count}${tags.length ? ` (${tags.join(', ')})` : ''}`);
  }
  L.push('# Live provincial sources (queried at export time):');
  for (const s of prov.live_sources) L.push(`#   ${s.label}: ${s.url}`);
  if (prov.data_refreshed) {
    L.push(`# Local enrichment data refreshed: ${prov.data_refreshed}`);
  }
  if (prov.historical) {
    const h = prov.historical;
    const d = h.layer_dates;
    const parts = [];
    if (d.roll) parts.push(`Roll ${d.roll}`);
    if (d.zoning) parts.push(`Zoning ${d.zoning}`);
    if (d.devplan) parts.push(`Dev Plan ${d.devplan}`);
    L.push(`# Historical overlay was active on map: as-of ${h.snapshot}${parts.length ? ` (${parts.join(' · ')})` : ''}`);
    L.push('#   NOTE: the EXPORTED ROWS are current/live data, not this snapshot. Historical parcels are a');
    L.push('#   simplified (~2-3 m) visualization — resolve measurements to the archived source-of-record.');
  }
  L.push(`# Disclaimer: ${prov.disclaimer}`);
  if (prov.water_rights_caveat) L.push(`# Water rights: ${prov.water_rights_caveat}`);
  L.push(''); // blank row between preamble and the table header
  return L;
}

/**
 * Provenance as a human-readable plain-text block (PROVENANCE.txt in the
 * snapshot ZIP). Wider than the CSV preamble — includes the per-dataset list
 * and imagery credit.
 */
export function provenanceText(prov) {
  const out = [];
  out.push(`${prov.tool} — evidence export provenance`);
  out.push('='.repeat(56));
  out.push(`Export type:     ${prov.kind}`);
  out.push(`Exported (UTC):  ${prov.exported_at}`);
  out.push(`App commit:      ${prov.app_commit}`);
  if (prov.app_build_time) out.push(`App build time:  ${prov.app_build_time}`);
  if (prov.row_count != null) out.push(`Rows:            ${prov.row_count}`);
  if (prov.imagery) out.push(`Imagery credit:  ${prov.imagery}`);
  out.push('');
  out.push('Live provincial sources (queried at export time):');
  for (const s of prov.live_sources) out.push(`  - ${s.label}: ${s.url}`);
  out.push('');
  if (prov.data_refreshed) out.push(`Local enrichment data refreshed: ${prov.data_refreshed}`);
  if (prov.datasets?.length) {
    out.push('Datasets:');
    for (const d of prov.datasets) {
      const bits = [d.name];
      if (d.schema_version != null) bits.push(`schema v${d.schema_version}`);
      if (d.refreshed) bits.push(d.refreshed);
      if (d.row_count != null) bits.push(`${d.row_count.toLocaleString()} rows`);
      out.push(`  - ${bits.join(' · ')}`);
    }
  }
  if (prov.historical) {
    const h = prov.historical;
    const d = h.layer_dates;
    out.push('');
    out.push(`Historical overlay was active on map: as-of ${h.snapshot}`);
    if (d.roll) out.push(`  Roll source date:     ${d.roll}`);
    if (d.zoning) out.push(`  Zoning source date:   ${d.zoning}`);
    if (d.devplan) out.push(`  Dev Plan source date: ${d.devplan}`);
    out.push('  NOTE: the exported imagery shows current/live parcels with a simplified (~2-3 m)');
    out.push('  historical overlay — resolve measurements to the archived source-of-record.');
  }
  out.push('');
  out.push('Disclaimer:');
  for (const line of wrap(prov.disclaimer, 72)) out.push(`  ${line}`);
  if (prov.water_rights_caveat) {
    out.push('');
    out.push('Water rights (WALLAS):');
    for (const line of wrap(prov.water_rights_caveat, 72)) out.push(`  ${line}`);
  }
  out.push('');
  return out.join('\n');
}

/**
 * Append the "not captured" roll-call to a rendered provenance block.
 *
 * A snapshot batch can come up short when satellite imagery doesn't finish
 * loading for a subject — the export keeps every frame it did capture rather
 * than throwing the batch away. Someone counting images against a comp list
 * then needs to know whether a missing parcel was left out deliberately or
 * lost to a slow tile server, so the gap is recorded on the face of the
 * evidence record instead of being inferable only from the file listing.
 *
 * Returns the text unchanged when nothing was skipped.
 */
export function provenanceWithSkipped(text, skipped) {
  if (!skipped?.length) return text;
  const out = [
    text,
    `Not captured (${skipped.length}):`,
    ...wrap(
      'Satellite imagery for these subjects did not finish loading before the per-frame '
      + 'time limit, so no image was written. This is a transient network/imagery '
      + 'condition, not a data problem — re-run the export to fill the gaps.',
      72,
    ).map((line) => `  ${line}`),
    '',
  ];
  for (const name of skipped) out.push(`  - ${name}`);
  out.push('');
  return out.join('\n');
}

// Minimal greedy word-wrap for the text block's disclaimer paragraph.
function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const cand = line ? `${line} ${w}` : w;
    if (cand.length <= width) line = cand;
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}
