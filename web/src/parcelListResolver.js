/*
 * Parcel-list resolver. Takes the rows produced by applyMapping() in
 * lib/parcelListParser.js and emits parcelKeys ({muni_no, roll_no_txt})
 * for the existing searchParcels() path. Resolution priority per row:
 *
 *   1. muniNo supplied — trusted as-is, no lookup
 *   2. muniName supplied — reconciled to a muni_no via the injected
 *      resolveMuniNames (Roll Entry name lookup); the sales-export shape
 *   3. title supplied — match against legal-index candidates by roll
 *   4. legal supplied — grid needle or lot/block/plan match
 *
 * Title beats legal when both are present (title is exact, legal is
 * substring). A cross-check between supplied muni and legal-resolved
 * muni is intentionally NOT done — the user said the supplied muni is
 * authoritative. A row that listed several rolls in one cell has already
 * been expanded by the parser into one row per parcel, and the members
 * carry no shared identity: Property Search shows every parcel on its own.
 *
 * Performance: regardless of row count, the resolver makes ONE bulk
 * call to lookupLegalRecordsByRollSet, scanning the legal index just
 * once. Per-row filtering then runs in main-thread memory off the
 * returned Map.
 */

import { lookupLegalRecordsByRollSet } from './legalIndex.js';
import { gridNeedle } from './lib/parcelListParser.js';

// ---- normalizers (mirror legalIndex.core.js so we don't depend on
//      its internals — the duplication is small and keeps coupling
//      one-way) ------------------------------------------------------

function normalizeLegalText(v) {
  if (v == null) return '';
  let s = String(v).toUpperCase().replace(/\s+/g, ' ').trim();
  s = s.replace(/\b0+(\d)/g, '$1');  // drop leading zeros on numbers
  s = s.replace(/-+/g, '');
  return s;
}

