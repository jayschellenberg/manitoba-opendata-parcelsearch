// The Assessment Parcels popup resolver.
//
// The overlay's fabric is a vector-tile archive carrying only OBJECTID,
// Muni_Name_With_Typ and Roll_No_Txt (see TILE_POLYGON_PROPS in
// scripts/build-parcel-tiles.js — baking the rest produced a 1.07 GB
// archive, and the baked MAO report URL goes stale on every Spring/Fall
// rollover anyway). Everything else the popup shows is resolved here, by
// its ROLL NUMBER, the first time a parcel in a given municipality is
// clicked. (Not OBJECTID -- see recordKey below for why that failed.)
//
// This replaced a bulk pre-pass. Turning the layer on used to fetch the
// whole municipality's fabric and run the legal enrichment across all of
// it purely so a later click could be synchronous. Now nothing is fetched
// until a parcel is actually interrogated, and then it is one fetch per
// municipality for the session.
//
// Dependencies are injected rather than imported so this is testable
// without the network, the DOM, or main.js's module graph.

/** `muni|roll`, or null when either half is missing.
 *
 *  Keyed on the ROLL NUMBER, not OBJECTID. OBJECTID is an ArcGIS row id
 *  that is reissued whenever the province republishes the layer, so it
 *  does not survive from a tile archive built off one extract to the live
 *  FeatureServer serving another. Measured on GREY (RM) against the
 *  2026-08-11 archive: 62 of 62 rolls matched, and 0 of 62 OBJECTIDs did.
 *  Every popup lookup returned null.
 *
 *  arcgis.js already warned about this in another context ("OBJECTIDs
 *  don't survive a server republish", on the zone/dev-plan filter path).
 *  The roll number is the business key the rest of the app joins on. */
export function recordKey(props) {
  const muni = props?.Muni_Name_With_Typ;
  const roll = canonicalRoll(props?.Roll_No_Txt);
  return (muni && roll) ? `${muni}|${roll}` : null;
}

/** Roll numbers reach us as `124100.000` from both the tiles and the
 *  FeatureServer, but a stray sub-roll suffix or whitespace on either
 *  side would silently break the join, so normalise both ends. */
export function canonicalRoll(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  return s.endsWith('.000') ? s.slice(0, -4) : s;
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
  fetchZoningAt = null,
  getLoadedFabric = () => null,
  onWarn = () => {},
}) {
  /** muni -> Promise<Map<canonicalRoll, properties>> */
  const inFlight = new Map();
  /** `muni|roll` -> properties. Backs the synchronous peek. */
  const ready = new Map();
  /** `muni|roll` -> zoning properties, or null when the parcel genuinely
   *  has no zoning polygon over it. A resolved-to-null entry is a real
   *  answer and must be cached, so this uses has()/get() rather than a
   *  truthiness check — otherwise every hover over an unzoned rural
   *  parcel would refire the query. */
  const zoningReady = new Map();
  const zoningInFlight = new Map();

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
      const byRoll = new Map();
      for (const feat of fc?.features || []) {
        const roll = canonicalRoll(feat?.properties?.Roll_No_Txt);
        if (roll) byRoll.set(roll, feat.properties);
      }
      for (const [roll, props] of byRoll) ready.set(`${muniName}|${roll}`, props);
      return byRoll;
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
     *  roll isn't in the fabric. */
    async resolve(props) {
      const muni = props?.Muni_Name_With_Typ;
      const roll = canonicalRoll(props?.Roll_No_Txt);
      if (!muni || !roll) return null;
      const byRoll = await load(muni);
      return byRoll.get(roll) || null;
    },
    /** Synchronous: this parcel's zoning if already resolved, else null.
     *  The hover popup uses this and never fetches — hovering across a
     *  fabric would otherwise fire one spatial query per parcel crossed. */
    peekZoning(props) {
      const key = recordKey(props);
      return key && zoningReady.has(key) ? zoningReady.get(key) : null;
    },
    /**
     * Zoning for one parcel, fetched on demand.
     *
     * Only used when the zoning OVERLAY is off: when it is on, the popup
     * already reads the zone under the cursor straight off the rendered
     * layer for free (readOverlaysAt in map.js), and firing a query as
     * well would be pure waste.
     *
     * @param {object} props   the parcel's tile properties (for the key)
     * @param {object} feature the clicked feature, for its envelope
     * @param {[number, number]} lngLat where the user actually clicked
     */
    async resolveZoning(props, feature, lngLat) {
      const key = recordKey(props);
      if (!key || !fetchZoningAt) return null;
      if (zoningReady.has(key)) return zoningReady.get(key);
      if (zoningInFlight.has(key)) return zoningInFlight.get(key);
      const promise = (async () => {
        try {
          const zoning = await fetchZoningAt(feature, lngLat);
          zoningReady.set(key, zoning || null);
          return zoning || null;
        } catch (err) {
          // Non-fatal, and deliberately NOT cached: a transient failure
          // should not permanently mark this parcel as unzoned.
          onWarn('Zoning lookup for the parcel popup failed', err);
          return null;
        } finally {
          zoningInFlight.delete(key);
        }
      })();
      zoningInFlight.set(key, promise);
      return promise;
    },
    /** Test seam. */
    _reset() { inFlight.clear(); ready.clear(); zoningReady.clear(); zoningInFlight.clear(); },
  };
}
