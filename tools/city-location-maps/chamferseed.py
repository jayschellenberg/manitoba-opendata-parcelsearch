"""Seed a city page's georeference by road pattern when namefit.py's street
labels are too few (Flin Flon, Niverville, Stonewall): FFT chamfer match of
the page's road strokes against OSM roads, with the scale pinned to the
47 pt/km scale bar and rotation searched only +-4 degrees around
north-up (or the page's own /Rotate). Writes init_<city>.json.
    python -I chamferseed.py <city> [<muni name>]   (work dir holds osm_<city>.json)
"""
import json, math, os, sys
import fitz, numpy as np
import shapely
from shapely.geometry import LineString
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # utm.py beside this script
from utm import utm14  # noqa: E402

name = sys.argv[1]
page = fitz.open(f'D:/Dropbox/Appraisal/Maps/Manitoba/Highways-2026/{name}.pdf')[0]
R2 = lambda c: tuple(round(x, 2) for x in c) if c else None
DARK, RED = (0.14, 0.12, 0.13), (0.93, 0.11, 0.14)
segs = []
for dr in page.get_drawings():
    if dr.get('type') != 's' or R2(dr.get('color')) not in (DARK, RED) or (dr.get('width') or 0) < 0.5:
        continue
    for it in dr['items']:
        if it[0] == 'l':
            segs.append([(it[1].x, it[1].y), (it[2].x, it[2].y)])
        elif it[0] == 'c':
            segs.append([(it[1].x, it[1].y), (it[4].x, it[4].y)])
src = shapely.get_coordinates(shapely.segmentize(np.array([LineString(s) for s in segs if s[0] != s[1]], dtype=object), 1.5))
# Strokes run far past the page under clip paths; keep what is visible.
pr = page.rect
src = src[(src[:, 0] >= pr.x0) & (src[:, 0] <= pr.x1) & (src[:, 1] >= pr.y0) & (src[:, 1] <= pr.y1)]
ways = json.load(open(f'osm_{name}.json'))
lines = np.array([LineString([utm14(*p) for p in w['pts']]) for w in ways if len(w['pts']) > 1], dtype=object)
ref = shapely.get_coordinates(shapely.segmentize(lines, 5.0))
X0, Y0 = ref.min(0); X1, Y1 = ref.max(0)
# Pad by the page's own extent in metres: a page can reach past the roads
# downloaded around the city (Flin Flon runs into Saskatchewan).
padm = float(np.ptp(src, axis=0).max()) * 1000 / 47.0
X0 -= padm; Y0 -= padm; X1 += padm; Y1 += padm
C = 10.0
W = int((X1 - X0) / C) + 1; H = int((Y1 - Y0) / C) + 1
occ = np.zeros((H, W), bool)
occ[((Y1 - ref[:, 1]) / C).astype(int), ((ref[:, 0] - X0) / C).astype(int)] = True
CAP = 10
dt = np.where(occ, 0.0, CAP)
for _ in range(CAP):
    m = dt.copy()
    m[1:] = np.minimum(m[1:], dt[:-1] + 1); m[:-1] = np.minimum(m[:-1], dt[1:] + 1)
    m[:, 1:] = np.minimum(m[:, 1:], dt[:, :-1] + 1); m[:, :-1] = np.minimum(m[:, :-1], dt[:, 1:] + 1)
    dt = m
F = np.fft.rfft2(dt)
s = 1000 / 47.0  # metres per point
cx, cy = src.mean(0)
base = -page.rotation  # content drawn turned by the page's /Rotate
best = None
for rot in np.arange(base - 4, base + 4.01, 0.5):
    r = math.radians(rot)
    dx, dy = src[:, 0] - cx, src[:, 1] - cy
    u = s * (dx * math.cos(r) + dy * math.sin(r)); v = s * (dx * math.sin(r) - dy * math.cos(r))
    umin, vmax = u.min(), v.max()
    ui = ((u - umin) / C).astype(int); vi = ((vmax - v) / C).astype(int)
    if ui.max() >= W or vi.max() >= H:
        continue
    P = np.zeros((H, W)); np.add.at(P, (vi, ui), 1)
    corr = np.fft.irfft2(F * np.conj(np.fft.rfft2(P)), s=P.shape)[: H - vi.max(), : W - ui.max()]
    k = np.unravel_index(np.argmin(corr), corr.shape)
    sc = corr[k] / len(src)
    if best is None or sc < best[0]:
        best = (sc, rot, k, umin, vmax)
sc, rot, (ky, kx), umin, vmax = best
r = math.radians(rot)
a, b = s * math.cos(r), s * math.sin(r)
Eo = X0 + kx * C - umin; No = Y1 - ky * C - vmax
Fwd = np.array([[a, b, Eo - a * cx - b * cy], [b, -a, No - b * cx + a * cy]])
M = np.linalg.inv(np.vstack([Fwd, [0, 0, 1]]))[:2]
print(f'chamfer seed rot {rot} mean cells {sc:.2f}')
json.dump({'M': M.tolist()}, open(f'init_{name}.json', 'w'))
