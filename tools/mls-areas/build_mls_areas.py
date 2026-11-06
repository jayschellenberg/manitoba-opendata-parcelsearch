"""Build web/public/mls-areas.geojson for the MLS Areas overlay (both apps).

    python -I tools/mls-areas/build_mls_areas.py [<source geojson>]

Source: Jason's MLSAreas.geojson in appraisal-templates/base-files (141
areas). Its 104 Winnipeg-board areas were byte-checked against the live
WRREB digital map (map.keystonerealtors.ca, 2026-10-21) and match exactly;
it adds Brandon's A-D areas, Portage's P01-P07 and R38, which that map
does not serve.

The source's Brandon and Portage shapes were hand-drawn rectangles; they,
and R38 (whose hole is Portage), are replaced by brandon-portage.geojson from
rebuild_brandon_portage.py, which also adds C15A (Prairie Crossing): 142 areas.

Writes one FeatureCollection of polygons, largest first (so the smaller,
nested areas draw and hit-test on top), each with:
    area   the MLS area code ("1A", "R26", "B07", "P03")
    board  which board's area system it belongs to
    lx/ly  the label point: the boards' own (LogoLng/LogoLat) where it sits
           well inside the area, otherwise an interior point of our own
           (see label_point; R14/R15 hug the river edge, 2026-11-06)
Self-intersecting rings (R14, R31, R41 in the source) are repaired.
Copy the output to the Winnipeg app's web/public/ as well.
"""
import json, math, os, re, sys
from shapely.affinity import scale
from shapely.geometry import shape, mapping, Point
from shapely.validation import make_valid
from shapely.ops import polylabel, unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else r'D:/Dropbox/Appraisal/RProjects/appraisal-templates/base-files/MLSAreas.geojson'
OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'web', 'public', 'mls-areas.geojson'))
REBUILT = os.path.join(HERE, 'brandon-portage.geojson')


def board(code):
    if re.fullmatch(r'[A-D]\d\dA?|ANW|BSW|CSE|DNE', code):
        return 'Brandon Area REALTORS'
    if re.fullmatch(r'P\d\d', code):
        return 'Portage la Prairie Real Estate Board'
    return 'Winnipeg Regional Real Estate Board'


# A board point is kept when its clearance from the boundary is at least this
# share of the clearance the best interior point (pole of inaccessibility)
# has. Below it the label reads as sitting on the edge (R15 was 5%, R14 8%).
KEEP_RATIO = 0.35
# A replacement prefers the centroid, which reads as "the middle", when the
# centroid is inside and has at least this share of the best clearance
# (long areas like R05 and R43); otherwise the pole of inaccessibility.
CENTROID_RATIO = 0.5


def label_point(g, lx, ly):
    """Return (lng, lat) for the label of polygon/multipolygon `g`."""
    k = math.cos(math.radians(g.centroid.y))          # degrees -> near-metric
    gs = scale(g, xfact=k, yfact=1, origin=(0, 0))
    poly = gs if gs.geom_type == 'Polygon' else max(gs.geoms, key=lambda q: q.area)
    best = polylabel(poly, tolerance=1e-5)
    best_clr = gs.boundary.distance(best)
    pt = Point(lx * k, ly)
    if gs.contains(pt) and gs.boundary.distance(pt) >= KEEP_RATIO * best_clr:
        return lx, ly
    c = gs.centroid
    if gs.contains(c) and gs.boundary.distance(c) >= CENTROID_RATIO * best_clr:
        return c.x / k, c.y
    return best.x / k, best.y


def rnd(x):
    if isinstance(x, (list, tuple)):
        return [rnd(v) for v in x]
    return round(x, 6)


rebuilt = json.load(open(REBUILT))['features']
done = {f['properties']['MLSArea'] for f in rebuilt}
feats = []
for f in [f for f in json.load(open(SRC))['features'] if f['properties']['MLSArea'] not in done] + rebuilt:
    p = f['properties']
    g = shape(f['geometry'])
    if not g.is_valid:
        g = make_valid(g)
        if g.geom_type == 'GeometryCollection':   # keep the polygonal parts only
            g = unary_union([q for q in g.geoms if q.area > 0])
    m = mapping(g)
    lx, ly = label_point(g, p['LogoLng'], p['LogoLat'])
    if (lx, ly) != (p['LogoLng'], p['LogoLat']):
        print('  label moved:', p['MLSArea'])
    feats.append((g.area, {
        'type': 'Feature',
        'properties': {'area': p['MLSArea'], 'board': board(p['MLSArea']),
                       'lx': round(lx, 6), 'ly': round(ly, 6)},
        'geometry': {'type': m['type'], 'coordinates': rnd(m['coordinates'])},
    }))
feats.sort(key=lambda t: -t[0])
fc = {'type': 'FeatureCollection', 'features': [f for _, f in feats]}
with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(fc, fh, separators=(',', ':'))
print(len(fc['features']), 'areas ->', OUT, os.path.getsize(OUT) // 1024, 'KB')
