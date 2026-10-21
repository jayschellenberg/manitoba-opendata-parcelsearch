"""Fit quality for a town plan: the share of assessment-parcel edge length
on the page that lands on drawn ink (within a few pixels). Residuals alone
cannot tell a wrong lock from a right one (Alonsa: 3.3 m wrong, 5.5 m
right); a wrong lock misses the dense lot pattern.
    python qa.py <workdir> <file> ...   -> prints file, ref_hit, n"""
import json, math, os, sys
import numpy as np, shapely
from PIL import Image, ImageFilter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import townfit, parcelref  # noqa: E402
from utm import utm14  # noqa: E402


def inv_utm(E, N):
    lon, lat = -98.0, 50.0
    for _ in range(25):
        e, n = utm14(lon, lat)
        lon += (E - e) / (111320 * math.cos(math.radians(lat))); lat += (N - n) / 110570
    return lon, lat


def ref_hit(work, fname, ref=None):
    r = json.load(open(os.path.join(work, f'town_{os.path.splitext(fname)[0]}.json')))
    if r.get('status') != 'ok':
        return None
    M = np.array(r['M'])
    gray = townfit.load_image(os.path.join(townfit.SRC, fname))
    H, W = gray.shape
    ink = Image.fromarray(((gray < 128) * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7))
    ink = np.array(ink) > 0
    Mi = np.linalg.inv(np.vstack([M, [0, 0, 1]]))[:2]
    corners = [Mi @ [x, y, 1] for x, y in ((0, 0), (W, 0), (0, H), (W, H))]
    ll = [inv_utm(*c) for c in corners]
    lons, lats = [p[0] for p in ll], [p[1] for p in ll]
    ref = ref or parcelref.load(work)
    rings = parcelref.rings_in(ref, min(lons), min(lats), max(lons), max(lats))
    # Lots only: long quarter-section lines match a wrong lock as well as a
    # right one (Alonsa scored 0.215 wrong vs 0.216 right on all edges).
    rings = [rg for rg in rings if (np.ptp(rg[:, 0]) * 71000 < 300 and np.ptp(rg[:, 1]) * 111000 < 300)]
    if not rings:
        return 0.0, 0
    lines = shapely.segmentize(np.array([shapely.linestrings([utm14(*p) for p in rg]) for rg in rings if len(rg) > 1], dtype=object), 3.0)
    P = shapely.get_coordinates(lines)
    px = (M @ np.c_[P, np.ones(len(P))].T).T
    ok = (px[:, 0] >= 0) & (px[:, 0] < W) & (px[:, 1] >= 0) & (px[:, 1] < H)
    px = px[ok].astype(int)
    if len(px) < 50:
        return 0.0, len(px)
    return float(ink[px[:, 1], px[:, 0]].mean()), len(px)


if __name__ == '__main__':
    work = sys.argv[1]
    ref = parcelref.load(work)
    for f in sys.argv[2:]:
        print(f, ref_hit(work, f, ref), flush=True)
