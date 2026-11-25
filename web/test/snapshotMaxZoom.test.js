// Aerial Pack (parcel snapshots) zoom cap. Framed at z20, small town lots came
// out blank: the esri-imagery layer is hidden from its maxzoom (20) up, and
// Esri serves grey "Map data not yet available" tiles at z20 outside the big
// cities (Stonewall, 2026-11-25). The cap has to stay below both.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');

const exportSrc = read('src/snapshotExport.js');
const mapSrc = read('src/map.js');

const cap = Number(exportSrc.match(/export const EXPORT_MAX_ZOOM = (\d+(?:\.\d+)?);/)?.[1]);
assert.ok(Number.isFinite(cap), 'EXPORT_MAX_ZOOM not found');
const layerMax = Number(mapSrc.match(/id: 'esri-imagery',[^}]*maxzoom: (\d+)/)?.[1]);
assert.ok(Number.isFinite(layerMax), 'esri-imagery layer maxzoom not found');

assert.ok(cap < layerMax, `EXPORT_MAX_ZOOM ${cap} must stay below the esri-imagery layer maxzoom ${layerMax}, or the photo is blank`);
// The source must not fetch past z19: with 256 px tiles on MapLibre's 512 px
// grid a z19 camera asks for z20 tiles, which are placeholders in the towns.
const srcBlock = mapSrc.slice(mapSrc.indexOf("'esri-imagery': {"), mapSrc.indexOf("'esri-imagery': {") + 900);
const srcMax = Number(srcBlock.match(/maxzoom: (\d+)/)?.[1]);
assert.ok(Number.isFinite(srcMax) && srcMax <= 19, `esri-imagery source maxzoom must be set and at most 19 (got ${srcMax})`);
console.log('snapshotMaxZoom.test.js: 2 passed');
