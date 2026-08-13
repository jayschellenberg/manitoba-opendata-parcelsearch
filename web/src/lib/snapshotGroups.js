/*
 * Grouping + file naming for the parcel-snapshot export.
 *
 * A sale spanning several rolls is ONE subject, so it gets ONE frame: every
 * member highlighted, the camera fit to the union of their extents.
 * Capturing each roll separately would hand the appraiser six images of a
 * six-parcel holding with no picture of the holding itself.
 *
 * Single parcels are simply groups of one, so snapshotExport.js has a
 * single code path — and on Property Search that is every parcel. Only
 * sales work groups: a Roll # list and a parcel-list import both put each
 * parcel in its own frame, however the rolls were punctuated.
 *
 * Group identity comes from the stamps the search path already applies:
 *   _saleGroupId — a sales-CSV upload's per-sale group id (the Sales tab)
 *   _siteNo      — the caller's Site / Comp # column, when mapped
 * _saleGroupId wins because it is the transaction-level identity; _siteNo
 * covers a list that carried comp numbers but no sale grouping.
 *
 * Pure (no map / no DOM) so node can exercise the grouping and naming
 * rules; snapshotExport.js owns the rendering.
 */

import { muniCodeValue, rollNumericValue } from './parcelNumbering.js';

/** How many of a comp's rolls the filename spells out before the "{n}p"
 *  count takes over. Three keeps a six-parcel comp's name readable while
 *  still identifying it by roll. */
const MAX_NAMED_ROLLS = 3;

/**
 * Group identity for one parcel, or null when the parcel belongs to no
 * group and should be framed on its own. Prefixed by source so a site
 * label can never collide with a numeric group id.
 */
export function snapshotGroupKey(props) {
  const g = props?._saleGroupId;
  if (g != null && String(g).trim() !== '') return `g:${String(g).trim()}`;
  const s = props?._siteNo;
  if (s != null && String(s).trim() !== '') return `s:${String(s).trim()}`;
  return null;
}

/**
 * Bucket a result set into the frames the export will capture.
 *
 * @param {Array} features — parcel features (those without geometry are
 *   dropped; they can't be framed).
 * @returns {Array<{key, members, muniNames, muniCode, roll}>} ordered by
 *   municipality code then first roll — the same order the results-table
 *   numbering uses, and contiguous per muni so the exporter fetches each
 *   muni's parcel fabric once.
 */
export function groupParcelsForSnapshots(features) {
  const byKey = new Map();
  const singles = [];
  for (const f of features || []) {
    if (!f?.geometry) continue;
    const key = snapshotGroupKey(f.properties || {});
    if (!key) { singles.push(f); continue; }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  const groups = [];
  for (const [key, members] of byKey) groups.push(makeGroup(key, members));
  for (const f of singles) groups.push(makeGroup(null, [f]));
  groups.sort((a, b) => cmpNum(a.muniCode, b.muniCode) || cmpNum(a.roll, b.roll));
  return groups;
}

/** Number of frames a result set will produce — what the button label and
 *  the progress counter should say, now that a comp is one frame. */
export function countSnapshotFrames(parcelFc) {
  return groupParcelsForSnapshots(parcelFc?.features).length;
}

function makeGroup(key, members) {
  // Roll order within the group makes "the group's roll" deterministic
  // regardless of the order the features came back from ArcGIS.
  const ordered = [...members].sort(
    (a, b) => cmpNum(rollNumericValue(a.properties), rollNumericValue(b.properties)),
  );
  const props = ordered[0]?.properties || {};
  // Distinct munis, first-seen order. Nearly always one; a comp that
  // straddles a municipal boundary needs both fabrics loaded, else half
  // its parcels would be drawn without surrounding lines.
  const muniNames = [];
  for (const f of ordered) {
    const m = f?.properties?.Muni_Name_With_Typ || '';
    if (m && !muniNames.includes(m)) muniNames.push(m);
  }
  return {
    key,
    members: ordered,
    muniNames,
    muniCode: muniCodeValue(props),
    roll: rollNumericValue(props),
  };
}

/**
 * `{site}-{muniCode}-{rolls}-{n}p.{ext}`, dropping the site when the import
 * carried no Site / Comp # column and the count when the frame holds a
 * single parcel:
 *
 *   610-225600.jpg                        one parcel, no comp #
 *   10-610-225600.jpg                     one parcel, comp 10
 *   64-612-196550_196800-2p.jpg           comp 64, both rolls named
 *   24-610-83100_83200_85200-6p.jpg       comp 24, first 3 of 6 rolls
 *
 * Muni code is the numeric prefix of the parcel's `Municipality` field,
 * which Roll_Entry stores as "187 - DE SALABERRY (RM)"; rolls trim the
 * canonical trailing ".000" like the rest of the UI. `members` is expected
 * in roll order (groupParcelsForSnapshots sorts it), so the named rolls are
 * the group's lowest and the name is stable across runs.
 *
 * Rolls join on "_" so they never read as extra "-" fields, and the "{n}p"
 * suffix says how many parcels the frame actually covers — without it a
 * capped list would imply a 6-parcel comp were a 3-parcel one.
 *
 * Leading with the comp number means the ZIP's files sort in report order,
 * which is how the appraiser looks for them.
 */
export function snapshotBaseName(members, ext) {
  const props = members?.[0]?.properties || {};
  const site = siteLabel(members);
  const rolls = (members || []).map((f) => sanitizeSegment(humanRoll(f?.properties?.Roll_No_Txt)));
  const parts = [
    muniCodeFromMunicipality(props.Municipality),
    rolls.slice(0, MAX_NAMED_ROLLS).join('_') || 'NA',
  ];
  if (rolls.length > 1) parts.push(`${rolls.length}p`);
  if (site) parts.unshift(site);
  return `${parts.map(sanitizeSegment).join('-')}.${ext}`;
}

/** The group's Site / Comp # — the first member that carries one. */
export function siteLabel(members) {
  for (const f of members || []) {
    const s = f?.properties?._siteNo;
    if (s != null && String(s).trim() !== '') return String(s).trim();
  }
  return '';
}

function muniCodeFromMunicipality(municipality) {
  if (!municipality) return 'NA';
  const code = String(municipality).split(' - ')[0].trim();
  return code || 'NA';
}

function humanRoll(roll) {
  const s = String(roll ?? '').trim();
  if (!s) return 'NA';
  return s.endsWith('.000') ? s.slice(0, -4) : s;
}

function sanitizeSegment(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'NA';
}

/** Numeric compare that tolerates the +Infinity "sorts last" sentinel
 *  parcelNumbering returns for missing munis / rolls (Infinity - Infinity
 *  is NaN, which would corrupt the sort). */
function cmpNum(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
