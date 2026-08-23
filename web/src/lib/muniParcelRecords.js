// The Assessment Parcels popup resolver.
//
// The overlay's fabric is a vector-tile archive carrying only OBJECTID,
// Muni_Name_With_Typ and Roll_No_Txt (see TILE_POLYGON_PROPS in
// scripts/build-parcel-tiles.js — baking the rest produced a 1.07 GB
// archive, and the baked MAO report URL goes stale on every Spring/Fall
// rollover anyway). Everything else the popup shows is resolved here, by
// OBJECTID, the first time a parcel in a given municipality is clicked.
//
// This replaced a bulk pre-pass. Turning the layer on used to fetch the
// whole municipality's fabric and run the legal enrichment across all of
// it purely so a later click could be synchronous. Now nothing is fetched
// until a parcel is actually interrogated, and then it is one fetch per
// municipality for the session.
//
// Dependencies are injected rather than imported so this is testable
// without the network, the DOM, or main.js's module graph.

/** `muni|oid`, or null when either half is missing. */
export function recordKey(props) {
  const muni = props?.Muni_Name_With_Typ;
  const oid = props?.OBJECTID;
  return (muni && oid != null) ? `${muni}|${oid}` : null;
}

/**
 * @param {object} deps
 * @param {(muniName: string) => Promise<object>} deps.fetchFabric
 *        Fetch one municipality's parcel FeatureCollection. In the app this
 *        is arcgis.js's fetchAllParcelsInMunicipality, so it still honours
 *        snapshot mode and the sessionStorage cache.
 * @param {(fc: object) => Promise<void>} deps.enrichLegals
 *        Stamp legal-index records onto a freshly fetched FC.
 * @param {() => object|null} [deps.getLoadedFabric]
 *        The fabric an overlay has already loaded, if any. Preferred over
 *        fetching when it is for the same municipality: the land-cover and
 *        soil-composition passes mutate those feature properties in place,
 *        so reusing them is the only way `_lcColor` and `_soilComposition`
 *        reach the popup at all.
 * @param {(msg: string, err: unknown) => void} [deps.onWarn]
 */
export function createMuniParcelResolver({
  fetchFabric,
  enrichLegals,
  getLoadedFabric = () => null,
  onWarn = () => {},
}) {
  /** muni -> Promise<Map<String(OBJECTID), properties>> */
  const inFlight = new Map();
  /** `muni|oid` -> properties. Backs the synchronous peek. */
  const ready = new Map();

  function load(muniName) {
    if (inFlight.has(muniName)) return inFlight.get(muniName);
    const promise = (async () => {
      let fc = null;
      const loaded = getLoadedFabric();
      if (loaded?.features?.length
          && loaded.features[0]?.properties?.Muni_Name_With_Typ === muniName) {
        fc = loaded;
      } else {
        fc = await fetchFabric(muniName);
        try {
          await enrichLegals(fc);
        } catch (err) {
          // Non-fatal: a popup without the legal description still beats
          // no popup, and the legal index is a separate data source that
          // can be unavailable on its own.
          onWarn('Legal enrichment for the parcel popup failed', err);
        }
      }
      const byOid = new Map();
      for (const f of fc?.features || []) {
        const oid = f?.properties?.OBJECTID;
        if (oid != null) byOid.set(String(oid), f.properties);
      }
      for (const [oid, props] of byOid) ready.set(`${muniName}|${oid}`, props);
      return byOid;
    })();
    inFlight.set(muniName, promise);
    // A failed fetch must not poison the cache — the next click retries
    // rather than replaying the rejection forever.
    promise.catch(() => { inFlight.delete(muniName); });
    return promise;
  }

  return {
    /** Synchronous: whatever is already resolved, else null. The hover
     *  popup uses this and never waits, so hovering stays instant. */
    peek(props) {
      const key = recordKey(props);
      return key ? (ready.get(key) || null) : null;
    },
    /** Resolve this parcel's full properties, fetching its municipality
     *  once if needed. Null when the tile props are unusable or the
     *  OBJECTID isn't in the fabric. */
    async resolve(props) {
      const muni = props?.Muni_Name_With_Typ;
      const oid = props?.OBJECTID;
      if (!muni || oid == null) return null;
      const byOid = await load(muni);
      return byOid.get(String(oid)) || null;
    },
    /** Test seam. */
    _reset() { inFlight.clear(); ready.clear(); },
  };
}
