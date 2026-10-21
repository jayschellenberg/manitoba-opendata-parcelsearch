"""Seed a city page's georeference from its street labels: each label is
matched to the OSM way of the same name, and a rotation + offset is fitted
with the scale held at the scale bar (47 pt = 1 km). Writes init_<city>.json.
    python -I namefit.py <city>      (run in the work dir holding osm_<city>.json)
"""
import json, math, os, sys, re, collections
import fitz, numpy as np
from shapely.geometry import LineString, Point, MultiLineString
from shapely.ops import linemerge
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # utm.py beside this script
from utm import utm14  # noqa: E402
name = sys.argv[1]
page = fitz.open(f'D:/Dropbox/Appraisal/Maps/Manitoba/Highways-2026/{name}.pdf')[0]
STOP = {'dr', 'rd', 'st', 'ave', 'blvd', 'n', 's', 'e', 'w', 'road', 'street', 'avenue', 'drive', 'the', 'pr', 'pth', 'cres', 'way', 'bay', 'pl', 'hwy'}
def key(t):
    toks = [w for w in re.findall(r"[a-z0-9]+", t.lower()) if w not in STOP and not w.isdigit()]
    return ' '.join(toks)
labels = collections.defaultdict(list)
for b in page.get_text('dict')['blocks']:
    for l in b.get('lines', []):
        t = ''.join(s['text'] for s in l['spans']).strip()
        k = key(t)
        if len(k) >= 4:
            r = fitz.Rect(l['bbox']); labels[k].append(((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))
ways = json.load(open(f'osm_{name}.json'))
osm = collections.defaultdict(list)
for w in ways:
    if w.get('name'):
        osm[key(w['name'])].append(LineString([utm14(*p) for p in w['pts']]))
common = [k for k in labels if k in osm]
print('matched names', len(common), common)
geoms = {k: MultiLineString(v) for k, v in osm.items() if k in common}
P = []; G = []; K = []
for k in common:
    for p in labels[k]: P.append(p); K.append(k)
P = np.array(P)
# init: similarity from label positions to way centroids
Gc = np.array([geoms[k].centroid.coords[0] for k in K])
def simfit(src, dst, w=None):
    e, n = dst.T; x, y = src.T
    A = np.zeros((2 * len(e), 4)); A[:len(e)] = np.c_[e, n, np.ones_like(e), np.zeros_like(e)]; A[len(e):] = np.c_[-n, e, np.zeros_like(e), np.ones_like(e)]
    p, q, c, f = np.linalg.lstsq(A, np.r_[x, y], rcond=None)[0]
    # hold the scale at the scale bar's 47 pt/km; keep the fitted rotation
    k = (47 / 1000) / math.hypot(p, q); p, q = p * k, q * k
    c = np.mean(x - p * e - q * n); f = np.mean(y - q * e + p * n)
    return np.array([[p, q, c], [q, -p, f]])
best=None
for rot in range(-180,180,5):
    r=math.radians(rot); p0=47/1000*math.cos(r); q0=-47/1000*math.sin(r)
    M=np.array([[p0,q0,0],[q0,-p0,0]]); 
    U0=(M[:,:2]@Gc.T).T; M[:,2]=np.mean(P-U0,0)
    for it in range(15):
        Mi=np.linalg.inv(np.vstack([M,[0,0,1]]))[:2]
        U=(Mi@np.c_[P,np.ones(len(P))].T).T
        near=np.array([geoms[k].interpolate(geoms[k].project(Point(u))).coords[0] for k,u in zip(K,U)])
        M=simfit(P,near)
    d=np.hypot(*(U-near).T); sc=np.median(d)
    if best is None or sc<best[0]: best=(sc,M,rot)
print('seed rot',best[2],'median',round(best[0]))
M=best[1]
for it in range(50):
    Mi = np.linalg.inv(np.vstack([M, [0, 0, 1]]))[:2]
    U = (Mi @ np.c_[P, np.ones(len(P))].T).T
    near = np.array([geoms[k].interpolate(geoms[k].project(Point(u))).coords[0] for k, u in zip(K, U)])
    d = np.hypot(*(U - near).T)
    keep = d < max(3 * np.median(d), 60) if it > 5 else np.ones(len(d), bool)
    M = simfit(P[keep], near[keep])
mpp = 1 / math.sqrt(abs(np.linalg.det(M[:, :2])))
print(f'labels {len(P)} kept {keep.sum()} median {np.median(d):.0f} m  {mpp:.2f} m/pt rot {math.degrees(math.atan2(-M[1,0], M[0,0])):.1f}')
for k, dd, kk in zip(K, d, keep):
    if not kk: print('  dropped', k, round(dd))
json.dump({'M': M.tolist()}, open(f'init_{name}.json', 'w'))
