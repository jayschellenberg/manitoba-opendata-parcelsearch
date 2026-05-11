// One-off audit: cross-reference Manitoba muni naming across the three
// open-data layers the app queries by name (Roll_Entry, Zoning,
// Dev Plan, Municipal Boundaries). For every Roll_Entry muni, build
// the variants muniNameMatchClause emits and check whether the layer
// has a row whose MUNI_NAME (UPPER) is in that list. Flag any mismatch.
//
// Run: node audit-muni-names.js
// Output: a markdown table per layer, plus a recommendation block.

const ROLL_URL   = 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/ROLL_ENTRY/FeatureServer/0';
const ZONE_URL   = 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Manitoba_Zoning_By_Laws/FeatureServer/0';
const DEVP_URL   = 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Manitoba_Development_Plan_Designations/FeatureServer/0';
const BOUND_URL  = 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/MUNICIPALITY/FeatureServer/0';

// --- copy of muniNameMatchClause's variant generator (NO escaping; pure JS strings) ---
function muniNameVariants(municipality) {
  const upper = municipality.trim().toUpperCase();
  const m = upper.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const bare = (m ? m[1] : upper).trim();
  const type = (m ? m[2] : '').trim();

  const PREFIX_MAP = {
    'TOWN':               ['TOWN OF'],
    'CITY':               ['CITY OF'],
    'VILLAGE':            ['VILLAGE OF'],
    'RM':                 ['RM OF', 'RURAL MUNICIPALITY OF'],
    'MUNICIPALITY':       ['MUNICIPALITY OF'],
    'LGD':                ['LGD OF', 'LOCAL GOVERNMENT DISTRICT OF'],
    'NORTHERN COMMUNITY': ['NORTHERN COMMUNITY OF'],
  };
  const SUFFIX_MAP = {
    'TOWN':               ['TOWN'],
    'CITY':               ['CITY'],
    'VILLAGE':            ['VILLAGE'],
    'RM':                 ['RM'],
    'MUNICIPALITY':       ['MUNICIPALITY', 'M'],
    'LGD':                ['LGD'],
    'NORTHERN COMMUNITY': ['NC', 'NORTHERN COMMUNITY'],
  };
  const ACCENT_HYPHEN_ALIASES = {
    'TACHE':                      ['TACHÉ'],
    'ST FRANCOIS XAVIER':         ['ST FRANÇOIS XAVIER'],
    'KILLARNEY TURTLE MOUNTAIN':  ['KILLARNEY-TURTLE MOUNTAIN'],
  };
  const baseForms = new Set([bare]);
  for (const alias of ACCENT_HYPHEN_ALIASES[bare] || []) baseForms.add(alias);
  const stems = new Set();
  for (const baseForm of baseForms) {
    stems.add(baseForm);
    for (const p of PREFIX_MAP[type] || []) stems.add(`${p} ${baseForm}`);
    for (const s of SUFFIX_MAP[type] || []) stems.add(`${baseForm} (${s})`);
  }
  const variants = new Set();
  for (const stem of stems) {
    variants.add(stem);
    variants.add(stem.replace(/\bST\b/g, 'ST.'));
    variants.add(stem.replace(/\bSTE\b/g, 'STE.'));
    variants.add(stem.replace(/\bST\./g, 'ST'));
    variants.add(stem.replace(/\bSTE\./g, 'STE'));
  }
  return [...variants];
}

async function fetchDistinctNames(url, field) {
  const seen = new Set();
  let offset = 0;
  for (let i = 0; i < 50; i++) {
    const params = new URLSearchParams({
      where: `${field} IS NOT NULL`,
      outFields: field,
      returnDistinctValues: 'true',
      returnGeometry: 'false',
      f: 'json',
      resultRecordCount: '2000',
      resultOffset: String(offset),
    });
    const res = await fetch(`${url}/query?${params}`);
    const data = await res.json();
    const feats = data.features || [];
    for (const f of feats) {
      const v = f.attributes?.[field];
      if (v != null && v !== '') seen.add(String(v).trim());
    }
    if (!data.exceededTransferLimit || feats.length === 0) break;
    offset += feats.length;
  }
  return [...seen].sort();
}

