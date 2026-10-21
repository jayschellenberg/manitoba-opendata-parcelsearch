// City location maps — the city pages of the 2026 Manitoba highway map
// (D:\Dropbox\Appraisal\Maps\Manitoba\Highways-2026\<city>.pdf) as extra
// base maps for lib/locationMap.js: same SUBJECT callout, pin and title
// box, "Subject Property Location within Brandon". The Addenda Pack adds
// one after the Manitoba map whenever the subject is inside that city's
// limits (Jason, 2026-10-21); the Province Location Map panel offers it
// whenever the subject is on the page.
//
// MB-only. locationMap.js and locationMapPanel.js are shared byte-identical
// with the Winnipeg app, so instead of editing them this module adds its
// maps to their BASE_MAPS table at start-up (registerCityMaps).
//
// Each page is UTM 14N under an affine fitted to OpenStreetMap roads —
// build and fitting recipe in tools/city-location-maps/README.md. Adding a
// city is that recipe plus its name in CITY_MAP_IDS.

import { BASE_MAPS, utm14 } from './locationMap.js';
import { CITY_MAP_DATA } from './cityMapData.js';

/** The cities with a map, in the order the panel lists them. */
export const CITY_MAP_IDS = ['brandon', 'steinbach', 'thompson'];

/** Output width the figures are rendered at, in pixels — about the
 *  Manitoba figure's 1467. */
const TARGET_PX = 1500;
/** The pages differ in size (Brandon 518 pt wide, Steinbach 272), but the
 *  callout, pin and title are sized in map units. Every city page is
 *  therefore measured in units that make it this wide — about the
 *  Manitoba page's 367 pt — so the SUBJECT box reads the same size in
 *  every figure once it is pasted at report width. */
const UNIT_WIDTH = 380;

function cityMap(id) {
  const d = CITY_MAP_DATA[id];
  const [a, b, c, e, f, g] = d.affine;
  const k = UNIT_WIDTH / d.width;
  return {
    id,
    label: d.label,
    muni: d.muni,
    svgUrl: `/city-${id}.svg`,
    width: UNIT_WIDTH,
    height: d.height * k,
    scale: TARGET_PX / UNIT_WIDTH,
    project(lng, lat) {
      const [E, N] = utm14(lng, lat);
      return [k * (a * E + b * N + c), k * (e * E + f * N + g)];
    },
    obstacles: d.obstacles.map((box) => box.map((v) => v * k)),
  };
}

export const CITY_MAPS = Object.fromEntries(
  CITY_MAP_IDS.filter((id) => CITY_MAP_DATA[id]).map((id) => [id, cityMap(id)]),
);

/** Make the city maps available to locationMap.js / locationMapPanel.js. */
export function registerCityMaps() {
  for (const [id, m] of Object.entries(CITY_MAPS)) {
    if (!BASE_MAPS[id]) BASE_MAPS[id] = m;
  }
}

/** The city map for a municipality name ("BRANDON (CITY)"), or null. */
export function cityMapForMuni(muniName) {
  const name = String(muniName || '').trim().toUpperCase();
  return Object.values(CITY_MAPS).find((m) => m.muni === name) || null;
}
