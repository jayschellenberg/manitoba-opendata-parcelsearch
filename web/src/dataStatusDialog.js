// dataStatusDialog.js — drives the top-bar "Data Status" dialog: when each
// data source behind the site was last refreshed. Kept out of main.js the
// same way the sales panel is: self-contained, one init call.
//
// Loads lazily on the dialog's FIRST open — the muni-vintage fetch is tiny,
// but the live-service section fires one request per service, and paying
// that on every page load for a dialog most sessions never open would be
// waste.
//
// Sales scrape coverage is deliberately NOT here: it is subscriber-derived
// and renders only inside the Sales Analysis panel, which reads the user's
// own local export folder (SPEC-DATA-STATUS-TAB.md).

import {
  SERVICE_SOURCES, CLI_AGR_CAP_URL, MASC_RISK_AREAS_URL,
  MB_PARCEL_DATA_CDN, MB_PARCEL_DATA_REVISION,
  fetchHistoricalIndex, fetchMascIndex,
} from './arcgis.js';
import { WALLAS_SOURCES } from './wallas.js';
import { getManifest } from './manifest.js';
import {
  vintageRows, publishedRows, serviceEditDate, statMaxDate,
} from './lib/dataStatus.js';

const BASE_URL = import.meta.env?.BASE_URL || '/';

// Every live service the map talks to. SERVICE_SOURCES and WALLAS_SOURCES
// are the same arrays the provenance exports cite. The WALLAS layers sit on
// the province's ArcGIS 10.51 MapServer, which publishes no editingInfo —
// their vintage is data-derived instead: the newest APPLICATION_DATE.
const LIVE_SERVICES = [
  ...SERVICE_SOURCES,
  { label: 'Soil Survey (CLI agriculture capability)', url: CLI_AGR_CAP_URL },
  { label: 'MASC Risk Areas', url: MASC_RISK_AREAS_URL },
  ...WALLAS_SOURCES.map((s) => ({ ...s, dateField: 'APPLICATION_DATE' })),
];

function statUrl(url, field) {
  const p = new URLSearchParams({
    where: '1=1',
    outStatistics: JSON.stringify([{
      statisticType: 'max', onStatisticField: field, outStatisticFieldName: 'newest',
    }]),
    f: 'json',
  });
  return `${url}/query?${p}`;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function td(text, cls) {
  const cell = document.createElement('td');
  cell.textContent = text ?? '—';
  if (cls) cell.className = cls;
  return cell;
}

export function initDataStatusDialog() {
  const $open  = document.getElementById('data-status-open');
  const $modal = document.getElementById('data-status-modal');
  if (!$open || !$modal) return;

  const $close       = document.getElementById('data-status-close');
  const $munis       = document.getElementById('data-status-munis');
  const $muniSearch  = document.getElementById('data-status-muni-search');
  const $muniSummary = document.getElementById('data-status-muni-summary');
  const $published   = document.getElementById('data-status-published');
  const $services    = document.getElementById('data-status-services');

  let muniRows = null;

  function renderMunis() {
    if (!$munis) return;
    $munis.textContent = '';
    if (!muniRows) {
      const tr = document.createElement('tr');
      tr.appendChild(td('Vintage file not available — rebuild the manifest to refresh it.'));
      tr.firstChild.colSpan = 3;
      $munis.appendChild(tr);
      return;
    }
    const q = ($muniSearch?.value || '').trim().toLowerCase();
    for (const r of muniRows) {
      if (q && !r.name.toLowerCase().includes(q)
            && !(r.region || '').toLowerCase().includes(q)) continue;
      const tr = document.createElement('tr');
      tr.append(td(r.name), td(r.region || ''), td(r.label || '—'));
      $munis.appendChild(tr);
    }
  }

  function renderPublished(rows) {
    if (!$published) return;
    $published.textContent = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.append(td(r.label), td(r.vintage, r.vintage ? '' : 'is-unknown'), td(r.detail || ''));
      $published.appendChild(tr);
    }
  }

  function renderServices() {
    if (!$services) return;
    $services.textContent = '';
    for (const s of LIVE_SERVICES) {
      const tr = document.createElement('tr');
      tr.append(td(s.label), td('…'));
      $services.appendChild(tr);
      // Fill in as each service answers; a dead one reads "unavailable"
      // rather than holding up the rest.
      const req = s.dateField
        ? fetchJson(statUrl(s.url, s.dateField)).then((json) => {
            const date = statMaxDate(json);
            return date ? `newest record ${date}` : null;
          })
        : fetchJson(`${s.url}?f=json`).then((json) => {
            if (!json) return null;
            return serviceEditDate(json) || 'not published';
          });
      req.then((text) => {
        tr.lastChild.textContent = text || 'unavailable';
        if (!text || text === 'not published') tr.lastChild.className = 'is-unknown';
      });
    }
  }

  async function load() {
    const [vintage, manifest, rollSnap, histIndex, mascIdx] = await Promise.all([
      fetchJson(`${BASE_URL}data/muni-vintage.json`),
      getManifest(),
      fetchJson(`${MB_PARCEL_DATA_CDN}/rollentry-snapshot/_index.json`),
      fetchHistoricalIndex().catch(() => null),
      fetchMascIndex().catch(() => null),
    ]);

    muniRows = vintageRows(vintage);
    if ($muniSummary && muniRows) {
      const months = muniRows.map((r) => r.month).filter(Boolean).sort();
      const latest = months.length ? months[months.length - 1] : null;
      $muniSummary.textContent =
        `${muniRows.length} municipalities` + (latest ? ` · newest cycle ${latest}` : '');
    }
    renderMunis();
    renderPublished(publishedRows({
      manifest, rollSnap, histIndex,
      revision: MB_PARCEL_DATA_REVISION,
      mascMeta: mascIdx?._meta || null,
    }));
    renderServices();
  }

  let loaded = false;
  $open.addEventListener('click', () => {
    if (!loaded) { loaded = true; load(); }
    $modal.showModal();
  });
  $close?.addEventListener('click', () => $modal.close());
  $muniSearch?.addEventListener('input', renderMunis);
}
