// Client-side lookup over the generated MAO scrape legal-description index.
// The index stores only lightweight search/join fields, then main.js asks
// ArcGIS Roll Entry for the live parcel geometry and current assessment data.

// The legal-search index is large (~130 MB) — too big to track in
// source control past GitHub's 100 MB single-file ceiling, too big
// to bundle into Vercel's static build, and too big to push through
// a vercel.json `rewrites` proxy (Vercel buffers static-asset
// rewrites and 502s past ~4-5 MB).
//
// Production hosting: the file is uploaded to a GitHub Release
// asset and served through a Vercel Edge Function at
// /api/legal-index (api/legal-index.js). The Edge runtime supports
// streaming responses, so a 130 MB body flows from GitHub through
// the edge to the browser without ever being buffered. The
// function adds Access-Control-Allow-Origin so the browser
// accepts the response (the upstream GitHub redirect chain
// doesn't send that header on either hop).
//
// Dev: vite serves any in-tree copy at web/public/data/legal-index.json
// directly. legalIndex.js tries the local URL first and falls back
// to /api/legal-index — in dev the local copy wins and the API path
// is never hit (vite doesn't run Vercel functions); in production
// the local file isn't shipped and the API path takes over.
//
// To publish a new index:
//   Rscript r/build_legal_index.R
//   gh release create data-YYYY-MM-DD web/public/data/legal-index.json --title "..."
// Then bump RELEASE_URL in api/legal-index.js. No client-side change
// needed; the browser HTTP cache will pick up the new file via the
// Cache-Control: max-age=604800 the function already sets, and the
// URL change invalidates any stale cached response automatically.
const LEGAL_INDEX_LOCAL_URL = `${import.meta.env?.BASE_URL || '/'}data/legal-index.json`;
const LEGAL_INDEX_PROXY_URL = '/api/legal-index';
const MAX_LEGAL_MATCHES = 1000;

const FIELD = {
  muni_no: 0,
  roll_no_txt: 1,
  extrct_prop_id: 2,
  municipality: 3,
  civic_address: 4,
  legal_description: 5,
  legal_detail: 6,
  lot: 7,
  block: 8,
  plan: 9,
  certificates_of_title: 10,
  source_url: 11,
};

let indexPromise = null;

export function hasLegalCriteria(criteria = {}) {
  return Boolean(
    real(criteria.legalText) ||
    real(criteria.lot) ||
    real(criteria.block) ||
    real(criteria.plan) ||
    real(criteria.title)
  );
}

export async function searchLegalIndex(criteria = {}) {
  if (!hasLegalCriteria(criteria)) {
    return { matches: [], truncated: false, metadata: null };
  }

  const index = await loadLegalIndex();
  const legalNeedle = normalizeContains(criteria.legalText);
  const lotNeedle   = normalizeLegalPart(criteria.lot, 'lot');
  const blockNeedle = normalizeLegalPart(criteria.block, 'block');
  const planNeedle  = normalizeLegalPart(criteria.plan, 'plan');
  const titleNeedle = normalizeTitle(criteria.title);
  const muniNeedle  = normalizeMunicipality(criteria.municipality);

  const matches = [];
  let truncated = false;
  for (const row of index.rows || []) {
    const rec = rowToRecord(row);
    const legalHaystack = normalizeContains(`${rec.legal_description} ${rec.legal_detail}`);
    if (muniNeedle && normalizeMunicipality(rec.municipality) !== muniNeedle) continue;
    if (legalNeedle && !legalHaystack.includes(legalNeedle)) continue;
    if (lotNeedle && normalizeLegalPart(rec.lot, 'lot') !== lotNeedle) continue;
    if (blockNeedle && normalizeLegalPart(rec.block, 'block') !== blockNeedle) continue;
    if (planNeedle) {
      const parsedPlanMatch = normalizeLegalPart(rec.plan, 'plan') === planNeedle;
      const rawPlanMatch = planNeedle.length >= 3 && legalHaystack.includes(planNeedle);
      if (!parsedPlanMatch && !rawPlanMatch) continue;
    }
    if (titleNeedle && !normalizeContains(rec.certificates_of_title).includes(titleNeedle)) continue;

    matches.push(rec);
    if (matches.length >= MAX_LEGAL_MATCHES) {
      truncated = true;
      break;
    }
  }

  return {
    matches,
    truncated,
    metadata: index.metadata || null,
  };
}

export function legalRecordKey(rec) {
  const muni = Number(rec?.muni_no);
  const roll = String(rec?.roll_no_txt || '').trim();
  if (!Number.isFinite(muni) || !roll) return null;
  return `${Math.trunc(muni)}|${roll}`;
}

