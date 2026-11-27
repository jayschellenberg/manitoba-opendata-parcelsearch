// report.html: one-page preliminary property report for a single parcel.
//
//   report.html?muni=<Muni_Name_With_Typ>&roll=<Roll_No_Txt>
//
// Opened from the parcel summary card ("Preliminary Report"). It fetches
// everything itself through the same arcgis.js loaders the app uses, so a
// figure here can never disagree with the grid, and the URL is shareable.
// Public data only: no sales, no subscriber data. What it prints is decided
// in lib/reportData.js (unit-tested); this module fetches and lays out.

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  MB_PARCEL_DATA_CDN, setRollEntrySnapshot, fetchAllParcelsInMunicipality, canonicalRoll,
  acresFromFrontageField, fetchZoningOverlap, fetchDevPlanOverlap, joinTopNByArea,
  fetchFloodForMuni, fetchWaterForMuni, fetchParcelMascForMuni, fetchLandfactsForMuni,
  fetchMfNewbuildForMuni, fetchContaminatedSites, fetchTrafficStations, fetchTrafficHistory,
} from '../arcgis.js';
import { lookupAssessment } from '../assessmentIndex.js';
import { floodZoneEntries } from '../lib/flood.js';
import { waterCellText } from '../lib/water.js';
import { readLandfacts, landMix, croppedYears, observedYears } from '../lib/landfacts.js';
import { readMfnb, primaryEvent, mfnbDu } from '../lib/mfNewbuild.js';
import { csdCodesFor, isUnorganizedPlace } from '../lib/censusCsd.js';
import {
  centreOf, nearby, clean, fmtDistance, fmtMoney, fmtInt, zoningText, bylawText,
  CENSUS_FIELDS, censusColumns, nearbyTraffic,
} from '../lib/reportData.js';
import { renderAssessmentHistory } from './assessmentHistory.js';

const CENSUS_SUMMARY_URL = import.meta.env?.VITE_CENSUS_SUMMARY_URL
  || 'https://housing-economic-data.vercel.app/data/housing/census-summary.json';
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sources = [];           // [{what, detail}] for the Sources & vintage section
const cite = (what, detail) => sources.push({ what, detail });

