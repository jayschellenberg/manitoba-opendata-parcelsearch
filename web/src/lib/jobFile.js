/*
 * The job file (Jason, 2026-10-07): one JSON file that carries a Sales
 * Analysis assignment between browsers and machines, and back to a signed
 * report's exact charts — the land template's params.yml idea for the
 * website.
 *
 * It holds the sales that were loaded (their CSV text, so the file reopens
 * anywhere without the MAO database), the sidebar filters, the subject, the
 * grid's sort / unticked rows / stars, the comp tags and exclusion reasons,
 * and the Sales Charts page's settings. main.js gathers and applies it; this
 * module only builds, names and validates the document, so it runs under node
 * in test/jobFile.test.js.
 *
 * The embedded sales can be MAO subscriber data: the file is written to the
 * user's own disk and never uploaded, but it should be kept as privately as
 * the CSV export.
 */

export const JOB_APP = 'manitoba-parcelsearch-job';
export const JOB_VERSION = 1;

/** Assemble the document. Every part is optional except the sales. */
export function buildJob({
  savedAt = new Date().toISOString(), build = '', name = '', sales, sidebar = {}, subject = null,
  grid = {}, tags = null, reasons = {}, charts = {}, overlays = [], columns = null,
} = {}) {
  if (!sales || typeof sales.text !== 'string' || !sales.text) throw new Error('No sales are loaded to save.');
  return {
    app: JOB_APP,
    version: JOB_VERSION,
    savedAt,
    build,
    name,
    sales: { name: String(sales.name || 'sales.csv'), text: sales.text },
    sidebar: {
      controls: sidebar.controls || {},
      multis: sidebar.multis || {},
      pills: sidebar.pills || {},
    },
    subject,
    grid: {
      sort: grid.sort || null,
      unticked: grid.unticked || [],
      starred: grid.starred || [],
    },
    tags,
    reasons,
    charts: { opts: charts.opts || null, workfileOff: charts.workfileOff || [] },
    // The main map's pressed layer toggles, by button id stem ("zoning",
    // "flood-dfa"…) — the shared-link format (2026-10-07).
    overlays: Array.isArray(overlays) ? overlays.filter((o) => typeof o === 'string') : [],
    // The grid's column preset (re-applied on open, which re-runs the
    // Agricultural soil / water-rights load) and the columns showing.
    columns: columns && typeof columns === 'object' ? {
      preset: typeof columns.preset === 'string' ? columns.preset : null,
      visible: Array.isArray(columns.visible) ? columns.visible.filter((k) => typeof k === 'string') : [],
    } : null,
  };
}

/**
 * Read a job file's text into a document, or throw an Error whose message
 * can be shown as it is. Unknown later versions are refused rather than
 * half-applied.
 */
export function parseJob(text) {
  let doc;
  try { doc = JSON.parse(String(text ?? '')); } catch { throw new Error('This is not a job file (it is not valid JSON).'); }
  if (!doc || typeof doc !== 'object' || doc.app !== JOB_APP) {
    throw new Error('This is not a Manitoba Parcel Search job file.');
  }
  if (!Number.isInteger(doc.version) || doc.version < 1) throw new Error('This job file has no valid version.');
  if (doc.version > JOB_VERSION) {
    throw new Error(`This job file was saved by a newer version of the site (job version ${doc.version}). Reload the page and try again.`);
  }
  if (!doc.sales || typeof doc.sales.text !== 'string' || !doc.sales.text) {
    throw new Error('This job file holds no sales.');
  }
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    ...doc,
    sidebar: { controls: obj(doc.sidebar?.controls), multis: obj(doc.sidebar?.multis), pills: obj(doc.sidebar?.pills) },
    subject: doc.subject && typeof doc.subject === 'object' ? doc.subject : null,
    grid: {
      sort: doc.grid?.sort && typeof doc.grid.sort.col === 'string' ? doc.grid.sort : null,
      unticked: arr(doc.grid?.unticked).filter((k) => typeof k === 'string'),
      starred: arr(doc.grid?.starred).filter((k) => typeof k === 'string'),
    },
    reasons: obj(doc.reasons),
    charts: { opts: doc.charts?.opts && typeof doc.charts.opts === 'object' ? doc.charts.opts : null, workfileOff: arr(doc.charts?.workfileOff) },
    // Absent in jobs saved before 2026-10-07: no toggles to restore.
    overlays: Array.isArray(doc.overlays) ? doc.overlays.filter((o) => typeof o === 'string') : null,
    // Absent in older jobs: the grid's columns are left as they are.
    columns: doc.columns && typeof doc.columns === 'object' ? {
      preset: typeof doc.columns.preset === 'string' ? doc.columns.preset : null,
      visible: Array.isArray(doc.columns.visible) ? doc.columns.visible.filter((k) => typeof k === 'string') : null,
    } : null,
  };
}

/** "job-123400-2026-10-07.json" — the subject roll when there is one. */
export function jobFileName(subjectRoll, dateText) {
  const who = String(subjectRoll || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sales';
  return `job-${who}-${dateText}.json`;
}

/**
 * Which sidebar controls a job captures. Data-source pickers are left out —
 * the job carries the sales themselves — and so are file inputs and the
 * checkboxes that only back a pill (the pill is restored instead).
 */
export function isJobControl({ id = '', type = '', className = '' } = {}) {
  if (!id || type === 'file') return false;
  if (/^sales-(prov|db)-/.test(id) || id === 'recent-uploads-select') return false;
  if (/(^|\s)pill-backing(\s|$)/.test(className)) return false;
  if (['numbering-toggle', 'numbering-order-toggle', 'pin-toggle'].includes(id)) return false;
  return true;
}

/** Pills a job leaves alone: data-source ones. */
export const JOB_SKIPPED_PILLS = ['adjacent'];
