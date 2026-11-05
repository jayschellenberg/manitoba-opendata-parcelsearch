// Provincial Special Planning Areas: zoning set by a Manitoba Regulation,
// not the host municipality's by-law (Jason, 2026-11-05).
//
// The one in the province today is the Inland Port Special Planning Area,
// CentrePort Canada's lands in the RM of Rosser. Its development plan and
// zoning by-law are Schedules A and B of the Inland Port Special Planning
// Area Regulation, M.R. 48/2016, registered March 8, 2016
// (web2.gov.mb.ca/laws/regs/current/048-2016.php). The province's zoning
// and development-plan layers file those polygons under Rosser with
// ZBL / DP_BYLAW "48/2016" (once as " 48/2016") and PLANNINGDISTRICT
// "Inland Port Special Planning Area", so without this module the app
// called the regulation "By-law 48/2016" of Rosser.
//
// Amendments inside the area (the zoning layer's ZBL_A, e.g. "10/2021") are
// the planning authority's own amending numbers, so they are reported as
// "as amended by …" without claiming they are regulations.
//
// The outline overlay reads public/special-planning-areas.geojson, built by
// r/build_special_planning_areas.R from the weekly zoning snapshot.

import { realStr } from './cellFormat.js';

export const SPECIAL_PLANNING_AREAS = [
  {
    key: 'inland-port',
    regulation: '48/2016',
    name: 'Inland Port Special Planning Area',
    short: 'CentrePort SPA',
    common: 'CentrePort',
    registered: '2016-03-08',
    district: /inland\s+port\s+special\s+planning\s+area/i,
  },
];

/** The Special Planning Area a zoning or dev-plan polygon belongs to, or
 *  null. Matches on the planning district first, then on the regulation
 *  number in the by-law field (trimmed: the layer has " 48/2016"). */
export function specialPlanningArea(props = {}, table = SPECIAL_PLANNING_AREAS) {
  const district = realStr(props.PLANNINGDISTRICT);
  const bylaw = realStr(props.ZBL ?? props.DP_BYLAW);
  return table.find((s) => (district && s.district.test(district)) || bylaw === s.regulation) || null;
}

/** "M.R. 48/2016 (CentrePort SPA)" — the by-law cell / popup line. */
export function spaBylawLine(spa) {
  return spa ? `M.R. ${spa.regulation} (${spa.short})` : null;
}

/** The results grid / CSV by-law cell: "M.R. 48/2016 (CentrePort SPA)"
 *  inside a Special Planning Area, else the layer's own value (ZBL for
 *  zoning, DP_BYLAW for the development plan), trimmed. */
export function bylawCellText(props = {}, field = 'ZBL') {
  const raw = realStr(props?.[field]);
  if (!raw) return null;
  return spaBylawLine(specialPlanningArea(props)) || raw;
}

/** "Inland Port Special Planning Area (CentrePort), Manitoba Regulation
 *  48/2016" — the long form for the Addenda label and legend. */
export function spaLongName(spa) {
  return spa ? `${spa.name} (${spa.common}), Manitoba Regulation ${spa.regulation}` : null;
}

// ---- Map overlay -----------------------------------------------------------

export const SPA_URL = '/special-planning-areas.geojson';
export const SPA_SOURCE = 'special-planning-areas';
export const SPA_LAYERS = ['spa-fill', 'spa-line'];
/** Violet: clear of the zoning palette's reds/blues/greens and of the
 *  amber "changes" highlight. */
export const SPA_COLOR = '#6d28d9';

const emptyFc = () => ({ type: 'FeatureCollection', features: [] });

/** Add the (empty, hidden) source and layers. The fill is near-transparent
 *  and exists only so a click inside the area finds it; the dashed line is
 *  the overlay. Placed above the zoning fill so it reads over the zones. */
export function addSpaLayers(map, { beforeId } = {}) {
  if (map.getSource(SPA_SOURCE)) return;
  map.addSource(SPA_SOURCE, { type: 'geojson', data: emptyFc() });
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  map.addLayer({
    id: 'spa-fill',
    type: 'fill',
    source: SPA_SOURCE,
    layout: { visibility: 'none' },
    paint: { 'fill-color': SPA_COLOR, 'fill-opacity': 0.04 },
  }, before);
  map.addLayer({
    id: 'spa-line',
    type: 'line',
    source: SPA_SOURCE,
    layout: { visibility: 'none', 'line-join': 'round' },
    paint: {
      'line-color': SPA_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 12, 2.5, 16, 3.5],
      'line-dasharray': [3, 2],
      'line-opacity': 0.95,
    },
  }, before);
}

export function setSpaData(map, fc) {
  map.getSource(SPA_SOURCE)?.setData(fc || emptyFc());
}

export function setSpaVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of SPA_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

let cached = null;
/** Fetch the outlines once per page. */
export function fetchSpecialPlanningAreas(fetchFn = globalThis.fetch, url = SPA_URL) {
  if (!cached) {
    cached = fetchFn(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`special planning areas ${r.status}`))))
      .catch((err) => { cached = null; throw err; });
  }
  return cached;
}

/** True when any outline's bounding box overlaps `bounds`, given as
 *  [[w, s], [e, n]] (mapFurniture.framedBounds) or [w, s, e, n]. */
export function spaInBounds(fc, bounds) {
  const [w, s, e, n] = Array.isArray(bounds?.[0]) ? bounds.flat() : (bounds || []);
  if (![w, s, e, n].every(Number.isFinite)) return false;
  return (fc?.features || []).some((f) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
      } else c.forEach(walk);
    };
    if (f?.geometry?.coordinates) walk(f.geometry.coordinates);
    return minX <= e && maxX >= w && minY <= n && maxY >= s;
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Popup body for a click inside an outline. */
export function spaPopupHtml(props = {}) {
  const spa = specialPlanningArea({ PLANNINGDISTRICT: props.district, ZBL: props.regulation });
  const title = spa ? `${spa.name} (${spa.common})` : realStr(props.district) || 'Special Planning Area';
  const reg = spa ? spa.regulation : realStr(props.regulation);
  return `<div style="max-width:260px;line-height:1.4"><strong>${esc(title)}</strong>`
    + (reg ? `<br>Manitoba Regulation ${esc(reg)}` : '')
    + (props.muni ? `<br><em>RM of ${esc(props.muni)}</em>` : '')
    + '<br><small style="color:#666">Zoning and development plan are set by the regulation, not the municipal by-law.</small></div>';
}
