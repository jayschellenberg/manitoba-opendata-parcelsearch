// Machine-readable index of the data this site serves, for scripts and AI
// agents (Claude skills such as mao-assessment, mb-zoning and the
// property-intake agent) that want a parcel's facts without driving the UI.
//
// Built at BUILD time by the agents-index Vite plugin (vite.config.js), which
// reads the pinned data-repo SHAs out of src/arcgis.js and passes them in, so
// /agents.json and /openapi.json always name the exact immutable commits the
// app itself is reading. Pure module: no DOM, no fetch; unit-tested in
// test/agentsIndex.test.js.
//
// Nothing here publishes new data. Every URL below is one the app already
// fetches; the index only documents keys, fields, vintage and terms.

export const SITE = 'https://manitoba-opendata-parcelsearch.vercel.app';
export const ARCGIS_BASE = 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services';
export const R2_BASE = 'https://pub-091058079bf6458da1681945177e1682.r2.dev';

// Extracts the two pins from the text of src/arcgis.js. Kept here (not in
// the plugin) so the test can prove the patterns still match the source.
export function readPins(arcgisSource) {
  const parcelData = /MB_PARCEL_DATA_REVISION\s*=\s*'([0-9a-f]{40})'/.exec(arcgisSource)?.[1] ?? null;
  const history = /gh-data\/mb-parcel-history\/([0-9a-f]{40})/.exec(arcgisSource)?.[1] ?? null;
  return { parcelData, history };
}

const OGL_MB = 'Open Government Licence - Manitoba. Credit "Contains information licensed under the Open Government Licence - Manitoba."';
const MAO_TERMS = 'Derived from Manitoba Assessment Online public summaries. Terms of reuse not confirmed; use for screening and cite MAO, do not republish in bulk.';

