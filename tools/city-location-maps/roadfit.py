"""Georeference a highway-map city page: drawn roads vs OSM roads.
page = M @ [E, N, 1], E/N = UTM 14N metres.
Starts from namefit.py's seed (init_<city>.json), then a trimmed ICP
(similarity, then affine) on point-to-road distances. Writes fit_<city>.json.
    python -I roadfit.py <city>      (run in the work dir holding osm_/init_)"""
import json, math, os, sys
import fitz, numpy as np
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # utm.py beside this script
from utm import utm14  # noqa: E402

name = sys.argv[1]
page = fitz.open(f'D:/Dropbox/Appraisal/Maps/Manitoba/Highways-2026/{name}.pdf')[0]
R2 = lambda c: tuple(round(x, 2) for x in c) if c else None
DARK, RED = (0.14, 0.12, 0.13), (0.93, 0.11, 0.14)
classes = {}
for dr in page.get_drawings():
    if dr.get('type') != 's': continue
    key = (R2(dr.get('color')), round(dr.get('width') or 0, 2))
    if key[0] not in (DARK, RED) or key[1] < 0.5: continue
    for it in dr['items']:
        if it[0] == 'l': seg = [it[1], it[2]]
        elif it[0] == 'c': seg = [it[1], it[2], it[3], it[4]]
        else: continue
        classes.setdefault(key, []).append([(q.x, q.y) for q in seg])
src, cls = [], []
for k, segs in classes.items():
    for s in segs:
        ls = LineString(s)
        if ls.length == 0: continue
        for d in np.arange(0, ls.length + 1e-9, 1.5):
            src.append(ls.interpolate(d).coords[0]); cls.append(str(k))
src = np.array(src); cls = np.array(cls)
# Strokes run far past the page under clip paths (Flin Flon: 42k samples,
# most off the page); fit only what is visible.
_pr = page.rect
_vis = (src[:, 0] >= _pr.x0) & (src[:, 0] <= _pr.x1) & (src[:, 1] >= _pr.y0) & (src[:, 1] <= _pr.y1)
src, cls = src[_vis], cls[_vis]
print('page road classes', {str(k): len(v) for k, v in classes.items()}, 'samples', len(src))

ways = json.load(open(f'osm_{name}.json'))
lines = [LineString([utm14(*p) for p in w['pts']]) for w in ways if len(w['pts']) > 1]
tree = STRtree(lines)
# Start from namefit.py's street-name seed: a blind chamfer search over
# rotation and translation locks onto the wrong place on small towns (see
# README.md, Traps).
M = np.array(json.load(open(f'init_{name}.json'))['M'])

# --- Trimmed ICP --------------------------------------------------
def nearest(U):
    idx = tree.nearest([Point(u) for u in U])
    out = np.empty_like(U)
    for i, (u, j) in enumerate(zip(U, idx)):
        l = lines[j]; out[i] = l.interpolate(l.project(Point(u))).coords[0]
    return out
for mode in ('similarity', 'affine'):
    for it in range(40):
        Mi = np.linalg.inv(np.vstack([M, [0, 0, 1]]))[:2]
        U = (Mi @ np.c_[src, np.ones(len(src))].T).T
        near = nearest(U)
        d = np.hypot(*(U - near).T)
        thr = max(2.5 * np.median(d), 25) if it > 3 else 150
        keep = d < thr
        e, n = near[keep].T; x, y = src[keep].T
        if mode == 'similarity':
            Aa = np.zeros((2 * len(e), 4))
            Aa[:len(e)] = np.c_[e, n, np.ones_like(e), np.zeros_like(e)]
            Aa[len(e):] = np.c_[-n, e, np.zeros_like(e), np.ones_like(e)]
            p, q, c, f = np.linalg.lstsq(Aa, np.r_[x, y], rcond=None)[0]
            Mn = np.array([[p, q, c], [q, -p, f]])
        else:
            X = np.c_[e, n, np.ones_like(e)]
            Mn = np.vstack([np.linalg.lstsq(X, v, rcond=None)[0] for v in (x, y)])
        done = np.abs(Mn[:, :2] - M[:, :2]).max() < 1e-9 and np.abs(Mn[:, 2] - M[:, 2]).max() < 1e-4
        M = Mn
        if done: break
    mpp = 1 / math.sqrt(abs(np.linalg.det(M[:, :2])))
    print(f'{mode}: iters {it} kept {keep.sum()}/{len(keep)} median {np.median(d[keep]):.1f} m p90 {np.percentile(d[keep], 90):.1f} m  {mpp:.2f} m/pt '
          f'rot {math.degrees(math.atan2(-M[1, 0], M[0, 0])):.2f} aniso {np.linalg.norm(M[:, 0]) / np.linalg.norm(M[:, 1]):.4f}')
for k in sorted(set(cls)):
    s = cls == k
    print('  class', k, 'kept', round(keep[s].mean(), 2), 'median', round(float(np.median(d[s])), 1))
json.dump({'M': M.tolist(), 'median_m': float(np.median(d[keep])), 'kept': int(keep.sum()), 'n': len(keep)}, open(f'fit_{name}.json', 'w'))
