// Locator pins for a result of one or more parcels: one pin per cluster of
// parcels that sit together, so a two-lot subject at municipality zoom shows
// one red pin rather than two specks of yellow (Jason, 2026-11-20, RM of
// Headingley rolls 6199 + 6201). Parcels whose bounding boxes come within
// `gapM` metres of each other share a pin; the pin stands at the middle of
// the cluster's combined box, the same bbox-midpoint convention as
// parcelCentrePoint for a single parcel.

import { geometryBbox } from './geometryText.js';

/** Default join distance. Wide enough to bridge a road allowance between
 *  two lots of one property, narrow enough that comps across town keep
 *  their own pins. */
export const PIN_CLUSTER_GAP_M = 250;

const M_PER_DEG_LAT = 111320;

/** Gap in metres between two [minX, minY, maxX, maxY] boxes (0 if they touch). */
function boxGapM(a, b) {
  const lat = ((a[1] + a[3] + b[1] + b[3]) / 4) * (Math.PI / 180);
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]) * M_PER_DEG_LAT * Math.cos(lat);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/**
 * Cluster `features` (GeoJSON) into pin points: [{ lng, lat, count }], one
 * per group. Features without usable geometry are skipped; an empty input
 * gives [].
 */
export function clusterPinPoints(features, { gapM = PIN_CLUSTER_GAP_M } = {}) {
  const boxes = (features || []).map((f) => geometryBbox(f?.geometry)).filter(Boolean);
  const n = boxes.length;
  const parent = boxes.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (boxGapM(boxes[i], boxes[j]) <= gapM) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    const b = boxes[i];
    if (!g) groups.set(r, { box: [...b], count: 1 });
    else {
      g.box = [Math.min(g.box[0], b[0]), Math.min(g.box[1], b[1]), Math.max(g.box[2], b[2]), Math.max(g.box[3], b[3])];
      g.count += 1;
    }
  }
  return [...groups.values()].map(({ box, count }) => ({
    lng: (box[0] + box[2]) / 2, lat: (box[1] + box[3]) / 2, count,
  }));
}