function normalizeContains(v) {
  if (v == null) return '';
  return String(v).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function normalizeTitle(v) {
  if (v == null) return '';
  return String(v)
    .toUpperCase()
    .replace(/^(CERTIFICATE\s+OF\s+TITLE|CERTIFICATE|TITLE|CT|C\/T)\s*[:#-]?\s*/, '')
    .replace(/[^A-Z0-9]+/g, '');
}

function normalizeLegalPart(v) {
  if (v == null) return '';
  return String(v).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

// ---- per-row match predicates ------------------------------------

function titleMatches(rec, rowTitle) {
  const needle = normalizeTitle(rowTitle);
  if (!needle) return false;
  const hay = normalizeContains(rec.certificates_of_title);
  return hay.includes(needle);
}

function legalMatches(rec, token) {
  if (!token || token.kind === 'unparseable') return false;
  if (token.kind === 'grid') {
    const hay = normalizeLegalText(`${rec.legal_description} ${rec.legal_detail}`);
    return hay.includes(gridNeedle(token));
  }
  // LBP — index has dedicated lot/block/plan fields.
  if (token.kind === 'lbp') {
    const lot = normalizeLegalPart(rec.lot);
    const block = normalizeLegalPart(rec.block);
    const plan = normalizeLegalPart(rec.plan);
    const wantLot = String(token.lot);
    const wantBlock = String(token.block);
    const wantPlan = String(token.plan);
    // Strict match on all three. The index sometimes stores blank
    // block/lot for plan-of-survey parcels; in that case the plan
    // alone is enough.
    if (plan === wantPlan && (lot === wantLot || !lot) && (block === wantBlock || !block)) {
      return true;
    }
    // Fallback: substring against raw legal text (matches
    // searchLegalIndex's rawPlanMatch path).
    const stripped = normalizeContains(`${rec.legal_description} ${rec.legal_detail}`);
    if (wantPlan.length >= 3 && stripped.includes(wantPlan)) return true;
    return false;
  }
  return false;
}

// ---- main entry point --------------------------------------------

/**
 * Resolve a parsed parcel list to parcelKeys ready for searchParcels.
 *
 * @param {Array<{lineNo, roll, muniNo, legal, title, raw}>} rows
 * @returns {Promise<{
 *   resolved: Array<{lineNo, muniNo, roll, via, raw}>,
 *   unresolved: Array<{lineNo, roll, muniNo, legal, title, raw, reason}>,
 *   parcelKeys: Array<{muni_no, roll_no_txt}>,
 *   stats: { total, resolved, unresolved, byVia: {muni, title, legal} },
 * }>}
 */
export async function resolveParcelList(rows, opts = {}) {
  // Lookup function is injected so node tests can pass a synthetic
  // legal-index without going through the worker / fetch path.
  const lookupRollSet = opts.lookupRollSet || lookupLegalRecordsByRollSet;
  const resolveMuniNames = opts.resolveMuniNames || null;
  const resolved = [];
  const unresolved = [];
  const stats = { total: rows.length, resolved: 0, unresolved: 0, byVia: { muni: 0, muniName: 0, title: 0, legal: 0 } };

  // Bucket rows by resolution strategy. A supplied numeric muni is
  // trusted as-is; a municipality NAME resolves via Roll Entry (the
  // injected resolveMuniNames); everything else falls to the
  // legal-index lookup.
  const needsLookup = [];
  const needsMuniName = [];
  for (const row of rows) {
    if (!row.roll) {
      unresolved.push({ ...row, reason: 'Row has no roll # — cannot resolve to a parcel' });
      continue;
    }
    if (Number.isFinite(row.muniNo)) {
      resolved.push({
        lineNo: row.lineNo,
        muniNo: row.muniNo,
        roll: row.roll,
        via: 'muni-supplied',
        site: row.site ?? null,
        raw: row.raw,
      });
      stats.byVia.muni++;
      continue;
    }
    if (row.muniName) {
      needsMuniName.push(row);
      continue;
    }
    needsLookup.push(row);
  }

  // Municipality-name resolution — one bulk call to the injected Roll
  // Entry helper, which returns per-line {muni_no, roll_no_txt} matches
  // plus miss reasons. Injected so this module stays network-free and
  // unit-testable (node tests pass a synthetic resolver).
  if (needsMuniName.length > 0) {
    if (typeof resolveMuniNames !== 'function') {
      for (const row of needsMuniName) {
        unresolved.push({ ...row, reason: 'Municipality-name resolution is unavailable in this context' });
      }
    } else {
      let nameOut = null;
      try {
        nameOut = await resolveMuniNames(
          needsMuniName.map((r) => ({ lineNo: r.lineNo, muniName: r.muniName, roll: r.roll })),
        );
      } catch (err) {
        for (const row of needsMuniName) {
          unresolved.push({ ...row, reason: `Municipality lookup failed: ${err.message || err}` });
        }
      }
      if (nameOut) {
        const hits = nameOut.resolvedByLine instanceof Map ? nameOut.resolvedByLine : new Map();
        const misses = nameOut.unresolvedByLine instanceof Map ? nameOut.unresolvedByLine : new Map();
        for (const row of needsMuniName) {
          const hit = hits.get(row.lineNo);
          if (hit && Number.isFinite(Number(hit.muni_no))) {
            resolved.push({
              lineNo: row.lineNo,
              muniNo: Number(hit.muni_no),
              roll: hit.roll_no_txt || row.roll,
              via: 'muni-name',
              site: row.site ?? null,
              raw: row.raw,
            });
            stats.byVia.muniName++;
          } else {
            unresolved.push({
              ...row,
              reason: misses.get(row.lineNo) || `Roll ${humanRoll(row.roll)} not found in "${row.muniName}"`,
            });
          }
        }
      }
    }
  }

  // Bulk legal-index scan covering every row that needs resolution.
  if (needsLookup.length > 0) {
    const rollSet = new Set(needsLookup.map((r) => r.roll));
    let byRoll;
    try {
      byRoll = await lookupRollSet(rollSet);
    } catch (err) {
      // Catastrophic — drop every lookup-needing row to unresolved
      // with the failure reason, so the user sees the actual problem
      // instead of silently empty results.
      for (const row of needsLookup) {
        unresolved.push({ ...row, reason: `Legal-index lookup failed: ${err.message || err}` });
      }
      return finalize({ resolved, unresolved, stats });
    }

    for (const row of needsLookup) {
      const candidates = byRoll.get(row.roll) || [];
      if (candidates.length === 0) {
        unresolved.push({ ...row, reason: `Roll # ${humanRoll(row.roll)} not found in legal index — provide muni # to skip the lookup` });
        continue;
      }

      // Title-first: when present, it's the most specific identifier.
      if (row.title) {
        const hits = candidates.filter((c) => titleMatches(c, row.title));
        if (hits.length > 0) {
          const munis = new Set(hits.map((h) => Number(h.muni_no)));
          if (munis.size === 1) {
            const muni = [...munis][0];
            resolved.push({ lineNo: row.lineNo, muniNo: muni, roll: row.roll, via: 'title', site: row.site ?? null, raw: row.raw });
            stats.byVia.title++;
            continue;
          }
          unresolved.push({
            ...row,
            reason: `Ambiguous — title # ${row.title} + roll ${humanRoll(row.roll)} match ${munis.size} munis`,
            candidates: [...munis],
          });
          continue;
        }
        // Title didn't match — fall through to legal if present;
        // otherwise surface the title miss explicitly.
        if (!row.legal || row.legal.kind === 'unparseable') {
          unresolved.push({
            ...row,
            reason: `Title # ${row.title} found in roll candidates but didn't match (${candidates.length} candidate${candidates.length === 1 ? '' : 's'})`,
          });
          continue;
        }
      }

      // Legal-based: grid needle or LBP match against candidates.
      if (row.legal && row.legal.kind !== 'unparseable') {
        const hits = candidates.filter((c) => legalMatches(c, row.legal));
        if (hits.length > 0) {
          const munis = new Set(hits.map((h) => Number(h.muni_no)));
          if (munis.size === 1) {
            const muni = [...munis][0];
            resolved.push({ lineNo: row.lineNo, muniNo: muni, roll: row.roll, via: 'legal', site: row.site ?? null, raw: row.raw });
            stats.byVia.legal++;
            continue;
          }
          unresolved.push({
            ...row,
            reason: `Ambiguous — legal "${row.legal.raw}" + roll ${humanRoll(row.roll)} match ${munis.size} munis`,
            candidates: [...munis],
          });
          continue;
        }
        unresolved.push({
          ...row,
          reason: `Legal "${row.legal.raw}" didn't match any of the ${candidates.length} roll candidate${candidates.length === 1 ? '' : 's'}`,
        });
        continue;
      }

      // Roll alone matched candidates but the user gave no
      // disambiguator — accept only if there's a single candidate.
      if (candidates.length === 1) {
        resolved.push({
          lineNo: row.lineNo,
          muniNo: Number(candidates[0].muni_no),
          roll: row.roll,
          via: 'roll-alone',
          site: row.site ?? null,
          raw: row.raw,
        });
        stats.byVia.legal++; // bucket under legal for simplicity
        continue;
      }
      const munis = new Set(candidates.map((c) => Number(c.muni_no)));
      unresolved.push({
        ...row,
        reason: `Roll # ${humanRoll(row.roll)} alone matches ${munis.size} muni${munis.size === 1 ? '' : 's'} — supply muni #, title #, or legal to disambiguate`,
        candidates: [...munis],
      });
    }
  }

  return finalize({ resolved, unresolved, stats });
}

function finalize({ resolved, unresolved, stats }) {
  stats.resolved = resolved.length;
  stats.unresolved = unresolved.length;
  const parcelKeys = resolved.map((r) => ({
    muni_no: r.muniNo,
    roll_no_txt: r.roll,
  }));
  return { resolved, unresolved, parcelKeys, stats };
}

/** Trim the canonical ".000" off rolls when surfacing them to the
 *  user — matches the display rule the existing UI uses for
 *  Roll_No_Txt in the table. */
function humanRoll(roll) {
  if (typeof roll !== 'string') return String(roll || '');
  return roll.endsWith('.000') ? roll.slice(0, -4) : roll;
}