export function buildAgentsIndex({ parcelData, history }, builtAt = new Date().toISOString()) {
  if (!parcelData || !history) throw new Error('agentsIndex: missing data-repo pin');
  const pd = `${SITE}/gh-data/mb-parcel-data/${parcelData}`;
  const hist = `${SITE}/gh-data/mb-parcel-history/${history}`;

  // Per-municipality families in mb-parcel-data keyed by municipality NAME.
  const byName = (id, title, fields, note, extra = {}) => ({
    id, title,
    index_url: `${pd}/${id}/_index.json`,
    url_template: `${pd}/${id}/{file}`,
    key: 'Muni_Name_With_Typ -> _index.json[name].file (a flat map; keys starting "_" are metadata); then Roll_No_Txt inside the shard',
    format: 'json', fields, notes: note,
    vintage: `${pd}/${id}/_index.json (_meta or metadata block)`,
    licence: extra.licence ?? 'Mixed open data; see vintage block sources',
    ...extra,
  });

  return {
    schema: 1,
    name: 'Manitoba Open Data Parcel Search: data index for agents',
    site: SITE,
    built_at: builtAt,
    openapi: `${SITE}/openapi.json`,
    human_page: `${SITE}/agents.html`,
    coverage: 'Manitoba outside the City of Winnipeg (186 municipalities, about 437,000 assessment parcels). Winnipeg: see https://winnipeg-opendata-parcelsearch.vercel.app/agents.json',
    usage: [
      'Screening and research only. Not an appraisal, survey, legal or planning opinion; confirm zoning with the municipality and assessment with MAO before relying on either.',
      'Prefer the pinned /gh-data URLs: they are immutable per commit and edge-cached, so repeat fetches are cheap. Do not crawl the live ArcGIS services province-wide.',
      'The live provincial ROLL_ENTRY service has required a token since 2026-11-17. Use rollentry-snapshot below for parcel records and geometry.',
      'Rolls repeat across municipalities. Always key a parcel on municipality number or name PLUS Roll_No_Txt.',
      'Cite the source and vintage of each figure (the vintage pointer on every dataset).',
    ],
    pins: { 'mb-parcel-data': parcelData, 'mb-parcel-history': history },
    keys: {
      Roll_No_Txt: 'Roll number as text with three decimals, e.g. "12345.000". Normalise a bare roll by padding the decimals.',
      Muni_Name_With_Typ: 'Municipality name with type, e.g. "PINEY (RM)", "STEINBACH (CITY)". Shards are named by compacting it: PINEY (RM) -> PINEY_RM.json; always resolve through _index.json rather than guessing.',
      muni_no: 'Municipality number, the leading digits of the Roll Entry "Municipality" field ("168 - RM OF ROCKWOOD" -> 168).',
    },
    recipes: [
      {
        task: 'Address to parcel (roll, municipality, value, geometry)',
        steps: [
          `GET ${pd}/rollentry-snapshot/_index.json; pick munis[<Muni_Name_With_Typ>].file (also gives muni_no).`,
          `GET ${pd}/rollentry-snapshot/{file}; filter features where properties.Property_Address contains the street name, then match the civic number.`,
          'Read Roll_No_Txt, Municipality, Total_Value, Frontage_or_Area, Dwelling_Units, Asmt_Rpt_Url (the MAO report link) and the polygon.',
        ],
      },
      {
        task: 'Roll to assessed land, building and total value',
        steps: [
          `GET ${pd}/assessment/{muni_no}.json; rows are arrays in the order of "fields"; match roll_no_txt.`,
          `Province-wide alternative (about 4 MB gzipped): GET ${SITE}/api/assessment-index, keyed "muni_no|Roll_No_Txt".`,
        ],
      },
      {
        task: 'Roll to legal description, lot/block/plan and title numbers',
        steps: [`GET ${SITE}/api/legal-index (138 MB, 438k rows; fetch once and cache). Key "muni_no|roll_no_txt".`],
      },
      {
        task: 'Zoning and development-plan designation for a parcel',
        steps: [
          'Take the parcel polygon (recipe 1) or its bounding box in EPSG:4326.',
          `POST ${ARCGIS_BASE}/Manitoba_Zoning_By_Laws/FeatureServer/0/query with geometry=<xmin,ymin,xmax,ymax>, geometryType=esriGeometryEnvelope, inSR=4326, spatialRel=esriSpatialRelIntersects, outFields=ZONE,ZONE_NAME,ZONE_CATEGORY,ZBL,ZBL_A,AMENDMENT_DESCRIPTION,MUNI_NAME, outSR=4326, f=geojson.`,
          'Intersect returned zones with the parcel polygon and rank by area; the app reports the top two with percentages.',
          `Same query against ${ARCGIS_BASE}/Manitoba_Development_Plan_Designations/FeatureServer/0 with outFields=DES_NAME,DES_CATEGORY,DP_BYLAW,DPA_BYLAW,PLANNINGDISTRICT.`,
        ],
      },
      {
        task: 'Flood, water, soil and land facts for a parcel',
        steps: ['Resolve the shard by Muni_Name_With_Typ through each family\'s _index.json (flood, water, parcel-masc, landcover, landfacts), then read the Roll_No_Txt entry. A roll missing from flood or water means none was found, not unknown.'],
      },
      {
        task: 'What the parcel looked like at an earlier date',
        steps: [
          `GET ${hist}/index.json for snapshot dates; GET ${hist}/{date}/parcels/{muni_no}.json and match Roll_No_Txt.`,
          `Outline changes and lineage: GET ${hist}/changes/{muni_no}.json -> rolls[Roll_No_Txt].`,
        ],
      },
    ],
    datasets: [
      {
        id: 'rollentry-snapshot', title: 'Assessment parcels (Roll Entry snapshot)',
        index_url: `${pd}/rollentry-snapshot/_index.json`,
        url_template: `${pd}/rollentry-snapshot/{file}`,
        key: 'Muni_Name_With_Typ -> munis[name] {file, count, muni_no}',
        format: 'geojson',
        fields: ['Roll_No_Txt', 'Property_Address', 'Municipality', 'Muni_Name_With_Typ', 'Asmt_Roll', 'Dwelling_Units', 'Frontage_or_Area', 'Total_Value', 'Asmt_Rpt_Url', 'OBJECTID'],
        notes: 'Geometry simplified at 0.0001 degrees. Total_Value is the roll value as published by the province.',
        vintage: 'snapshot_date and source in _index.json',
        licence: OGL_MB,
      },
      {
        id: 'assessment', title: 'Assessed values, latest tax year',
        index_url: `${pd}/assessment/_index.json`,
        url_template: `${pd}/assessment/{muni_no}.json`,
        key: 'muni_no; rows matched on roll_no_txt',
        format: 'json',
        fields: ['muni_no', 'roll_no_txt', 'year', 'land', 'buildings', 'total', 'class', 'tax_status'],
        notes: 'Latest year only, summed across classes; class and tax_status are the dominant class by value. No tax dollar amounts.',
        vintage: 'metadata.generated_at and source_modified in _index.json',
        licence: MAO_TERMS,
      },
      {
        id: 'assessment-index', title: 'Assessed values, province-wide single file',
        url_template: `${SITE}/api/assessment-index`,
        key: '"muni_no|Roll_No_Txt"', format: 'json',
        fields: ['muni_no', 'roll_no_txt', 'year', 'land', 'buildings', 'total', 'class', 'tax_status'],
        notes: 'Same content as the assessment family in one file (about 30 MB raw).',
        vintage: `${SITE}/data/manifest.json datasets.assessment_index`,
        licence: MAO_TERMS,
      },
      {
        id: 'legal-index', title: 'Legal descriptions and titles',
        url_template: `${SITE}/api/legal-index`,
        key: '"muni_no|roll_no_txt"', format: 'json',
        fields: ['muni_no', 'roll_no_txt', 'extrct_prop_id', 'municipality', 'civic_address', 'legal_description', 'legal_detail', 'lot', 'block', 'plan', 'certificates_of_title', 'source_url'],
        notes: '138 MB. Fetch once per session.',
        vintage: `${SITE}/data/manifest.json datasets.legal_index`,
        licence: MAO_TERMS,
      },
      byName('flood', 'Flood-zone membership', ['z: {RRVDFA, LRDFA, SMA, F200, FL1997, FL2009, FL2011, WWCR, WWCC} as % of parcel'],
        'Only parcels touching a zone are listed; a municipality absent from the index has none. RRVDFA/LRDFA are statutory Designated Flood Areas.',
        { licence: OGL_MB }),
      byName('water', 'Water influence', ['i influenced', 'c class (Waterfront/Direct/Reserve/Near)', 't water-body type', 'b water-body name', 'd distance ft'],
        'Only parcels with water within 50 m are listed.', { licence: 'Derived from OpenStreetMap (ODbL), NHN and provincial waterways; credit OpenStreetMap contributors.' }),
      byName('parcel-masc', 'MASC soil productivity rating per parcel', ['rating', 'ratings', 'ra risk area', 'q', 's', 't', 'r', 'd', 'source', 'label'],
        'Dominant rating by area overlap.', { licence: 'MASC SearchLand ratings; terms not confirmed.' }),
      byName('landcover', 'Land cover fractions (parcels over 10 acres)', ['cult', 'past', 'bush', 'wet', 'other'],
        '2020 Land Cover of Canada, collapsed to five groups.', { licence: 'Statistics Canada / NRCan open licence; credit the source.' }),
      byName('landfacts', 'Land facts (20 acres or more with a MASC rating)', ['cp[] crop % 2009-2025', 'dom[] dominant class', 'rel', 'slp', 'z', 'wet', 'wc', 'gsw', 'gsi', 'mix', 'cc', 'cn', 'obs'],
        'See _meta for year range and sources.', { licence: 'AAFC, NRCan, ECCC (OGL - Canada) and JRC Global Surface Water.' }),
      byName('mf-newbuild', 'Multi-family new construction (3+ units)', ['du', 'ad', 'cl', 'p', 'e[{y,k,b,bp,c}]', 'sdu'],
        'Inferred from jumps in assessed building value; event years are assessment years.', { licence: MAO_TERMS }),
      {
        id: 'history-snapshots', title: 'As-of-date parcel, zoning and development-plan snapshots',
        index_url: `${hist}/index.json`,
        url_template: `${hist}/{date}/{parcels|zoning|devplan}/{muni_no}.json`,
        key: 'snapshot date + muni_no', format: 'geojson',
        fields: ['Roll_No_Txt', 'Property_Address', 'Municipality', 'Muni_Name_With_Typ', 'Asmt_Roll', 'Dwelling_Units', 'Frontage_or_Area', 'Total_Value (string, e.g. "$633,800")', 'Asmt_Rpt_Url'],
        notes: 'Semi-annual. Zoning shards carry ZONE, ZONE_NAME, ZBL; devplan shards carry DES_NAME, DP_BYLAW.',
        vintage: `${hist}/{date}/manifest.json`,
        licence: OGL_MB,
      },
      {
        id: 'parcel-changes', title: 'Parcel outline changes and lineage',
        index_url: `${hist}/changes/_index.json`,
        url_template: `${hist}/changes/{muni_no}.json`,
        key: 'muni_no; rolls[Roll_No_Txt]', format: 'json',
        fields: ['fs', 'ls', 'onb', 'cna', 'o', 'c', 'a', 'p', 'from', 'to', 'rel'],
        notes: 'Outline windows and reason codes; no values.',
        vintage: 'snapshot dates in changes/_index.json',
        licence: OGL_MB,
      },
      {
        id: 'traffic-history', title: 'Highway traffic counts (AADT) by station, 2003-2025',
        url_template: `${SITE}/data/traffic-history.json`,
        key: 'stations[StationNum]', format: 'json',
        fields: ['t type', 'hwy', 'loc', 'y {year: aadt}'],
        notes: 'From the annual Traffic on Manitoba Highways reports. Station locations: All_Stations_C_Only feature service.',
        vintage: 'metadata.built',
        licence: 'Manitoba Transportation and Infrastructure (MHTIS); terms not confirmed.',
      },
      {
        id: 'data-manifest', title: 'Vintage of the site-level data files',
        url_template: `${SITE}/data/manifest.json`, key: 'datasets.{name}', format: 'json',
        fields: ['file', 'generated_at', 'source', 'source_modified', 'row_count'],
        notes: 'Check before citing assessment or legal figures.',
        vintage: 'generated_at', licence: 'n/a',
      },
    ],
    live_services: [
      { id: 'zoning', url: `${ARCGIS_BASE}/Manitoba_Zoning_By_Laws/FeatureServer/0`, licence: OGL_MB },
      { id: 'development-plan', url: `${ARCGIS_BASE}/Manitoba_Development_Plan_Designations/FeatureServer/0`, licence: OGL_MB },
      { id: 'quarter-sections', url: `${ARCGIS_BASE}/MB_LegalDesc/FeatureServer/0`, licence: OGL_MB },
      { id: 'municipal-boundaries', url: `${ARCGIS_BASE}/MUNICIPALITY/FeatureServer/0`, licence: OGL_MB },
      { id: 'soil-survey', url: `${ARCGIS_BASE}/Soil_Survey_MB/FeatureServer/0`, licence: OGL_MB },
      { id: 'traffic-flow', url: 'https://services6.arcgis.com/HQUud09zgy3Asw9X/arcgis/rest/services/E_MHTIS_LRS_20260923/FeatureServer/1', licence: 'MHTIS; terms not confirmed' },
      { id: 'contaminated-sites', url: 'https://manitoba.ca/sd/waste_management/contaminated_sites/registry/cs-data.csv', licence: 'Province of Manitoba; terms not confirmed' },
    ],
    not_served: [
      'MAO sales (subscriber data): never published; the app reads it only from a folder the user picks.',
      'Property tax dollars, mill rates and levies: not held anywhere in this site.',
      'Census, building permits and development tracking: not in this site. Census profiles are at https://housing-economic-data.vercel.app.',
    ],
  };
}

