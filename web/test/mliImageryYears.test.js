import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const coveragePath = path.join(here, '..', 'public', 'mli-imagery-years.geojson');
const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));

assert.equal(coverage.type, 'FeatureCollection');
assert.deepEqual(
  coverage.features.map((feature) => feature.properties.year),
  [2007, 2008, 2009, 2010, 2011, 2012, 2013],
);
assert.equal(
  coverage.features.reduce((sum, feature) => sum + feature.properties.cell_count, 0),
  6109,
);
for (const feature of coverage.features) {
  assert.equal(feature.geometry.type, 'MultiPolygon');
  assert.equal(
    feature.properties.cell_count,
    feature.properties.exact_cells + feature.properties.inferred_cells,
  );
}

console.log('mliImageryYears.test.js: coverage years and counts passed');
