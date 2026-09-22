// export-soil-geojson.js -- pull the province-wide Manitoba Soil Survey into
// GeoJSONSeq for tippecanoe. Driven by rebuild-soil-tiles.ps1.
//
// WHY NOT ogr2ogr, WHICH IS FASTER AND ALREADY INSTALLED
// -----------------------------------------------------
// It was the first thing tried, and it pulls all 116,767 polygons in 2m47s
// against ogr2ogr's own paging. It also fails partway through a long run:
//
//   ERROR 1: Invalid FeatureCollection object. Missing 'features' member.
//
// That is ArcGIS rate-limiting. The service answers a throttled request with
// HTTP 200 and an {"error":{"code":429}} BODY, so GDAL's HTTP retry never
// sees a failure to retry -- it just gets a document with no features and
// gives up mid-layer. web/src/arcgis.js documents the same behaviour and
// handles it the same way this does; a single page of 2,000 with the full
// field list returns 4.6 MB perfectly well, so the payload was never the
// problem.
//
// So: our own paging, with the retry the situation actually needs. Node
// rather than R because the first attempt at this was an R script whose
// per-feature jsonlite round-trip projected out to about six hours; Node
// writes the same lines in minutes.
//
// DISPLAY ONLY. Nothing measured comes from these tiles -- parcel soil
// composition is joined against the full-resolution scoped fetch or read from
// the soilfacts shards. maxAllowableOffset here is deliberate and safe for
// that reason, and only for that reason.
//
// Usage:
//   node scripts/export-soil-geojson.js <out.geojsonl>

import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Soil_Survey_MB/FeatureServer/0/query';

// The fields the paint and the popup read. Kept in step with
// CLI_AGR_CAP_OUTFIELDS in web/src/arcgis.js; the source carries 149 columns
// and the rest are weight in every tile.
const FIELDS = [
  'OBJECTID', 'MAPUNITNOM',
  ...[1, 2, 3].flatMap((s) => [
    `SOILNAME${s}`, `SOIL_CODE${s}`, `EXTENT${s}`,
    `SURFTEXT${s}`, `AGCAP_CLS${s}`, `AGRI_CAP${s}`,
  ]),
].join(',');

// ~5 m at this latitude: an order of magnitude inside the survey's own
// 1:20,000-and-coarser mapping accuracy, and tippecanoe simplifies again per
// zoom. Cuts the download from roughly a gigabyte.
const MAX_OFFSET = '0.00005';
const PAGE = 2000;
const MAX_ATTEMPTS = 5;

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/export-soil-geojson.js <out.geojsonl>');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST one query, retrying the failure mode that actually happens here.
 *
 * A throttled ArcGIS request is HTTP 200 with an error body, so the status
 * code cannot be the test — the parsed payload has to be. Anything without
 * the shape we asked for is retried with backoff, and exhausting the
 * attempts throws rather than returning a short page: a silently truncated
 * province is the one outcome worth failing the build over.
 */
async function post(params, expect) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });
      const body = await res.json();
      if (body?.error) {
        last = new Error(`ArcGIS error ${body.error.code}: ${body.error.message || ''}`);
      } else if (!expect(body)) {
        last = new Error('response missing the requested member');
      } else {
        return body;
      }
    } catch (err) {
      last = err;
    }
    const wait = 2000 * attempt;
    console.warn(`  retry ${attempt}/${MAX_ATTEMPTS - 1} in ${wait / 1000}s — ${last.message}`);
    await sleep(wait);
  }
  throw last;
}

console.log('Requesting the complete OBJECTID list...');
const idBody = await post(
  { where: '1=1', returnIdsOnly: 'true', returnGeometry: 'false', f: 'json' },
  (b) => Array.isArray(b?.objectIds),
);
const ids = idBody.objectIds;
console.log(`  ${ids.length.toLocaleString()} polygons province-wide`);

fs.mkdirSync(path.dirname(out), { recursive: true });
const stream = fs.createWriteStream(out, { encoding: 'utf8' });
const write = (line) => new Promise((resolve) => {
  if (!stream.write(line)) stream.once('drain', resolve); else resolve();
});

let written = 0;
for (let i = 0; i < ids.length; i += PAGE) {
  const chunk = ids.slice(i, i + PAGE);
  const fc = await post({
    where: '1=1',
    objectIds: chunk.join(','),
    outFields: FIELDS,
    returnGeometry: 'true',
    outSR: '4326',
    maxAllowableOffset: MAX_OFFSET,
    f: 'geojson',
  }, (b) => Array.isArray(b?.features));

  for (const f of fc.features) {
    if (!f?.geometry) continue;      // attribute-only rows draw nothing
    await write(`${JSON.stringify(f)}\n`);
    written++;
  }
  process.stdout.write(`\r  ${written.toLocaleString()} / ${ids.length.toLocaleString()}`);
}
stream.end();
await new Promise((r) => stream.on('finish', r));

const mb = fs.statSync(out).size / 1e6;
console.log(`\nWrote ${written.toLocaleString()} features -> ${out} (${mb.toFixed(1)} MB)`);

// The floor is not cosmetic. Partial coverage would show as the survey simply
// stopping somewhere, with nothing on screen to say the layer is incomplete.
if (written < ids.length * 0.95) {
  console.error(`Only ${written} of ${ids.length} features written. Refusing a short layer.`);
  process.exit(1);
}