// A small OpenAPI 3.1 description of the same-origin endpoints, for clients
// that consume OpenAPI. The shard families are one templated path.
export function buildOpenApi({ parcelData, history }) {
  const json = { description: 'JSON', content: { 'application/json': {} } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Manitoba Open Data Parcel Search: data endpoints',
      version: '1',
      description: 'Read-only, static or edge-cached JSON. Screening and research only. Pinned commits: '
        + `mb-parcel-data ${parcelData}, mb-parcel-history ${history}. See /agents.json for keys, fields and recipes.`,
    },
    servers: [{ url: SITE }],
    paths: {
      '/agents.json': { get: { summary: 'This index: datasets, keys, recipes, licences', responses: { 200: json } } },
      '/gh-data/{repo}/{sha}/{path}': {
        get: {
          summary: 'Immutable shard file from mb-parcel-data or mb-parcel-history at a pinned commit',
          parameters: [
            { name: 'repo', in: 'path', required: true, schema: { type: 'string', enum: ['mb-parcel-data', 'mb-parcel-history'] } },
            { name: 'sha', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{40}$' }, description: 'Use the pin in /agents.json' },
            { name: 'path', in: 'path', required: true, schema: { type: 'string' }, description: 'e.g. assessment/168.json, flood/_index.json' },
          ],
          responses: { 200: json, 404: { description: 'No such file at that commit' } },
        },
      },
      '/api/assessment-index': { get: { summary: 'Assessed values for every parcel, keyed "muni_no|Roll_No_Txt"', responses: { 200: json } } },
      '/api/legal-index': { get: { summary: 'Legal descriptions and titles for every parcel (138 MB)', responses: { 200: json } } },
      '/data/manifest.json': { get: { summary: 'Vintage of the site-level data files', responses: { 200: json } } },
      '/data/traffic-history.json': { get: { summary: 'AADT by station and year, 2003-2025', responses: { 200: json } } },
      '/data/muni-vintage.json': { get: { summary: 'Last assessment refresh per municipality', responses: { 200: json } } },
    },
  };
}
