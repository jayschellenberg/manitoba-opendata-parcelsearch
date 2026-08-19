// withheldGeometry.js — don't draw a boundary that isn't what sold.
//
// A comp's price is fixed at the sale date, but ROLL_ENTRY only ever serves
// the parcel as it stands TODAY. There is no historical parcel fabric to fall
// back on: mb-parcel-history holds two snapshot dates seventeen months apart,
// so for a parcel reconfigured after its sale the correct boundary does not
// exist in any dataset the app can reach. Drawing today's polygon there isn't
// an approximation of what sold — it is a different piece of land, and a
// confident-looking one.
//
// So where the sale's own evidence says the parcel changed (_geomTrust
// 'withheld', banded from change_signal in lib/saleSize.js), the polygon is
// replaced with its centroid and rendered as a pin. The pin still says "the
// sale was about here", which is true and useful, without asserting an extent
// that isn't.
//
// WHY REPLACE RATHER THAN HIDE. A polygon left in the source and merely styled
// invisible still answers queryRenderedFeatures, so hover and click would keep
// resolving against land that didn't sell — the user would get a tooltip
// anchored to the wrong extent with nothing on screen to explain it. Removing
// the geometry is the only version of "don't show it" that holds.
//
// WHY THE MAP FC AND NOT THE RESULT FC. The results table, the CSV export and
// the polygon-sampled overlays all still need the current parcel — it is the
// right answer to "what is there now", just not to "what sold". setMapData
// already builds the map's collection separately (dedupeParcelFeaturesForMap,
// then asOfHighlight), so this runs as one more pass in that chain and the
// result set is untouched. applyHistoricalGeometry in lib/historicalHighlight.js
// is the same shape, deliberately: swap per feature, stamp provenance, count
// what happened, never mutate the input.
//
// ORDER WITH THE AS-OF OVERLAY. This runs AFTER asOfHighlight. When the user
// has an as-of date on, that pass has already swapped in a real historical
// boundary for the snapshot date, which is a better answer than a pin — so a
// feature it swapped keeps its polygon and is skipped here. See withhold()'s
// _asOfGeom guard.
//
// Pure + dependency-free (the centroid function is injected), so it unit-tests
// without turf or the DOM.

/**
 * Replace the geometry of every withheld-boundary feature with its centroid.
 *
 * @param {object} fc  the map's feature collection
 * @param {{centroid: Function}} opts
 *   centroid(feature) → {lng, lat} | null
 * @returns {{fc: object, withheld: number, unplaceable: number}}
 *   `withheld`    features turned into pins.
 *   `unplaceable` features that should have been withheld but had no usable
 *                 geometry to derive a point from. They are passed through
 *                 untouched — there is nothing to draw either way — and
 *                 counted so a caller can say so rather than let the number
 *                 silently differ from what the grid reports.
 */
export function withholdChangedGeometry(fc, { centroid } = {}) {
  const features = fc?.features || [];
  const empty = {
    fc: fc || { type: 'FeatureCollection', features: [] },
    withheld: 0,
    unplaceable: 0,
  };
  if (!features.length || typeof centroid !== 'function') return empty;

  let withheld = 0;
  let unplaceable = 0;

  const out = features.map((f) => {
    if (!shouldWithhold(f)) return f;
    const pt = centroid(f);
    if (!pt || !Number.isFinite(pt.lng) || !Number.isFinite(pt.lat)) {
      unplaceable++;
      return f;
    }
    withheld++;
    return {
      ...f,
      geometry: { type: 'Point', coordinates: [pt.lng, pt.lat] },
      properties: { ...(f.properties || {}), _geomWithheld: true },
    };
  });

  if (withheld === 0) return { ...empty, unplaceable };
  return { fc: { ...fc, features: out }, withheld, unplaceable };
}

/**
 * Should this feature's boundary be withheld?
 *
 * Only on a positive 'withheld' verdict. 'unknown' — the pasted-comp-set path,
 * which carries no change signal at all — deliberately keeps its polygon: no
 * claim is being made about that row either way, and turning every pasted comp
 * into a pin would be a regression dressed as caution.
 */
function shouldWithhold(f) {
  const p = f?.properties;
  if (!p) return false;
  // An as-of boundary is a real historical extent for the snapshot date, which
  // beats a pin. Leave it alone — parcelHtml already labels it "Boundary as
  // of <date>" and warns that the attributes beside it are current.
  if (p._asOfGeom) return false;
  return p._geomTrust === 'withheld';
}

/**
 * Status-line note for what the withholding did, or '' when it did nothing.
 * Phrased as the reason, not the mechanism — "these parcels changed" is what
 * the user needs to act on; "geometry replaced with a point" is not.
 */
export function withheldNote(result) {
  if (!result?.withheld && !result?.unplaceable) return '';
  const parts = [];
  if (result.withheld) {
    parts.push(`${result.withheld} parcel${result.withheld === 1 ? '' : 's'}`
      + ` shown as a pin — ${result.withheld === 1 ? 'it' : 'they'} changed after the sale,`
      + ' so the current boundary is not what sold');
  }
  if (result.unplaceable) {
    parts.push(`${result.unplaceable} changed parcel${result.unplaceable === 1 ? '' : 's'}`
      + ' could not be placed on the map at all');
  }
  return parts.join('; ');
}