(async () => {
  console.log('Pulling distinct muni names from each layer…');
  const [rollMunis, zoneMunis, devpMunis, boundMunis] = await Promise.all([
    fetchDistinctNames(ROLL_URL,  'Muni_Name_With_Typ'),
    fetchDistinctNames(ZONE_URL,  'MUNI_NAME'),
    fetchDistinctNames(DEVP_URL,  'MUNI_NAME'),
    fetchDistinctNames(BOUND_URL, 'MUNI_LIST_NAME_WITH_TYPE'),
  ]);
  console.log(`Roll_Entry: ${rollMunis.length} · Zoning: ${zoneMunis.length} · DevPlan: ${devpMunis.length} · Boundaries: ${boundMunis.length}`);

  // Build upper-case Sets for O(1) lookup.
  const zoneUpper  = new Set(zoneMunis.map(n => n.toUpperCase()));
  const devpUpper  = new Set(devpMunis.map(n => n.toUpperCase()));
  const boundUpper = new Set(boundMunis.map(n => n.toUpperCase()));

  // For each Roll_Entry muni, build variants and check each layer.
  const results = [];
  for (const muni of rollMunis) {
    const variants = muniNameVariants(muni).map(v => v.toUpperCase());
    const zoneMatch = variants.some(v => zoneUpper.has(v));
    const devpMatch = variants.some(v => devpUpper.has(v));
    const boundMatch = variants.some(v => boundUpper.has(v));
    // Find the actual stored name(s) for diagnostic display.
    const zoneActual = zoneMunis.filter(n => variants.includes(n.toUpperCase()));
    const devpActual = devpMunis.filter(n => variants.includes(n.toUpperCase()));
    const boundActual = boundMunis.filter(n => variants.includes(n.toUpperCase()));
    // For misses, look up the layer's "closest" name (by substring) to
    // surface the actual stored form so we can extend the variant
    // generator if needed.
    const findNear = (list, bare) => {
      const upperBare = bare.toUpperCase();
      return list.filter(n => {
        const u = n.toUpperCase().replace(/[.()]/g, '');
        const b = upperBare.replace(/[.()]/g, '');
        // Match when one contains the other's bare-token form
        return u.includes(b) || b.includes(u.replace(/\s+(TOWN|CITY|RM|VILLAGE|MUNICIPALITY|M|LGD|NC|RURAL MUNICIPALITY|TOWN OF|CITY OF|RM OF|VILLAGE OF|MUNICIPALITY OF|LGD OF|NORTHERN COMMUNITY OF)$/i, '').replace(/^(TOWN OF|CITY OF|RM OF|VILLAGE OF|MUNICIPALITY OF|LGD OF|NORTHERN COMMUNITY OF|RURAL MUNICIPALITY OF)\s+/i, '').trim());
      });
    };
    const bareFromMuni = muni.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const zoneNear  = !zoneMatch  ? findNear(zoneMunis,  bareFromMuni)  : [];
    const devpNear  = !devpMatch  ? findNear(devpMunis,  bareFromMuni)  : [];
    const boundNear = !boundMatch ? findNear(boundMunis, bareFromMuni) : [];

    results.push({
      muni, variants,
      zoneMatch, zoneActual, zoneNear,
      devpMatch, devpActual, devpNear,
      boundMatch, boundActual, boundNear,
    });
  }

  // Focus on St/Ste munis first.
  const steRe = /(?:^|\s)(STE?)\b\s/i;
  const stMunis = results.filter(r => steRe.test(r.muni));
  console.log('\n### St / Ste munis');
  console.log('| Muni | Zoning | Dev Plan | Boundaries |');
  console.log('|---|---|---|---|');
  for (const r of stMunis) {
    const flag = (m) => m ? '✓' : '✗';
    const actual = (list, near) => list.length ? list.join(', ') : (near.length ? `(no match; near: ${near.join(', ')})` : '(no match)');
    console.log(`| ${r.muni} | ${flag(r.zoneMatch)} ${actual(r.zoneActual, r.zoneNear)} | ${flag(r.devpMatch)} ${actual(r.devpActual, r.devpNear)} | ${flag(r.boundMatch)} ${actual(r.boundActual, r.boundNear)} |`);
  }

  // All-munis cross-reference: list every Roll_Entry muni that has at
  // least one layer mismatch.
  const broken = results.filter(r => !r.zoneMatch || !r.devpMatch || !r.boundMatch);
  console.log(`\n### All munis with at least one layer mismatch (${broken.length} of ${results.length})`);
  console.log('| Muni | Zoning | Dev Plan | Boundaries |');
  console.log('|---|---|---|---|');
  for (const r of broken) {
    const flag = (m) => m ? '✓' : '✗';
    const actual = (list, near) => list.length ? list.join(', ') : (near.length ? `near: ${near.slice(0, 3).join(', ')}` : '—');
    console.log(`| ${r.muni} | ${flag(r.zoneMatch)} ${r.zoneMatch ? r.zoneActual.join(', ') : (r.zoneNear.length ? `near: ${r.zoneNear.slice(0, 3).join(', ')}` : '—')} | ${flag(r.devpMatch)} ${r.devpMatch ? r.devpActual.join(', ') : (r.devpNear.length ? `near: ${r.devpNear.slice(0, 3).join(', ')}` : '—')} | ${flag(r.boundMatch)} ${r.boundMatch ? r.boundActual.join(', ') : (r.boundNear.length ? `near: ${r.boundNear.slice(0, 3).join(', ')}` : '—')} |`);
  }

  // Summary
  const counts = {
    zoning:  results.filter(r => r.zoneMatch).length,
    devplan: results.filter(r => r.devpMatch).length,
    bounds:  results.filter(r => r.boundMatch).length,
    total:   results.length,
  };
  console.log(`\n### Summary`);
  console.log(`Roll_Entry munis: ${counts.total}`);
  console.log(`  Resolved on Zoning:      ${counts.zoning} (${(counts.zoning/counts.total*100).toFixed(0)}%)`);
  console.log(`  Resolved on Dev Plan:    ${counts.devplan} (${(counts.devplan/counts.total*100).toFixed(0)}%)`);
  console.log(`  Resolved on Boundaries:  ${counts.bounds} (${(counts.bounds/counts.total*100).toFixed(0)}%)`);
})();
