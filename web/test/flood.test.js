// Flood zones — stamp semantics, the palette's validity as a MapLibre
// expression, and agreement between lib/flood.js and the built overlay data.
//
// The third of those is the one that earns its keep. The overlay's geometry
// is produced by scripts/build-flood-overlay.js and styled by a `match` on
// the `code` property; if a zone is renamed in the module and the data is
// not rebuilt (or vice versa), nothing throws — the layer just quietly
// renders every feature in the fallback grey, which looks like a styling
// choice rather than a bug. These assertions make that a test failure.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import {
  FLOOD_ZONES,
  FLOOD_GROUPS,
  floodZone,
  floodColorStops,
  floodZoneEntries,
  floodCellText,
  floodCsvCells,
  floodSortRank,
  floodTooltip,
  floodColor,
  inFloodZone,
  primaryFloodZone,
} from '../src/lib/flood.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'flood');

// ---- Zone table shape ----------------------------------------------------
// Codes are the wire format: they are written into shards by r/build_flood.R
// and stamped into the overlay geometry at build time. A duplicate would
// make one of them unreachable through floodZone().
const codes = FLOOD_ZONES.map((z) => z.code);
assert.equal(new Set(codes).size, codes.length, 'duplicate zone code');
for (const z of FLOOD_ZONES) {
  assert.ok(z.label && z.short && z.kind && z.authority, `${z.code} is missing a descriptor`);
  assert.match(z.color, /^#[0-9a-f]{6}$/i, `${z.code} colour is not a hex triple`);
  assert.ok(FLOOD_GROUPS.some((g) => g.key === z.group), `${z.code} names no known group`);
}

// Every group owns at least one zone, and no zone belongs to two groups.
const grouped = FLOOD_GROUPS.flatMap((g) => g.zones.map((z) => z.code));
assert.equal(grouped.length, codes.length, 'a zone is in no group, or in two');
for (const g of FLOOD_GROUPS) {
  assert.ok(g.zones.length > 0, `${g.key} has no zones`);
  assert.ok(g.file.endsWith('.geojson'), `${g.key} file is not geojson`);
  assert.equal(g.source, `flood-${g.key}`);
  assert.equal(g.fill, `flood-${g.key}-fill`);
  assert.equal(g.line, `flood-${g.key}-line`);
  assert.ok(g.opacity > 0 && g.opacity < 1, `${g.key} opacity is out of range`);
}

// ---- Severity order ------------------------------------------------------
// The grid cell shows ONE headline, so the order decides which fact a reader
// sees. A parcel in both a DFA and the 1997 extent must lead with the DFA,
// because the statutory boundary is the one that governs what may be built.
const kindOrder = FLOOD_ZONES.map((z) => z.kind);
assert.equal(kindOrder[0], 'Statutory', 'statutory zones must sort first');
assert.ok(
  kindOrder.lastIndexOf('Statutory') < kindOrder.indexOf('Observed'),
  'every statutory zone must outrank every observed extent',
);
assert.equal(kindOrder[kindOrder.length - 1], 'Municipal by-law',
  'the Winnipeg setback is a riparian corridor, not a flood extent — it sorts last');

// The planning overlay ranks BELOW the observed extents, out of legal-force
// order and on purpose: the RRV SMA covers 73% of every parcel this column
// stamps, so as a headline it barely discriminates, and ranked above the
// extents it hid the better answer on 2,285 parcels. Regressing this would
// silently restore that — it changes no data, only which fact wins the cell.
assert.ok(
  kindOrder.indexOf('Observed') < kindOrder.indexOf('Planning overlay'),
  'the SMA must not outrank the observed extents — see the ordering note in lib/flood.js',
);
assert.ok(
  kindOrder.indexOf('Statistical') < kindOrder.indexOf('Planning overlay'),
  'the SMA must not outrank the 1-in-200 extent',
);
// The worked case: SMA at 100% must not beat a 60% 1-in-200 for the headline.
assert.equal(floodCellText({ z: { SMA: 100, F200: 60 } }), '1-in-200 60% +1');

// ---- Stamp reading -------------------------------------------------------
const both = { z: { FL1997: 100, RRVDFA: 62 } };
assert.equal(primaryFloodZone(both).code, 'RRVDFA', 'the stronger zone leads regardless of key order');
assert.equal(floodCellText(both), 'RRV DFA 62% +1');
assert.equal(floodColor(both), floodZone('RRVDFA').color);
assert.ok(inFloodZone(both));

// Wholly inside one zone: no percent, no count.
assert.equal(floodCellText({ z: { SMA: 100 } }), 'RRV SMA');
// Straddling: the coverage is the whole point — a quarter section 4% inside
// the DFA is not encumbered the way a lot wholly inside it is.
assert.equal(floodCellText({ z: { F200: 4 } }), '1-in-200 4%');

// An unknown code is dropped, not printed raw: a shard built by a newer
// r/build_flood.R than the deployed app must not leak "FL2022" into a
// client-facing cell.
assert.equal(floodCellText({ z: { FL2022: 100 } }), '');
assert.deepEqual(floodZoneEntries({ z: { FL2022: 100, SMA: 50 } }).map((e) => e.zone.code), ['SMA']);

// No stamp at all reads as empty, so callers can distinguish "outside every
// zone" from "shard never loaded" themselves.
assert.equal(floodCellText(null), '');
assert.equal(floodCellText({}), '');
assert.equal(inFloodZone(null), false);
assert.equal(floodTooltip(null), '');

// ---- Sorting -------------------------------------------------------------
// Severity dominates; coverage only breaks ties inside one zone.
const rankDfaFull = floodSortRank({ z: { RRVDFA: 100 } });
const rankDfaSliver = floodSortRank({ z: { RRVDFA: 3 } });
const rankObserved = floodSortRank({ z: { FL1997: 100 } });
assert.ok(rankDfaFull < rankDfaSliver, 'a fully-enclosed parcel sorts above a sliver');
assert.ok(rankDfaSliver < rankObserved, 'coverage must never reorder the zones themselves');
assert.ok(floodSortRank(null) >= FLOOD_ZONES.length, 'unstamped parcels sort last');

// ---- CSV: three states ---------------------------------------------------
// "We never checked" and "checked, outside every zone" cannot collapse into
// one another — this is a hazard column, and a confident "None" we have no
// evidence for is the worst thing it could print.
assert.deepEqual(floodCsvCells(null, false), ['', '', '', '']);
assert.deepEqual(floodCsvCells(null, true), ['None', '', '', '']);
assert.deepEqual(
  floodCsvCells({ z: { RRVDFA: 100, FL1997: 40 } }, true),
  [
    'Red River Valley Designated Flood Area',
    'Statutory',
    100,
    'Red River Valley Designated Flood Area; 1997 Red River Flood extent (40%)',
  ],
);

// ---- The palette is a valid MapLibre expression --------------------------
// floodColorStops() is spread into a `match` on the `code` property. A stray
// value would fail at style-load time in the browser, where the failure is a
// console warning and a blank layer; here it is a test failure.
const paint = ['match', ['get', 'code'], ...floodColorStops(), '#999999'];
const compiled = createExpression(paint, { type: 'color', 'property-type': 'data-driven' });
assert.equal(compiled.result, 'success', `flood colour expression rejected: ${JSON.stringify(compiled.value)}`);
for (const z of FLOOD_ZONES) {
  const got = compiled.value.evaluate({ zoom: 10 }, { properties: { code: z.code } });
  assert.equal(
    [got.r, got.g, got.b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join(''),
    z.color.slice(1).toLowerCase(),
    `${z.code} does not evaluate to its own colour`,
  );
}

// ---- The built overlay data agrees with the module -----------------------
// Skipped when the data has not been built — a fresh clone has not run
// `npm run flood:overlay` yet, and that should not fail the suite.
if (!existsSync(join(DATA_DIR, FLOOD_GROUPS[0].file))) {
  console.log('flood.test.js: overlay data not built — run `npm run flood:overlay`; geometry checks skipped');
} else {
  for (const g of FLOOD_GROUPS) {
    const path = join(DATA_DIR, g.file);
    assert.ok(existsSync(path), `${g.key}: ${g.file} is missing — rebuild the overlay data`);
    const fc = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(fc.features?.length > 0, `${g.key}: no features`);
    const own = new Set(g.zones.map((z) => z.code));
    const seen = new Set();
    for (const f of fc.features) {
      assert.ok(f.geometry, `${g.key}: a feature has no geometry`);
      assert.ok(own.has(f.properties?.code),
        `${g.key}: feature code ${JSON.stringify(f.properties?.code)} does not belong to this group`);
      seen.add(f.properties.code);
    }
    // Every zone the module claims for this group must actually be present:
    // a group that silently lost the Lower Red River DFA would still draw,
    // and the legend would still list it.
    for (const code of own) {
      assert.ok(seen.has(code), `${g.key}: no features carry zone ${code} — data is stale`);
    }
  }

  const meta = JSON.parse(readFileSync(join(DATA_DIR, '_meta.json'), 'utf8'));
  for (const g of FLOOD_GROUPS) {
    assert.ok(meta.groups?.[g.key], `_meta.json has no entry for ${g.key}`);
    assert.ok(meta.groups[g.key].sources?.length > 0, `${g.key}: no provenance recorded`);
  }
}

console.log('flood.test.js: all assertions passed');
