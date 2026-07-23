/*
 * Web Worker for the parcel↔overlay area join.
 *
 * The join is the single heaviest synchronous block in the app: on a
 * multi-municipality sales import it clips hundreds of parcels against
 * thousands of zoning and development-plan polygons, and enrichOverlays
 * runs it four times. On the main thread that freezes the tab outright —
 * the results table stops scrolling, the map stops panning, and the
 * far-flung tally cannot populate because it runs after enrichment.
 *
 * Tiling made that work ~4x cheaper; moving it here makes whatever
 * remains invisible. Total CPU is unchanged — this buys responsiveness,
 * not speed.
 *
 * The protocol is deliberately minimal:
 *   in  { id, parcels: [{oid, geometry}], overlays: [geometry], n }
 *   out { id, ok: true, result } | { id, ok: false, error }
 *
 * Only geometry crosses the boundary, never feature properties, and only
 * overlay INDICES come back — the main thread still holds the real
 * feature objects and re-attaches them. That keeps the round trip to a
 * few thousand small records rather than megabytes of cloned polygons.
 */

import { computeTopNMatches } from './lib/overlayJoinCore.js';

self.onmessage = (event) => {
  const { id, parcels, overlays, n } = event.data || {};
  try {
    // Rehydrate the minimal payload into the Feature shape turf expects.
    // OBJECTID is the only property the core reads.
    const parcelFeatures = (parcels || []).map((p) => ({
      type: 'Feature',
      properties: { OBJECTID: p.oid },
      geometry: p.geometry,
    }));
    const overlayFeatures = (overlays || []).map((g) => ({
      type: 'Feature',
      properties: {},
      geometry: g,
    }));
    const result = computeTopNMatches(parcelFeatures, overlayFeatures, n);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    // Never let the worker die silently — the caller needs to know to
    // fall back to the main thread rather than hang waiting.
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
