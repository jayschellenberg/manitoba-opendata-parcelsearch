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
    lx/ly  the label point the boards themselves use (LogoLng/LogoLat)
Self-intersecting rings (R14, R31, R41, R43 in the source) are repaired.
Copy the output to the Winnipeg app's web/public/ as well.
"""
import json, os, re, sys
from shapely.geometry import shape, mapping
from shapely.validation import make_valid
from shapely.ops import unary_union

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
    feats.append((g.area, {
        'type': 'Feature',
        'properties': {'area': p['MLSArea'], 'board': board(p['MLSArea']),
                       'lx': round(p['LogoLng'], 6), 'ly': round(p['LogoLat'], 6)},
        'geometry': {'type': m['type'], 'coordinates': rnd(m['coordinates'])},
    }))
feats.sort(key=lambda t: -t[0])
fc = {'type': 'FeatureCollection', 'features': [f for _, f in feats]}
with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(fc, fh, separators=(',', ':'))
print(len(fc['features']), 'areas ->', OUT, os.path.getsize(OUT) // 1024, 'KB')
