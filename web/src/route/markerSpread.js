/*
 * Marker fan-out for the Route Optimizer print map: markers that would
 * overlap are spread round their centre, and each fanned group is shifted
 * to stay inside the frame. Pure (no MapLibre), so it's unit-tested.
 */

/** Fan out markers that would overlap, keeping each fanned group inside
 *  the W x H frame. */
export function spreadMarkers(xy, W, H, r = 12) {
  const out = xy.map((p) => [...p]);
  const used = new Array(xy.length).fill(false);
  for (let i = 0; i < xy.length; i++) {
    if (used[i]) continue;
    const group = [];
    for (let j = i; j < xy.length; j++) {
      if (!used[j] && Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]) < 2 * r - 2) group.push(j);
    }
    group.forEach((j) => { used[j] = true; });
    if (group.length < 2) continue;
    const cx = group.reduce((s, j) => s + xy[j][0], 0) / group.length;
    const cy = group.reduce((s, j) => s + xy[j][1], 0) / group.length;
    const ring = (r * 1.15) / Math.sin(Math.PI / group.length);
    const fan = group.map((_, k) => {
      const a = -Math.PI / 2 + (2 * Math.PI * k) / group.length;
      return [cx + ring * Math.cos(a), cy + ring * Math.sin(a)];
    });
    const lo = r + 3;
    const xs = fan.map((p) => p[0]);
    const ys = fan.map((p) => p[1]);
    const dx = Math.max(lo - Math.min(...xs), 0) - Math.max(Math.max(...xs) - (W - lo), 0);
    const dy = Math.max(lo - Math.min(...ys), 0) - Math.max(Math.max(...ys) - (H - lo), 0);
    group.forEach((j, k) => { out[j] = [fan[k][0] + dx, fan[k][1] + dy]; });
  }
  return out;
}
