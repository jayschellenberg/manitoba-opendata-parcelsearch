// Client-side lookup over the generated MAO scrape legal-description index.
// The index stores only lightweight search/join fields, then main.js asks
// ArcGIS Roll Entry for the live parcel geometry and current assessment data.

// The legal-search index is large (~130 MB) — too big to track in
// source control past GitHub's 100 MB single-file ceiling, and
// expensive to bundle into Vercel's static build. We host it as a
// GitHub Release asset and let the browser's HTTP cache handle
// re-use across visits (GitHub's release-asset CDN serves with
// reasonable Cache-Control headers).
//
// Locally, npm run dev still serves the file from web/public/data/
// (see vite.config.js) so the dev workflow doesn't depend on the
// release. The const below first tries the local copy and falls
// back to the release URL — production deploys don't ship the file
// so the local fetch 404s and the fallback runs; locally the
// in-tree copy wins and the fallback never fires.
//
// To publish a new index: regenerate via `Rscript r/build_legal_index.R`,
// then upload to a fresh release tag (or replace the asset on the
// existing tag) and bump LEGAL_INDEX_RELEASE_URL below.
const LEGAL_INDEX_LOCAL_URL = `${import.meta.env?.BASE_URL || '/'}data/legal-index.json`;
const LEGAL_INDEX_RELEASE_URL = 'https://github.com/jayschellenberg/manitoba-opendata-parcelsearch/releases/download/data-2026-05-06/legal-index.json';
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
    let releaseRes;
    try {
      releaseRes = await fetch(LEGAL_INDEX_RELEASE_URL);
    } catch (err) {
      throw new Error(`Legal index could not be fetched from the GitHub Release: ${err.message}`);
    }
    if (!releaseRes.ok) {
      throw new Error(
        `Legal index not available locally (${LEGAL_INDEX_LOCAL_URL}) and the GitHub Release fetch returned ${releaseRes.status}. ` +
        `Confirm the release asset exists, or run \`Rscript r/build_legal_index.R\` and serve via npm run dev.`
      );
    }
    json = await releaseRes.json();
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
