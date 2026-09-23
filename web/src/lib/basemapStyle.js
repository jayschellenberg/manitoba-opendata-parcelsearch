/*
 * The streets basemap as a standalone MapLibre style, for maps outside the
 * main app (the Sales Charts page). It is the same Manitoba Protomaps cut,
 * glyph endpoint, sprite and font remap that map.js builds for the main map;
 * map.js keeps its own copy because its style carries a dozen more sources
 * (imagery, Wayback, ortho) this page has no use for.
 *
 * The two copies are held together by tests, not by hope:
 *   - fontStacks.test.js scans this file as well as map.js, so the
 *     "Noto Sans Medium" rewrite and the glyph endpoint are checked here too;
 *   - basemapStyle.test.js asserts both files name the same PMTiles URL.
 */

import { layers as protomapsLayers, namedFlavor } from '@protomaps/basemaps';

export const BASEMAP_PMTILES_URL =
  import.meta.env?.VITE_BASEMAP_PMTILES_URL
  || 'https://pub-091058079bf6458da1681945177e1682.r2.dev/basemap-manitoba.pmtiles';

/**
 * A fresh style object: the "light" Protomaps layers, ids prefixed `pm-`,
 * with "Noto Sans Medium" remapped to the one stack demotiles serves (a
 * missing stack silently drops every label that uses it).
 */
export function streetsStyle() {
  const layers = protomapsLayers('protomaps', namedFlavor('light'), { lang: 'en' })
    .map((layer) => {
      const remapped = JSON.parse(
        JSON.stringify(layer).replaceAll('"Noto Sans Medium"', '"Open Sans Semibold"'),
      );
      return { ...remapped, id: `pm-${layer.id}` };
    });
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sprite: `${window.location.origin}/basemap-sprites/light`,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${BASEMAP_PMTILES_URL}`,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers,
  };
}
