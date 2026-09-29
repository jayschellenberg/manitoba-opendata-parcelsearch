// build-section-grid-tiles.js -- turn the province-wide section grid
// (r/build_section_grid.R -> web/public/data/section-grid.json) into the two
// GeoJSONSeq layers tippecanoe tiles. Driven by rebuild-section-grid-tiles.ps1.
//
// WHY TILES
// ---------
// With no municipality selected, the Section/township grid toggle used to
// download the whole 40 MB / 215k-feature GeoJSON, parse it on the main thread
// and hand every polygon to a GeoJSON source -- to draw an overview in which
// most of those sections are off screen or sub-pixel. The grid is DISPLAY
// ONLY (nothing searches, joins or exports from it; it only feeds the line
// and label layers), so a range-requested PMTiles archive loses nothing.
//
// Two layers, same split the GeoJSON path already makes in map.js:
//   sections        polygons, drawn as dashed outlines
//   section-labels  one Point per section at its centroid. A symbol layer on
//                   a Polygon labels once PER TILE the polygon spans; a Point
//                   sits in exactly one tile. Tagged tippecanoe.minzoom 11 to
//                   match the label layer's own minzoom, so z8-z10 tiles don't
//                   carry 215k points nobody can see.
//
// Usage:
//   node scripts/build-section-grid-tiles.js <in.json> <outDir>

import fs from 'node:fs';
import path from 'node:path';

const [inPath, outDir] = process.argv.slice(2);
if (!inPath || !outDir) {
  console.error('usage: node scripts/build-section-grid-tiles.js <section-grid.json> <outDir>');
  process.exit(2);
}

const LABEL_MINZOOM = 11;

const fc = JSON.parse(fs.readFileSync(inPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
const polyOut = fs.createWriteStream(path.join(outDir, 'sections.geojsonl'));
const labelOut = fs.createWriteStream(path.join(outDir, 'section-labels.geojsonl'));

// Same averaging as polygonCentroid() in map.js, so a tiled label lands where
// the GeoJSON path puts it. Sections are rectangles; the vertex mean is exact.
function centroid(ring) {
  const last = ring.length - 1;
  const closed = ring[last][0] === ring[0][0] && ring[last][1] === ring[0][1];
  const n = closed ? last : ring.length;
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [Math.round((x / n) * 1e5) / 1e5, Math.round((y / n) * 1e5) / 1e5];
}

let written = 0, skipped = 0;
const seen = new Set();
for (const f of fc.features || []) {
  const label = f?.properties?.label;
  const ring = f?.geometry?.type === 'Polygon' ? f.geometry.coordinates?.[0] : null;
  if (!label || !Array.isArray(ring) || ring.length < 4) { skipped++; continue; }
  // One feature per section -- dedupSectionLabels() in main.js enforced this
  // on the GeoJSON path; the build owns it now.
  if (seen.has(label)) { skipped++; continue; }
  seen.add(label);
  polyOut.write(JSON.stringify({ type: 'Feature', geometry: f.geometry, properties: { label } }) + '\n');
  labelOut.write(JSON.stringify({
    type: 'Feature',
    tippecanoe: { minzoom: LABEL_MINZOOM },
    geometry: { type: 'Point', coordinates: centroid(ring) },
    properties: { label },
  }) + '\n');
  written++;
}

await Promise.all([polyOut, labelOut].map((s) => new Promise((res, rej) => {
  s.on('error', rej);
  s.end(res);
})));

const meta = { source: path.basename(inPath), features: written, skipped };
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(`Sections: ${written.toLocaleString()} written, ${skipped.toLocaleString()} skipped (no label/geometry or duplicate)`);
