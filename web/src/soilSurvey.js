// Pure helpers for Manitoba Soil Survey display and parcel composition.
// The source map-unit polygon carries up to three soil components, each
// with an EXTENT percentage. Parcel composition must therefore weight the
// parcel/map-unit intersection by EXTENT1/2/3 rather than treating the
// dominant component as 100 percent of the overlapped polygon.

function clean(value) {
  if (value == null) return '';
  return String(value).trim();
}

function parseExtentPct(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function componentsForFeature(feature) {
  const p = feature?.properties || {};
  const components = [];
  for (const slot of ['1', '2', '3']) {
    const soilName = clean(p[`SOILNAME${slot}`]);
    const soilCode = clean(p[`SOIL_CODE${slot}`]);
    const agriCap = clean(p[`AGRI_CAP${slot}`]);
    const agcapCls = clean(p[`AGCAP_CLS${slot}`]);
    const surfaceText = clean(p[`SURFTEXT${slot}`]);
    const extentPct = parseExtentPct(p[`EXTENT${slot}`]);
    if (!soilName && !soilCode && !agriCap && !agcapCls && !surfaceText) continue;
    components.push({
      soilName: soilName || null,
      soilCode: soilCode || null,
      agriCap: agriCap || null,
      agcapCls: agcapCls || null,
      surfaceText: surfaceText || null,
      paintColor: slot === '1' ? (p._paintColor || null) : null,
      extentPct,
      mapUnit: clean(p.MAPUNITNOM) || null,
    });
  }

  if (components.length === 0) return [];

  const validSum = components.reduce((sum, c) => sum + (c.extentPct || 0), 0);
  const missing = components.filter((c) => c.extentPct == null);
  if (validSum > 100) {
    for (const c of components) c.weight = c.extentPct ? c.extentPct / validSum : 0;
  } else if (validSum > 0) {
    const remainder = Math.max(0, 100 - validSum);
    for (const c of components) {
      c.weight = c.extentPct != null
        ? c.extentPct / 100
        : (missing.length ? (remainder / missing.length) / 100 : 0);
    }
  } else {
    const equal = 1 / components.length;
    for (const c of components) c.weight = equal;
  }

  return components.filter((c) => Number.isFinite(c.weight) && c.weight > 0);
}

function componentKey(c) {
  return [
    c.soilCode || '',
    c.soilName || '',
    c.agriCap || '',
    c.agcapCls || '',
    c.surfaceText || '',
  ].join('|');
}

/**
 * Convert area-overlap matches from joinTopNByArea into parcel soil
 * composition rows. Each match ratio is the map-unit polygon coverage
 * of the parcel. The returned parcelPct values multiply that ratio by
 * the source EXTENT percentage of each soil component within the unit.
 */
export function soilSurveyComponentsFromMatches(
  matches,
  { maxRows = 5, minOtherPct = 0.1, parcelAreaAcres = null } = {},
) {
  if (!Array.isArray(matches) || matches.length === 0) return [];

  const byComponent = new Map();
  for (const match of matches) {
    const ratio = Number(match?.ratio);
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    const components = componentsForFeature(match.feature);
    for (const component of components) {
      const parcelPct = ratio * component.weight * 100;
      if (!Number.isFinite(parcelPct) || parcelPct <= 0) continue;
      const key = componentKey(component);
      if (!byComponent.has(key)) {
        byComponent.set(key, {
          agriCap: component.agriCap,
          agcapCls: component.agcapCls,
          soilName: component.soilName,
          soilCode: component.soilCode,
          surfaceText: component.surfaceText,
          paintColor: component.paintColor,
          parcelPct: 0,
          mapUnits: new Set(),
        });
      }
      const row = byComponent.get(key);
      row.parcelPct += parcelPct;
      if (!row.paintColor && component.paintColor) row.paintColor = component.paintColor;
      if (component.mapUnit) row.mapUnits.add(component.mapUnit);
    }
  }

  const rows = [...byComponent.values()]
    .map((row) => ({
      ...row,
      parcelPct: Math.min(100, row.parcelPct),
      areaAcres: Number.isFinite(parcelAreaAcres) && parcelAreaAcres > 0
        ? parcelAreaAcres * Math.min(100, row.parcelPct) / 100
        : null,
      mapUnits: [...row.mapUnits],
    }))
    .sort((a, b) => (
      b.parcelPct - a.parcelPct ||
      String(a.soilName || '').localeCompare(String(b.soilName || '')) ||
      String(a.soilCode || '').localeCompare(String(b.soilCode || ''))
    ));

  if (!Number.isFinite(maxRows) || rows.length <= maxRows) return rows;
  const shown = rows.slice(0, maxRows);
  const otherPct = rows.slice(maxRows).reduce((sum, row) => sum + row.parcelPct, 0);
  if (otherPct >= minOtherPct) {
    shown.push({
      isOther: true,
      soilName: 'Other mapped soils',
      soilCode: null,
      agriCap: null,
      agcapCls: null,
      surfaceText: null,
      parcelPct: Math.min(100, otherPct),
      areaAcres: Number.isFinite(parcelAreaAcres) && parcelAreaAcres > 0
        ? parcelAreaAcres * Math.min(100, otherPct) / 100
        : null,
      mapUnits: [],
    });
  }
  return shown;
}
