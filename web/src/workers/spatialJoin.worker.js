// Web Worker for the area-weighted spatial join (joinTopNByArea).
//
// Receives: { id, parcelFc, overlayFc, n }
// Returns:  { id, ok: true,  result: [[oid, matches[]], ...] }
//        or { id, ok: false, error: string }
//
// Internally builds an rbush index on the overlay bboxes so only
// overlays whose bounding boxes touch the parcel's bbox are passed to
// @turf/intersect — turning the O(P×O) check into O(P × log O + P×k)
// where k is the typical number of bbox candidates per parcel (usually
// single-digit for muni-scoped searches).
//
// The result is serialised as an Array so structured-clone can carry it
// back to the main thread; the main thread wraps it in new Map(result).

import area from '@turf/area';
import intersect from '@turf/intersect';
import RBush from 'rbush';

self.addEventListener('message', (ev) => {
  const { id, parcelFc, overlayFc, n } = ev.data;
  try {
    const map = joinTopNByArea(parcelFc, overlayFc, n);
    self.postMessage({ id, ok: true, result: [...map] });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});

// Compute axis-aligned bbox from a GeoJSON Polygon or MultiPolygon
// feature without importing @turf/bbox (keeps the worker bundle small).
function bboxOf(feature) {
  const geom = feature?.geometry;
  if (!geom) return null;
  const rings =
    geom.type === 'Polygon' ? geom.coordinates :
    geom.type === 'MultiPolygon' ? geom.coordinates.flat(1) : [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const pt of ring) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] > maxY) maxY = pt[1];
    }
  }
  return minX === Infinity ? null : [minX, minY, maxX, maxY];
}

function joinTopNByArea(parcelFc, overlayFc, n) {
  const result = new Map();
  if (!parcelFc.features.length || !overlayFc.features.length) return result;

  // Load all overlay bboxes into an rbush tree in one shot (bulk-load
  // is O(n log n) vs O(n log n) incremental, but with better constants).
  const tree = new RBush();
  const items = [];
  for (let i = 0; i < overlayFc.features.length; i++) {
    const b = bboxOf(overlayFc.features[i]);
    if (b) items.push({ minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], i });
  }
  tree.load(items);

  for (const parcel of parcelFc.features) {
    const oid = parcel.properties?.OBJECTID;
    if (oid == null) continue;

    const pb = bboxOf(parcel);
    if (!pb) continue;
    let parcelArea;
    try { parcelArea = area(parcel); } catch { continue; }
    if (!Number.isFinite(parcelArea) || parcelArea <= 0) continue;

    // rbush returns only overlays whose bbox overlaps the parcel's bbox.
    const candidates = tree.search({ minX: pb[0], minY: pb[1], maxX: pb[2], maxY: pb[3] });
    const matches = [];
    for (const { i } of candidates) {
      const overlay = overlayFc.features[i];
      let inter;
      try {
        inter = intersect({ type: 'FeatureCollection', features: [parcel, overlay] });
      } catch {
        // Topology errors on real-world data; skip.
        continue;
      }
      if (!inter) continue;
      let interArea;
      try { interArea = area(inter); } catch { continue; }
      if (!Number.isFinite(interArea) || interArea <= 0) continue;
      matches.push({ feature: overlay, ratio: Math.min(1, interArea / parcelArea) });
    }

    matches.sort((a, b) => b.ratio - a.ratio);
    if (matches.length > n) matches.length = n;
    result.set(oid, matches);
  }
  return result;
}
