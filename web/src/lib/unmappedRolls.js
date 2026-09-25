// unmappedRolls.js — a roll that exists but has no parcel boundary yet.
//
// ROLL_ENTRY (the only source of result features) lags Manitoba Assessment
// Online. A new subdivision or a freshly split roll can sit in MAO — and so in
// the legal index scraped from it — for months before its polygon is
// published. A roll search for it used to answer "No parcels found", which is
// wrong: the roll exists, only its boundary doesn't.
//
// So a roll-only search that misses in ROLL_ENTRY looks the roll up in the
// legal index, and each hit is returned as a Point feature standing in for
// the parcel:
//
//   1. quarter   — the legal description names a quarter section
//                  (NE-01-13-28-W / NE1-13-28W) and MB_LegalDesc has that
//                  quarter's point. Within ~½ mile.
//   2. section   — the section is found but not the quarter (or the legal
//                  names only the section). Within ~1 mile.
//   3. municipality — no usable survey reference (a lot on a plan, a condo
//                  unit, a river lot); the pin goes to the middle of the
//                  municipality. Says only "somewhere in here".
//
// A roll newer than the last MAO scrape isn't in the legal index either —
// the scrape's delta is driven by ROLL_ENTRY changes, so a roll ROLL_ENTRY
// has never carried waits for its municipality's 6-month re-scrape. For
// those, with a municipality picked:
//
//   4. neighbour — roll numbers run roughly in geographic order inside a
//                  municipality, so the pin goes between the mapped parcels
//                  with the nearest roll numbers either side (within
//                  NEIGHBOUR_ROLL_WINDOW). Nothing confirms such a roll
//                  exists, so it is flagged `_unconfirmed` as well.
//
// The feature is flagged `_unmapped` with its basis, so the popup, the table
// and the status line can all say the location is approximate rather than let
// a pin read as a surveyed position. It renders on the existing `parcel-pin`
// layer (the withheld-boundary circle), which already means "a location
// standing in for an extent".
//
// Pure + dependency-free apart from the token parser: the network calls
// (legal index, MB_LegalDesc, municipality boundaries) are made by the
// caller and their results passed in, so this unit-tests without fetch.

import { deriveStrTokens } from '../legalIndex.core.js';
import { polygonBboxMidpoint } from './polygonCentroid.js';

/** How far the map zooms onto each kind of approximate pin, and how the
 *  basis is worded. A municipality-centre pin at street zoom would look like
 *  an address match. */
export const UNMAPPED_BASIS = Object.freeze({
  quarter:      { zoom: 14, label: 'quarter section' },
  section:      { zoom: 13, label: 'section' },
  municipality: { zoom: 10, label: 'municipality' },
  neighbour:    { zoom: 15, label: 'neighbouring rolls' },
});

/** How far, in whole roll numbers, a neighbour may be from the wanted roll. */
export const NEIGHBOUR_ROLL_WINDOW = 100;

/** Neighbours further apart than this straddle a numbering break (the
 *  sequence jumping to another part of the municipality), so the pin goes
 *  to the nearer-numbered one instead of the empty ground between them. */
export const NEIGHBOUR_MAX_SPREAD_M = 3000;

/** Cap on how many stand-in pins one search adds. A roll typed without a
 *  municipality can match the same number in many municipalities. */
export const MAX_UNMAPPED = 25;

const QUARTERS = new Set(['NE', 'NW', 'SE', 'SW']);

/**
 * Section-township-range references in a legal record, as
 * `[{ q, sec, twp, rge, dir }]` with numbers zero-stripped. River-lot tokens
 * (q === 'RL') are dropped: their "section" slot is a lot number, which the
 * quarter-section survey cannot place.
 */
export function strRefsFromRecord(rec) {
  const s = deriveStrTokens(rec?.legal_description, rec?.legal_detail);
  if (!s) return [];
  const out = [];
  for (const tok of s.split(';')) {
    if (!tok) continue;
    const [q, sec, twp, rge, dir] = tok.split('|');
    if (q === 'RL') continue;
    const n = (v) => (/^\d+$/.test(v) ? Number(v) : NaN);
    const ref = { q, sec: n(sec), twp: n(twp), rge: n(rge), dir };
    if (![ref.sec, ref.twp, ref.rge].every(Number.isFinite)) continue;
    out.push(ref);
  }
  return out;
}

/** Distinct sections (ignoring quarter) among the refs, so one query per
 *  section covers every quarter the parcel spans. */
export function distinctSections(refs) {
  const seen = new Map();
  for (const r of refs || []) {
    const k = `${r.sec}|${r.twp}|${r.rge}|${r.dir}`;
    if (!seen.has(k)) seen.set(k, { sec: r.sec, twp: r.twp, rge: r.rge, dir: r.dir });
  }
  return [...seen.values()];
}

/**
 * WHERE clause for one section's quarter points on MB_LegalDesc. The
 * meridian is filtered client-side (the service stores it in mixed
 * encodings — "E1", "1E", "W1" — see masc.js sectionLinesFromRows).
 * `quoted` writes the numbers as string literals, for a retry in case the
 * service types those columns as text.
 */