function section(id, title, html) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = `<h2>${esc(title)}</h2>${html}`;
  el.hidden = false;
}
const dl = (pairs) => `<dl class="rp-dl">${pairs.filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const unavailable = (what) => `<p class="rp-muted">${esc(what)} could not be loaded.</p>`;

async function settle(promise) {
  try { return await promise; } catch (err) { console.warn(err); return undefined; }
}

async function main() {
  const params = new URLSearchParams(location.search);
  const muni = (params.get('muni') || '').trim();
  const roll = canonicalRoll(params.get('roll') || '');
  if (!muni || !roll) {
    $('rp-status').textContent = 'Open this report from a parcel in the search (it needs a municipality and roll number).';
    return;
  }
  $('rp-status').textContent = 'Loading parcel…';

  // Parcel record and geometry from the Roll Entry snapshot (the live
  // provincial service needs a token since 2026-11-17).
  const manifest = await fetch(`${MB_PARCEL_DATA_CDN}/rollentry-snapshot/_index.json`).then((r) => r.json());
  setRollEntrySnapshot(manifest);
  const entry = manifest.munis?.[muni];
  const muniFc = await fetchAllParcelsInMunicipality(muni);
  const subject = muniFc.features.find((f) => f.properties?.Roll_No_Txt === roll);
  if (!entry || !subject) {
    $('rp-status').textContent = `Roll ${roll} was not found in ${muni} in the ${manifest.snapshot_date} snapshot.`;
    return;
  }
  const p = subject.properties;
  const muniNo = Number(entry.muni_no);
  const subjectFc = { type: 'FeatureCollection', features: [subject] };
  const at = centreOf(subject.geometry);
  cite('Parcel (Roll Entry)', `Province of Manitoba, snapshot ${manifest.snapshot_date}. Open Government Licence - Manitoba.`);

  document.title = `${p.Property_Address || `Roll ${roll}`} · Preliminary Report`;
  $('rp-title').textContent = p.Property_Address || `Roll ${roll}`;
  $('rp-sub').textContent = `${muni} · Roll ${roll}`;
  $('rp-date').textContent = new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
  $('rp-status').textContent = 'Loading data…';

  renderMap(subject);

  const acres = acresFromFrontageField(p.Frontage_or_Area);
  section('rp-parcel', 'Parcel', dl([
    ['Civic address', esc(p.Property_Address || '—')],
    ['Municipality', esc(muni)],
    ['Roll number', esc(roll)],
    ['Roll frontage / area', esc(p.Frontage_or_Area || '—')],
    ['Acres (roll)', acres ? acres.toFixed(2) : null],
    ['Dwelling units', esc(p.Dwelling_Units ?? '—')],
    ['Assessment roll', esc(p.Asmt_Roll || '')],
    ['Centre', at ? `${at.lat.toFixed(5)}, ${at.lon.toFixed(5)}` : null],
    ['MAO report', p.Asmt_Rpt_Url ? `<a href="${esc(p.Asmt_Rpt_Url)}" target="_blank" rel="noreferrer">Open on Manitoba Assessment Online</a>` : null],
  ]));

  const [asmt, asmtMeta, zoningFc, devFc, flood, water, masc, landfacts, mfnb, contam, stations, traffic, census] = await Promise.all([
    settle(lookupAssessment({ muni_no: muniNo, roll_no_txt: roll })),
    settle(fetch(`${MB_PARCEL_DATA_CDN}/assessment/_index.json`).then((r) => r.json()).then((j) => j.metadata)),
    settle(fetchZoningOverlap(subjectFc)),
    settle(fetchDevPlanOverlap(subjectFc)),
    settle(fetchFloodForMuni(muni)),
    settle(fetchWaterForMuni(muni)),
    settle(fetchParcelMascForMuni(muni)),
    settle(fetchLandfactsForMuni(muni)),
    settle(fetchMfNewbuildForMuni(muni)),
    settle(fetchContaminatedSites()),
    settle(fetchTrafficStations()),
    settle(fetchTrafficHistory()),
    settle(fetch(CENSUS_SUMMARY_URL).then((r) => (r.ok ? r.json() : null))),
  ]);

  // Assessment
  if (asmt) {
    section('rp-assessment', 'Assessment', dl([
      ['Tax year', esc(asmt.year)],
      ['Land', fmtMoney(asmt.land)],
      ['Buildings', fmtMoney(asmt.buildings)],
      ['Total', `<strong>${fmtMoney(asmt.total)}</strong>`],
      ['Building share', Number.isFinite(asmt.pctBuildings) ? `${Math.round(asmt.pctBuildings * 100)}%` : null],
      ['Class', esc(asmt.class)],
      ['Tax status', esc(asmt.tax_status)],
    ]) + '<div id="rp-asmt-history"></div>');
    cite('Assessment', `Manitoba Assessment Online public summaries${asmtMeta?.source_modified ? `, archive as of ${String(asmtMeta.source_modified).slice(0, 10)}` : ''}. Contains information from the Government of Manitoba, licensed under the OpenMB Information and Data Use Licence. Not an official assessment record; confirm with MAO before relying on it.`);
    await settle(renderAssessmentHistory($('rp-asmt-history'), { muniNo, roll, cite }));
  } else {
    section('rp-assessment', 'Assessment', `<p>Roll total on the ${esc(manifest.snapshot_date)} snapshot: <strong>${esc(p.Total_Value || '—')}</strong>. No assessment-archive row was found for this roll.</p>`);
  }

  // Zoning and development plan
  const zMatches = zoningFc ? joinTopNByArea(subjectFc, zoningFc, 2).get(p.OBJECTID) : null;
  const dMatches = devFc ? joinTopNByArea(subjectFc, devFc, 2).get(p.OBJECTID) : null;
  section('rp-zoning', 'Zoning and development plan', (zoningFc === undefined && devFc === undefined) ? unavailable('Zoning') : dl([
    ['Zoning', esc(zoningText(zMatches)) || 'No zoning polygon intersects this parcel'],
    ['Zoning by-law', esc(bylawText(zMatches)) || null],
    ['Development plan', esc(zoningText(dMatches)) || 'No designation intersects this parcel'],
    ['Development plan by-law', esc(bylawText(dMatches, ['DP_BYLAW', 'DPA_BYLAW'])) || null],
    ['Planning district', esc(clean(zMatches?.[0]?.feature?.properties?.PLANNINGDISTRICT) || clean(dMatches?.[0]?.feature?.properties?.PLANNINGDISTRICT))],
  ]) + '<p class="rp-note">From the province\'s zoning and development-plan layers. Confirm the current by-law text and any amendments with the municipality or planning district.</p>');
  cite('Zoning, development plan', 'Manitoba Zoning By-Laws and Development Plan Designations (live). Open Government Licence - Manitoba.');

  // Flood and water
  const fz = flood ? floodZoneEntries(flood[roll]) : [];
  const w = water ? water[roll] : null;
  section('rp-flood', 'Flood and water', dl([
    ['Flood zones', flood === undefined || flood === null ? 'Not available' :
      fz.length ? fz.map((e) => `${esc(e.zone.label || e.zone.short)}${Number.isFinite(e.pct) && e.pct < 100 ? ` (${e.pct}% of parcel)` : ''}`).join('<br>') : 'Outside all mapped flood zones'],
    ['Water influence', water === undefined || water === null ? 'Not available' : w ? esc(waterCellText(w)) : 'No water body within 50 m'],
  ]) + '<p class="rp-note">Screening only. Designated Flood Area status, flood-proofing levels and permits are set by Manitoba Transportation and Infrastructure.</p>');
  cite('Flood zones', 'MBFloodMapping layers (Designated Flood Areas, 1-in-200, 1997/2009/2011 extents).');

  // Land: rural parcels only. Land facts exist for 20 acres and up; a MASC
  // rating alone is shown from 10 acres, since a town lot can overlap a
  // rated quarter without the rating meaning anything for it.
  const lf = landfacts ? readLandfacts(landfacts[roll]) : null;
  const m = masc && (lf || (acres ?? 0) >= 10) ? masc[roll] : null;
  if (m || lf) {
    const mix = lf ? landMix(lf) : null;
    section('rp-land', 'Land', dl([
      ['MASC soil productivity', m ? esc(`${m.rating}${m.label ? ` (${m.label})` : ''}${m.ra ? `, risk area ${m.ra}` : ''}`) : null],
      ['Cultivated (2021-2025)', mix?.cult != null ? `${Math.round(mix.cult * 100)}%` : null],
      ['Pasture / bush / wetland / other', mix ? [mix.past, mix.bush, mix.wet, mix.other].map((v) => (v != null ? `${Math.round(v * 100)}%` : '—')).join(' / ') : null],
      ['Years mostly cropped', lf ? `${croppedYears(lf)} of ${observedYears(lf)} observed years, 2009-2025` : null],
      ['Relief / mean slope', lf && Number.isFinite(lf.rel) ? `${lf.rel} m / ${Number.isFinite(lf.slp) ? `${lf.slp}%` : '—'}` : null],
    ]));
    cite('Land', 'MASC SearchLand ratings; AAFC Annual Crop Inventory, NRCan MRDEM-30 (OGL - Canada).');
  }

  // Nearby: contaminated sites, new multi-family, traffic
  const nearHtml = [];
  if (contam?.features) {
    const hits = nearby(contam.features, at, 1000, 8);
    nearHtml.push(`<h3>Contaminated and impacted sites within 1 km</h3>${hits.length
      ? `<table class="rp-table"><thead><tr><th>Site</th><th>Address</th><th>Group</th><th>Distance</th></tr></thead><tbody>${hits.map((h) => `<tr><td>${esc(h.properties?.NAME)}</td><td>${esc(h.properties?.ADDRESS)}</td><td>${esc(h.properties?.CSGROUP)}</td><td>${fmtDistance(h._m)}</td></tr>`).join('')}</tbody></table>`
      : '<p>None listed in the provincial registry.</p>'}`);
    cite('Contaminated sites', 'Manitoba Contaminated Sites Registry (live CSV). Contains information from the Government of Manitoba, licensed under the OpenMB Information and Data Use Licence.');
  }
  if (mfnb && muniFc) {
    const rolls = new Map(muniFc.features.map((f) => [f.properties?.Roll_No_Txt, f]));
    const feats = Object.entries(mfnb).map(([r, v]) => ({ r, mf: readMfnb(v), f: rolls.get(r) }))
      .filter((x) => x.mf && x.f).map((x) => ({ ...x.f, _mf: x.mf }));
    const hits = nearby(feats, at, 3000, 6);
    nearHtml.push(`<h3>New multi-family buildings within 3 km (2016 on)</h3>${hits.length
      ? `<table class="rp-table"><thead><tr><th>Address</th><th>Units</th><th>Year</th><th>Distance</th></tr></thead><tbody>${hits.map((h) => `<tr><td>${esc(h.properties?.Property_Address)}</td><td>${esc(mfnbDu(h._mf) ?? '')}</td><td>${esc(primaryEvent(h._mf)?.y ?? '')}</td><td>${fmtDistance(h._m)}</td></tr>`).join('')}</tbody></table>`
      : '<p>None detected.</p>'}<p class="rp-note">Detected from jumps in assessed building value on rolls with 3 or more units; years are assessment years and trail completion by about a year. Outside Winnipeg there is no province-wide building-permit feed.</p>`);
  }
  const tr = nearbyTraffic(stations, traffic, at, 10000, 3);
  if (stations || traffic) {
    nearHtml.push(`<h3>Highway traffic counts within 10 km</h3>${tr.length
      ? `<table class="rp-table"><thead><tr><th>Highway</th><th>Location</th><th>AADT</th><th>Annual change</th><th>Distance</th></tr></thead><tbody>${tr.map((t) => `<tr><td>${esc(t.highway)}</td><td>${esc(t.location)}</td><td>${fmtInt(t.aadt)} (${t.year})</td><td>${t.cagr != null ? `${t.cagr >= 0 ? '+' : ''}${t.cagr.toFixed(1)}%/yr since ${t.fromYear}` : '—'}</td><td>${fmtDistance(t.m)}</td></tr>`).join('')}</tbody></table>`
      : '<p>No count station within 10 km.</p>'}`);
    cite('Traffic', 'Traffic on Manitoba Highways, Manitoba Highway Traffic Information System (Manitoba Transportation and Infrastructure / University of Manitoba). Contains information from the Government of Manitoba, licensed under the OpenMB Information and Data Use Licence.');
  }
  if (nearHtml.length) section('rp-nearby', 'Nearby', nearHtml.join(''));

  // Census
  renderCensus(census, muni);

  section('rp-sources', 'Sources and vintage', `<ul>${sources.map((s) => `<li><strong>${esc(s.what)}:</strong> ${esc(s.detail)}</li>`).join('')}</ul>`);
  $('rp-status').hidden = true;
  $('rp-print').disabled = false;
}

function renderCensus(summary, muni) {
  if (!summary) {
    section('rp-census', 'Community (census)', unavailable('Census figures'));
    return;
  }
  const uids = csdCodesFor(muni, summary.regions);
  if (!uids.length) {
    section('rp-census', 'Community (census)', `<p>${isUnorganizedPlace(muni)
      ? `${esc(muni)} is not a census subdivision; Statistics Canada reports it inside an unorganized division.`
      : `No census subdivision matched ${esc(muni)}.`} Manitoba and Winnipeg CMA figures follow for reference.</p>${censusTable(censusColumns(summary, []).columns)}`);
  } else {
    const { columns } = censusColumns(summary, uids);
    section('rp-census', 'Community (census)', censusTable(columns));
  }
  cite('Census', `${summary.source} (${summary.regions.find((r) => r.uid === '46')?.year ?? ''}). Statistics Canada Open Licence.`);
}

function censusTable(columns) {
  if (!columns.length) return '';
  return `<table class="rp-table rp-census"><thead><tr><th></th>${columns.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${
    CENSUS_FIELDS.map(([k, label, fmt]) => `<tr><th>${esc(label)}</th>${columns.map((c) => `<td>${esc(fmt(c[k]))}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}

function renderMap(subject) {
  const el = $('rp-map');
  if (!el) return;
  const map = new maplibregl.Map({
    container: el,
    style: {
      version: 8,
      sources: {
        imagery: { type: 'raster', tiles: [ESRI_IMAGERY], tileSize: 256, maxzoom: 20,
          attribution: 'Imagery: Esri, Maxar, Earthstar Geographics' },
        parcel: { type: 'geojson', data: subject },
      },
      layers: [
        // No fade: a print or a background tab may never run the frames a
        // fade-in needs, leaving the imagery at opacity 0.
        { id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 0 } },
        { id: 'parcel-line', type: 'line', source: 'parcel', paint: { 'line-color': '#ffd400', 'line-width': 3 } },
      ],
    },
    interactive: false,
    attributionControl: { compact: false },
    preserveDrawingBuffer: true,
  });
  const bb = (() => {
    const pts = subject.geometry.type === 'Polygon' ? subject.geometry.coordinates.flat() : subject.geometry.coordinates.flat(2);
    const xs = pts.map((q) => q[0]); const ys = pts.map((q) => q[1]);
    return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
  })();
  map.fitBounds(bb, { padding: 60, maxZoom: 18, duration: 0 });
  // Once everything has drawn, freeze the map into an <img>: a WebGL canvas
  // can print blank, an image always prints. Attribution stays as a caption.
  let frozen = false;
  const freeze = () => {
    if (frozen) return;
    frozen = true;
    try {
      const img = new Image();
      img.alt = 'Aerial view of the parcel with its boundary outlined';
      img.className = 'rp-map-img';
      img.src = map.getCanvas().toDataURL('image/png');
      const cap = document.createElement('figcaption');
      cap.className = 'rp-note';
      cap.textContent = 'Parcel outline from the Roll Entry snapshot (simplified; not a survey). Imagery: Esri, Maxar, Earthstar Geographics.';
      el.replaceWith(img);
      img.after(cap);
      map.remove();
    } catch (err) { console.warn('map snapshot failed', err); }
  };
  map.once('idle', freeze);
  // A background tab may never reach 'idle'; printing must still get an image.
  window.addEventListener('beforeprint', () => { map.triggerRepaint(); freeze(); }, { once: true });
  cite('Imagery', 'Esri World Imagery (display only).');
}

$('rp-print')?.addEventListener('click', () => window.print());
main().catch((err) => {
  console.error(err);
  $('rp-status').textContent = `The report could not be built: ${err.message}`;
});
