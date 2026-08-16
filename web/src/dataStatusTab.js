// dataStatusTab.js — drives the Data Status tab: when each data source behind
// the site was last refreshed. Kept out of main.js the same way the sales
// panel is: self-contained, one init call, no other contract.
//
// Loads lazily on the tab's FIRST open — the muni-vintage fetch is tiny, but
// the live-service section fires one ?f=json request per service, and paying
// that on every page load for a tab most sessions never open would be waste.
//
// Sales scrape coverage is deliberately NOT here: it is subscriber-derived
// and renders only inside the Sales Analysis panel, which reads the user's
// own local export folder (SPEC-DATA-STATUS-TAB.md).

import {
  SERVICE_SOURCES, CLI_AGR_CAP_URL, MASC_RISK_AREAS_URL,
  MB_PARCEL_DATA_CDN, MB_PARCEL_DATA_REVISION, fetchHistoricalIndex,
} from './arcgis.js';
import { WALLAS_SOURCES } from './wallas.js';
import { getManifest } from './manifest.js';
import { onTabChange } from './lib/tabs.js';
import { vintageRows, publishedRows, serviceEditDate } from './lib/dataStatus.js';

const BASE_URL = import.meta.env?.BASE_URL || '/';

// Every live service the map talks to. The three SERVICE_SOURCES entries and
// WALLAS_SOURCES are the same arrays the provenance exports cite.
const LIVE_SERVICES = [
  ...SERVICE_SOURCES,
  { label: 'Soil Survey (CLI agriculture capability)', url: CLI_AGR_CAP_URL },
  { label: 'MASC Risk Areas', url: MASC_RISK_AREAS_URL },
  ...WALLAS_SOURCES,
];

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

export function initDataStatusTab() {
  const $panel = document.getElementById('tab-panel-status');
  if (!$panel) return;

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
      fetchJson(`${s.url}?f=json`).then((json) => {
        const date = serviceEditDate(json);
        tr.lastChild.textContent = date || (json ? 'not published' : 'unavailable');
        if (!date) tr.lastChild.className = 'is-unknown';
      });
    }
  }

  async function load() {
    const [vintage, manifest, rollSnap, histIndex] = await Promise.all([
      fetchJson(`${BASE_URL}data/muni-vintage.json`),
      getManifest(),
      fetchJson(`${MB_PARCEL_DATA_CDN}/rollentry-snapshot/_index.json`),
      fetchHistoricalIndex().catch(() => null),
    ]);

    muniRows = vintageRows(vintage);
    if ($muniSummary && muniRows) {
      const months = muniRows.map((r) => r.month).filter(Boolean).sort();
      const latest = months.length ? muniRows.find((r) => r.month === months[months.length - 1]) : null;
      $muniSummary.textContent =
        `${muniRows.length} municipalities` + (latest ? ` · newest cohort ${latest.label}` : '');
    }
    renderMunis();
    renderPublished(publishedRows({
      manifest, rollSnap, histIndex, revision: MB_PARCEL_DATA_REVISION,
    }));
    renderServices();
  }

  let loaded = false;
  const loadOnce = () => { if (!loaded) { loaded = true; load(); } };

  onTabChange((tab) => { if (tab === 'status') loadOnce(); });
  // ?t=status in the URL can activate the tab before/around init order —
  // if the panel is already visible, don't wait for a change event.
  if (!$panel.hidden) loadOnce();

  $muniSearch?.addEventListener('input', renderMunis);
}