export function sectionWhere({ sec, twp, rge }, { quoted = false } = {}) {
  const v = (x) => (quoted ? `'${Math.trunc(x)}'` : String(Math.trunc(x)));
  return `TYPE = 'Quarter' AND SECTION = ${v(sec)} AND TOWNSHIP = ${v(twp)} AND RANGE = ${v(rge)}`;
}

const normMeridian = (raw) => String(raw ?? '').replace(/[^EW]/gi, '').toUpperCase();

/** Point features from an MB_LegalDesc query that belong to this section on
 *  this side of the meridian. */
function sectionPoints(fc, { sec, twp, rge, dir }) {
  const out = [];
  for (const f of fc?.features || []) {
    const c = f?.geometry?.coordinates;
    if (f?.geometry?.type !== 'Point' || !Array.isArray(c)) continue;
    const lng = Number(c[0]), lat = Number(c[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const p = f.properties || {};
    if (Number(p.SECTION) !== sec || Number(p.TOWNSHIP) !== twp || Number(p.RANGE) !== rge) continue;
    // A point with no meridian letter is kept rather than dropping the
    // record all the way back to the municipality centre.
    const m = normMeridian(p.MERIDIAN);
    if (m && dir && m !== dir) continue;
    out.push({ lng, lat, q: String(p.QUARTER || '').toUpperCase().replace(/[^NESW]/g, '') });
  }
  return out;
}

const mean = (pts) => ({
  lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
  lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
});

/**
 * Place a record from its STR refs and the survey points fetched for their
 * sections (`surveyBySection`: Map keyed `sec|twp|rge|dir` → FeatureCollection).
 * Every named quarter that is found is averaged, so a parcel spanning two
 * quarters lands between them. When no named quarter is found but its
 * section is, the section's quarter points are averaged instead.
 * Returns `{ lng, lat, basis, ref }` or null.
 */
export function placeFromSurvey(refs, surveyBySection) {
  if (!refs?.length || !surveyBySection) return null;
  const quarterHits = [];
  const sectionHits = [];
  let firstRef = null;
  for (const sec of distinctSections(refs)) {
    const key = `${sec.sec}|${sec.twp}|${sec.rge}|${sec.dir}`;
    const pts = sectionPoints(surveyBySection.get(key), sec);
    if (!pts.length) continue;
    firstRef = firstRef || sec;
    sectionHits.push(mean(pts));
    const wanted = refs.filter((r) => r.sec === sec.sec && r.twp === sec.twp
      && r.rge === sec.rge && r.dir === sec.dir && QUARTERS.has(r.q));
    for (const r of wanted) {
      const hit = pts.find((p) => p.q === r.q);
      if (hit) quarterHits.push(hit);
    }
  }
  if (quarterHits.length) return { ...mean(quarterHits), basis: 'quarter', ref: firstRef };
  if (sectionHits.length) return { ...mean(sectionHits), basis: 'section', ref: firstRef };
  return null;
}

/** Middle of a municipality boundary feature, as `{ lng, lat }` or null. */
export function municipalityCentre(muniFeature) {
  const mid = polygonBboxMidpoint(muniFeature?.geometry);
  return mid ? { lng: mid[0], lat: mid[1] } : null;
}

/** The boundary feature for a muni number, or null. */
export function findMunicipality(muniFeatures, muniNo) {
  const n = Number(muniNo);
  if (!Number.isFinite(n)) return null;
  return (muniFeatures || []).find((f) => Number(f?.properties?.MUNI_NO) === n) || null;
}

/** The muni number for a dropdown value ("STEINBACH (CITY)"), or null. */
export function muniNoForListName(muniFeatures, listName) {
  const want = String(listName || '').trim().toUpperCase();
  if (!want) return null;
  const f = (muniFeatures || []).find(
    (x) => String(x?.properties?.MUNI_LIST_NAME_WITH_TYPE || '').trim().toUpperCase() === want,
  );
  const n = Number(f?.properties?.MUNI_NO);
  return Number.isFinite(n) ? n : null;
}

/**
 * Which legal records stand in for the missing rolls. `recsByRoll` is the
 * legal-index lookup keyed by canonical roll ("12345.000"); `muniNo`, when
 * the search was scoped to a municipality, drops same-numbered rolls in
 * other municipalities. One record per muni|roll, in the order the rolls
 * were asked for, capped at MAX_UNMAPPED.
 */
export function selectUnmappedRecords(missingCanonical, recsByRoll, muniNo = null) {
  const out = [];
  const seen = new Set();
  for (const roll of missingCanonical || []) {
    for (const rec of recsByRoll?.get(roll) || []) {
      if (muniNo != null && Number(rec.muni_no) !== Number(muniNo)) continue;
      const k = `${Number(rec.muni_no)}|${roll}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(rec);
      if (out.length >= MAX_UNMAPPED) return out;
    }
  }
  return out;
}

/**
 * The stand-in feature. Carries the same attribute names a ROLL_ENTRY
 * feature does (Roll_No_Txt, Municipality "N - NAME", Muni_Name_With_Typ,
 * Property_Address, Asmt_Rpt_Url) so the table, popup, legal join and
 * exports read it without a special case, plus the `_unmapped*` flags.
 * `seq` gives it a negative OBJECTID: unique within the result set, never a
 * real ROLL_ENTRY id, and numeric so map feature-state still works.
 */
export function buildUnmappedFeature(rec, place, muniFeature, seq) {
  const mp = muniFeature?.properties || {};
  const muniNo = Number(rec.muni_no);
  const basis = UNMAPPED_BASIS[place.basis] ? place.basis : 'municipality';
  const ref = place.ref;
  const refLabel = place.refLabel
    || (ref ? `${ref.sec}-${ref.twp}-${ref.rge}${ref.dir || ''}` : '');
  const muniName = mp.MUNI_NAME || rec.municipality || '';
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [place.lng, place.lat] },
    properties: {
      OBJECTID: -Math.abs(seq || 1),
      Roll_No_Txt: String(rec.roll_no_txt || ''),
      Municipality: Number.isFinite(muniNo) ? `${muniNo} - ${muniName}` : muniName,
      Muni_Name_With_Typ: mp.MUNI_LIST_NAME_WITH_TYPE || rec.municipality || '',
      Property_Address: rec.civic_address || '',
      Asmt_Rpt_Url: rec.source_url || '',
      _unmapped: true,
      // In neither ROLL_ENTRY nor the MAO scrape — nothing confirms it exists.
      _unconfirmed: basis === 'neighbour',
      _unmappedBasis: basis,
      _unmappedRef: refLabel,
      _approxZoom: UNMAPPED_BASIS[basis].zoom,
    },
  };
}

const rollDisp = (r) => String(r || '').replace(/\.000$/, '');

function metresBetween(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Place a roll from its nearest-numbered neighbours. `neighbours` is
 * `{ below: Record[], above: Record[] }` (nearest first, from the legal
 * index); `centreOf(rec)` returns the mapped parcel's `{ lng, lat }` or null
 * when ROLL_ENTRY has no polygon for it. The first mapped record each side
 * is used. Both sides and close together → the midpoint; far apart → the
 * one nearer by roll number; one side only → that one. Returns
 * `{ lng, lat, basis: 'neighbour', refLabel }` or null.
 */
export function placeFromNeighbours(roll, neighbours, centreOf) {
  const want = parseFloat(roll);
  const pick = (list) => {
    for (const rec of list || []) {
      const c = centreOf(rec);
      if (c && Number.isFinite(c.lng) && Number.isFinite(c.lat)) return { rec, c };
    }
    return null;
  };
  const lo = pick(neighbours?.below);
  const hi = pick(neighbours?.above);
  if (!lo && !hi) return null;
  const label = (x) => {
    const legal = String(x.rec.legal_description || '').trim();
    return `${rollDisp(x.rec.roll_no_txt)}${legal ? ` (${legal})` : ''}`;
  };
  if (lo && hi && metresBetween(lo.c, hi.c) <= NEIGHBOUR_MAX_SPREAD_M) {
    return {
      lng: (lo.c.lng + hi.c.lng) / 2,
      lat: (lo.c.lat + hi.c.lat) / 2,
      basis: 'neighbour',
      refLabel: `between rolls ${label(lo)} and ${label(hi)}`,
    };
  }
  let one = lo || hi;
  if (lo && hi) {
    const dLo = Math.abs(want - parseFloat(lo.rec.roll_no_txt));
    const dHi = Math.abs(want - parseFloat(hi.rec.roll_no_txt));
    one = dHi < dLo ? hi : lo;
  }
  return { ...one.c, basis: 'neighbour', refLabel: `beside roll ${label(one)}` };
}

/** One-line description of where the pin sits, for the popup and table. */
export function unmappedPlacementText(p) {
  const basis = p?._unmappedBasis;
  if (basis === 'quarter') return `Pin at the quarter section in the legal description${p._unmappedRef ? ` (${p._unmappedRef})` : ''}.`;
  if (basis === 'neighbour') return `Pin placed ${p._unmappedRef || 'between the nearest-numbered rolls'} — roll numbers run roughly in order on the ground, but a numbering break can put it in the wrong spot.`;
  if (basis === 'section') return `Pin at the centre of section ${p._unmappedRef || 'in the legal description'}.`;
  return 'Pin at the centre of the municipality — the legal description has no section to place it by.';
}

/** Status-line note, or '' when nothing was placed. */
export function unmappedCountNote(features) {
  const n = (features || []).filter((f) => f?.properties?._unmapped).length;
  if (!n) return '';
  return `${n} not yet on the parcel map — shown at an approximate location`;
}

/** The zoom cap for fitting to a result set made up only of approximate
 *  pins, or null when any real parcel is present. */
export function approxFitMaxZoom(features) {
  const list = features || [];
  if (!list.length) return null;
  let z = Infinity;
  for (const f of list) {
    const az = f?.properties?._approxZoom;
    if (!Number.isFinite(az)) return null;
    if (az < z) z = az;
  }
  return z;
}