export function parcelLegalKey(props = {}) {
  const muni = String(props.Municipality || '').match(/^\s*(\d+)\s*-/)?.[1];
  const roll = String(props.Roll_No_Txt || '').trim();
  if (!muni || !roll) return null;
  return `${Number(muni)}|${roll}`;
}

function loadLegalIndex() {
  if (!indexPromise) {
    indexPromise = fetchLegalIndex();
  }
  return indexPromise;
}

async function fetchLegalIndex() {
  // Try the in-tree dev copy first; in production it 404s and we
  // fall through to the GitHub Release asset. The local default
  // cache mode is fine — a 304 from a stale fetch is still cheap
  // and the release URL has its own cache headers.
  let json;
  try {
    const localRes = await fetch(LEGAL_INDEX_LOCAL_URL);
    if (localRes.ok) {
      json = await localRes.json();
    }
  } catch { /* network/parse failure on local — fall through */ }

  if (!json) {
    let proxyRes;
    try {
      proxyRes = await fetch(LEGAL_INDEX_PROXY_URL);
    } catch (err) {
      throw new Error(`Legal index proxy fetch failed: ${err.message}`);
    }
    if (!proxyRes.ok) {
      throw new Error(
        `Legal index not available locally (${LEGAL_INDEX_LOCAL_URL}) and the proxy at ${LEGAL_INDEX_PROXY_URL} returned ${proxyRes.status}. ` +
        `Confirm the GitHub Release asset exists and that vercel.json's rewrite for /proxy/legal-index.json points at it. ` +
        `For local dev, run \`Rscript r/build_legal_index.R\` to populate web/public/data/legal-index.json.`
      );
    }
    json = await proxyRes.json();
  }

  if (!json || !Array.isArray(json.rows)) {
    throw new Error('Legal index is malformed: expected a rows array.');
  }
  return json;
}

function rowToRecord(row) {
  return {
    muni_no: row[FIELD.muni_no],
    roll_no_txt: row[FIELD.roll_no_txt] || '',
    extrct_prop_id: row[FIELD.extrct_prop_id] || '',
    municipality: row[FIELD.municipality] || '',
    civic_address: row[FIELD.civic_address] || '',
    legal_description: row[FIELD.legal_description] || '',
    legal_detail: row[FIELD.legal_detail] || '',
    lot: row[FIELD.lot] || '',
    block: row[FIELD.block] || '',
    plan: row[FIELD.plan] || '',
    certificates_of_title: row[FIELD.certificates_of_title] || '',
    source_url: row[FIELD.source_url] || '',
  };
}

function real(v) {
  return v != null && String(v).trim() !== '';
}

function normalizeContains(v) {
  if (!real(v)) return '';
  return String(v).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function normalizeLegalPart(v, kind) {
  if (!real(v)) return '';
  let s = String(v).toUpperCase().trim();
  if (kind === 'lot') s = s.replace(/^(LOT|L)\s*[:#-]?\s*/, '');
  if (kind === 'block') s = s.replace(/^(BLOCK|BLK|B)\s*[:#-]?\s*/, '');
  if (kind === 'plan') s = s.replace(/^(PLAN|PL)\s*[:#-]?\s*/, '');
  return s.replace(/[^A-Z0-9]+/g, '');
}

function normalizeTitle(v) {
  if (!real(v)) return '';
  return String(v)
    .toUpperCase()
    .replace(/^(CERTIFICATE\s+OF\s+TITLE|CERTIFICATE|TITLE|CT|C\/T)\s*[:#-]?\s*/, '')
    .replace(/[^A-Z0-9]+/g, '');
}

function normalizeMunicipality(v) {
  if (!real(v)) return '';
  let s = String(v)
    .toUpperCase()
    .replace(/^\s*\d+\s*-\s*/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\bRURAL\s+MUNICIPALITY\s+OF\b/g, '')
    .replace(/\bRM\s+OF\b/g, '')
    .replace(/\bTOWN\s+OF\b/g, '')
    .replace(/\bCITY\s+OF\b/g, '')
    .replace(/\bVILLAGE\s+OF\b/g, '')
    .replace(/\bMUNICIPALITY\s+OF\b/g, '')
    .replace(/\bMUNICIPALITY\b/g, '')
    .replace(/\bTOWN\b/g, '')
    .replace(/\bCITY\b/g, '')
    .replace(/\bVILLAGE\b/g, '');
  return s.replace(/[^A-Z0-9]+/g, '');
}
