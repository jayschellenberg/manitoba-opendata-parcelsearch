"""Rebuild the Brandon and Portage la Prairie MLS areas on real street
centrelines, writing tools/mls-areas/brandon-portage.geojson, which
build_mls_areas.py lays over Jason's source file.

    python -I tools/mls-areas/rebuild_brandon_portage.py [<source geojson>]

Why: the source's Brandon and Portage polygons were hand-drawn rectangles
(Jason, 2026-10-23): "18th St" sat 240 m east of 18th Street, four Brandon
areas were 150 m circles, B06 swallowed four neighbourhoods, C15A did not
exist, and a quarter of Portage fell in no P area.

Brandon city (A01 ... D25, C15A) follows the Brandon Area REALTORS city map
(D:/Dropbox/Appraisal/Maps/$MLS Maps/Brandon-Area-Realtors-Brandon-City-Map-
with-MLS-Areas.pdf, Jan 2026). Its teal boundary bands are vector shapes; an
affine fit on 18th St, 1st St, Victoria Ave and Richmond Ave puts every band
within 2-20 m of an OpenStreetMap centreline, and each boundary below is that
street's OSM geometry. The few bands that follow no street (park land, the
river trail, two lot-line pockets) keep the band's own line, through BAR().

Brandon rural (ANW / BSW / CSE / DNE) keep the board's outer limit from the
source and are re-cut on the map inset's stated cutoffs: Hwy 10 east/west,
Hwy 1A + PR 455 between ANW and BSW, PR 457 between CSE and DNE. City land
outside the numbered areas stays with its rural quadrant, as before.

Portage (P01 ... P07) follows the board's written definitions (Portage MLS
Areas Defined.txt) checked against MLS search results per area (Jason's
screenshots): the city limit split by Tupper St / PR 240, Saskatchewan Ave and
the tracks; P01 is everything south of Crescent Road and west of Crescent Rd E
/ PR 240. R38's hole becomes the city limit.

OSM extracts are cached in tools/mls-areas/.cache/ (git-ignored); delete it
to re-download. City limits come from web/public/mb-municipalities.geojson.
"""
import json, os, sys, time, urllib.parse, urllib.request
import shapely
from shapely.geometry import shape, mapping, box, Point, Polygon, LineString
from shapely.ops import unary_union, linemerge, polygonize, polylabel

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
SRC = sys.argv[1] if len(sys.argv) > 1 else r'D:/Dropbox/Appraisal/RProjects/appraisal-templates/base-files/MLSAreas.geojson'
OUT = os.path.join(HERE, 'brandon-portage.geojson')
CACHE = os.path.join(HERE, '.cache')

QUERIES = {
    'brandon': '(way["highway"](49.79,-100.04,49.90,-99.88);way["railway"="rail"](49.79,-100.04,49.90,-99.88););',
    'portage': '(way["highway"](49.91,-98.40,50.03,-98.20);way["railway"="rail"](49.91,-98.40,50.03,-98.20););',
    'rural': '(way["highway"]["ref"~"^(PTH |PR )?(10|455|457|1A)$"](49.55,-100.55,50.20,-99.45););',
}


def osm(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name + '.json')
    if not os.path.exists(path):
        q = '[out:json][timeout:180];' + QUERIES[name] + 'out geom;'
        req = urllib.request.Request('https://overpass-api.de/api/interpreter',
                                     data=urllib.parse.urlencode({'data': q}).encode(),
                                     headers={'User-Agent': 'mb-parcelsearch-mls-areas/1.0'})
        with urllib.request.urlopen(req, timeout=300) as r:
            body = r.read()
        with open(path + '.tmp', 'wb') as fh:
            fh.write(body)
        os.replace(path + '.tmp', path)
        time.sleep(2)
    return [e for e in json.load(open(path, encoding='utf-8'))['elements'] if e['type'] == 'way' and 'geometry' in e]


def lines(els, pred):
    return unary_union([LineString([(g['lon'], g['lat']) for g in e['geometry']])
                        for e in els if pred(e.get('tags', {}))])


def named(els, *names):
    return lines(els, lambda t: t.get('name') in names)


def coords(geom):
    return [c for g in getattr(geom, 'geoms', [geom]) for c in g.coords]


def median(v):
    v = sorted(v)
    return v[len(v) // 2] if len(v) % 2 else (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2


def lon_of(geom, la0=-90, la1=90):
    return median([x for x, y in coords(geom) if la0 <= y <= la1])


def lat_of(geom, lo0=-180, lo1=180):
    return median([y for x, y in coords(geom) if lo0 <= x <= lo1])


def longest(geom):
    m = linemerge(geom) if geom.geom_type == 'MultiLineString' else geom
    return max(getattr(m, 'geoms', [m]), key=lambda l: l.length)


FAR = 1.0


def profile(pts, x0, x1, step=0.002, ymax=90):
    """A highway as one west-to-east line: the median latitude per 0.002 deg
    of longitude, so twinned carriageways and ramps cannot zigzag it."""
    bins = {}
    for x, y in pts:
        if x0 <= x <= x1 and y < ymax:
            bins.setdefault(round(x / step), []).append(y)
    return [(k * step, median(v)) for k, v in sorted(bins.items())]


def north_of(line):
    """Everything north of a west-to-east line, its ends run on east and west."""
    cs = list(line.coords) if line.coords[0][0] < line.coords[-1][0] else list(line.coords)[::-1]
    cs = [(cs[0][0] - FAR, cs[0][1])] + cs + [(cs[-1][0] + FAR, cs[-1][1])]
    return Polygon(cs + [(cs[-1][0], cs[-1][1] + FAR), (cs[0][0], cs[0][1] + FAR)]).buffer(0)


def west_of(line):
    """Everything west of a south-to-north line, its ends run on north and south."""
    cs = list(line.coords) if line.coords[0][1] < line.coords[-1][1] else list(line.coords)[::-1]
    cs = [(cs[0][0], cs[0][1] - FAR)] + cs + [(cs[-1][0], cs[-1][1] + FAR)]
    return Polygon(cs + [(cs[-1][0] - FAR, cs[-1][1]), (cs[0][0] - FAR, cs[0][1])]).buffer(0)


def polys(g):
    """Polygonal part only, dropping slivers under ~1 m wide."""
    g = g.buffer(0)
    parts = [p for p in getattr(g, 'geoms', [g]) if p.geom_type == 'Polygon' and p.area > 1e-9]
    parts = [p for p in parts if p.buffer(-1e-5).area > 0]
    return unary_union(parts)


MUNIS = json.load(open(os.path.join(ROOT, 'web', 'public', 'mb-municipalities.geojson')))['features']
def city(no):
    return [shape(f['geometry']) for f in MUNIS if f['properties']['MUNI_NO'] == no][0].buffer(0)


SOURCE = {f['properties']['MLSArea']: f for f in json.load(open(SRC))['features']}

# --------------------------------------------------------------- Brandon city
B = osm('brandon')
L42 = lon_of(named(B, '42nd Street')); L34 = lon_of(named(B, '34th Street'))
L26 = lon_of(named(B, '26th Street')); L18 = lon_of(named(B, '18th Street'))
L13 = lon_of(named(B, '13th Street')); L1 = lon_of(named(B, '1st Street North'))
L11E = lon_of(named(B, '11th Street East')); L17E = lon_of(named(B, '17th Street East'))
L6N = lon_of(named(B, '6th Street North')); L5N = lon_of(named(B, '5th Street North'))
VIC = lat_of(named(B, 'Victoria Avenue')); RICH = lat_of(named(B, 'Richmond Avenue'))
PARK = lat_of(named(B, 'Park Avenue'), L18, L1)
MARY_W = lat_of(named(B, 'Maryland Avenue'), L34, L26)
MARY_E = lat_of(named(B, 'Maryland Avenue'), L18, L1)
PAC_E = lat_of(named(B, 'Pacific Avenue'), L18, L1)
ROS_E = lat_of(named(B, 'Rosser Avenue East'))
# West of 18th the band runs down the lane behind the Pacific Ave lots.
LANE_W = (lat_of(named(B, 'Pacific Avenue'), L26, L18) + lat_of(named(B, 'Rosser Avenue'), L26, L18)) / 2
STICK = lat_of(named(B, 'Stickney Avenue')); MCDON = lat_of(named(B, 'McDonald Avenue'))
BRAE = lat_of(named(B, 'Braecrest Drive')); PATR = lat_of(named(B, 'Patricia Avenue'))
# North of the TCH the band follows the city limit along Matheson Ave, which
# OSM maps as the North Service Road.
NSR = lat_of(named(B, 'North Service Road'))
# South of Richmond Ave E the band runs behind the lots on Dennis ... Douglas
# St, whose OSM ends sit at 49.8256-49.8261.
CONGRESS = 49.8255

CN = longest(lines(B, lambda t: t.get('name') == 'Cromer Subdivision'))
CP = longest(lines(B, lambda t: t.get('name') == 'Broadview Subdivision'))
KIRK = longest(named(B, 'Kirkcaldy Drive'))
TCH = longest(named(B, 'Trans-Canada Highway'))

# The BAR map page (PDF points) -> lon/lat, fitted on 18th St (x 706.5),
# 1st St (972), Victoria (y 1045.5) and Richmond (1309.5).
AX = (-99.939054 + 99.961931) / (972 - 706.5); BX = -99.961931 - AX * 706.5
AY = (49.827469 - 49.842242) / (1309.5 - 1045.5); BY = 49.842242 - AY * 1045.5
def BAR(x, y):
    return (AX * x + BX, AY * y + BY)

BDN = city(500)
def bx(w, s, e, n): return box(w, s, e, n)

# A02's north edge: City Loop Trail and Canada Games Park Way round the
# Riverbank park land to 18th St N.
A02_N = [BAR(577, 822), BAR(616, 790), BAR(623, 775), BAR(646, 742), BAR(706.5, 745.5)]
# D23's north edge: the Riverbank Trail along the river, 18th St N to 6th St N.
D23_N = [BAR(706.5, 745.5), BAR(735, 745.5), BAR(771, 786), BAR(830, 800), BAR(859, 791), BAR(892.5, 804.5)]

C = {}
C['A01'] = ((bx(L34, BRAE, L18, NSR) - (north_of(TCH) & bx(L34 - 1, 0, BAR(625, 0)[0], 90)))
            | bx(BAR(620.5, 0)[0], BAR(0, 580.5)[1], L18, BRAE))          # + Braeview Place
C['D25'] = bx(L18, BRAE, L1, NSR)
C['D24'] = ((bx(L18, 0, L1, BRAE) & north_of(KIRK))
            | (bx(BAR(920, 0)[0], BAR(0, 679.5)[1], L1, 50) - north_of(KIRK)))  # + Kasiurak Bay
C['A02'] = Polygon([(L26, LANE_W), (L26, A02_N[0][1])] + A02_N[1:-1] + [(L18, A02_N[-1][1]), (L18, LANE_W)])
C['A04'] = Polygon([(L34, VIC), (L34, MCDON), (L26, A02_N[0][1]), (L26, VIC)])   # diagonal is park land
C['A03'] = (bx(L34 - 1, VIC, L34, 90) - north_of(CP)) & BDN
C['A05'] = bx(L26, VIC, L18, LANE_W) | bx(L18, VIC, L13, PAC_E)
C['D23'] = Polygon([(L18, PAC_E), (L18, D23_N[0][1])] + D23_N[1:-1]
                   + [(L6N, D23_N[-1][1]), (L6N, STICK), (L5N, STICK), (L5N, PAC_E)])
C['D21'] = bx(L13, VIC, L1, PAC_E)
C['D22'] = bx(L1, VIC, L11E, PAC_E) | bx(L11E, VIC, L17E, ROS_E)
C['C20'] = bx(L18, PARK, L1, VIC)
C['C19'] = bx(L1, PARK, L17E, VIC)
C['C17'] = bx(L18, RICH, L1, PARK)
C['C18'] = bx(L1, CONGRESS, L17E, PARK)
C['C16'] = bx(L18, MARY_E, L1, RICH)
C['C15'] = bx(L18, 0, L1, MARY_E) & BDN
C['C15A'] = bx(L1, 0, L17E, CONGRESS) & BDN
C['B06'] = bx(L26, 0, L18, VIC) & north_of(CN)
C['B07'] = bx(L34, 0, L26, VIC) & north_of(CN)
C['B09'] = bx(L42, 0, L34, VIC) & north_of(CN)
C['B10'] = bx(L42, RICH, L34, 90) - north_of(CN)
C['B11'] = bx(L34, RICH, L26, 90) - north_of(CN)
C['B12'] = bx(L26, RICH, L18, 90) - north_of(CN)
C['B08'] = bx(L42, PATR, L34, RICH)
C['B13'] = bx(L34, MARY_W, L26, RICH)
C['B14'] = (bx(L34, 0, L26, MARY_W) | bx(L26, 0, L18, RICH)) & BDN

# Label points: where the BAR map prints each code (PDF points).
BAR_LABEL = {
    'A01': (582, 377), 'D25': (829, 392), 'D24': (768, 592), 'D23': (799, 840), 'A02': (640, 898),
    'A04': (504, 944), 'A03': (332, 992), 'A05': (654, 998), 'D21': (834, 1003), 'D22': (1092, 976),
    'C20': (834, 1078), 'C19': (1073, 1073), 'B07': (512, 1087), 'B06': (643, 1120), 'B09': (351, 1137),
    'C18': (1123, 1206), 'C17': (854, 1248), 'B10': (379, 1248), 'B11': (540, 1242), 'B12': (643, 1246),
    'C16': (810, 1351), 'B13': (518, 1384), 'B08': (379, 1420), 'C15A': (1134, 1414), 'B14': (566, 1473),
    'C15': (843, 1481),
}

# ------------------------------------------------------------ Brandon rural
R = osm('rural')
board = unary_union([shape(f['geometry']).buffer(0) for k, f in SOURCE.items()
                     if k in ('ANW', 'BSW', 'CSE', 'DNE') or (len(k) == 3 and k[0] in 'ABCD' and k[1:].isdigit())])
CITY_AREAS = unary_union(list(C.values()))
s, n = board.bounds[1] - 0.01, board.bounds[3] + 0.01
w, e = board.bounds[0] - 0.01, board.bounds[2] + 0.01
# Hwy 10: 18th St from the south up to the TCH, east along it, then north.
TCH_LAT = 49.8890
HWY10 = LineString([(L18, s), (L18, TCH_LAT), (-99.9350, TCH_LAT), (-99.9350, n)])
# Hwy 1A west along Victoria Ave to the bend at Kemnay, then PR 455's line.
P455 = lat_of(lines(R, lambda t: t.get('ref') == 'PR 455'))
hw1a = profile(coords(lines(R, lambda t: t.get('ref') == 'PTH 1A')), -100.12, L18, ymax=49.845)
WEST = LineString([(w, P455), (-100.12, P455)] + hw1a + [(L18, VIC)])
# PR 457 east from Brandon; inside the city the C/D line is Victoria Ave E
# and 17th St E, as the numbered areas have it.
p457 = profile(coords(lines(R, lambda t: t.get('ref') == 'PR 457')), L17E + 0.002, e)
lat457_at_17 = p457[0][1]
EAST = LineString([(L18, VIC), (L17E, VIC), (L17E, lat457_at_17)] + p457 + [(e, p457[-1][1])])
rural = board - CITY_AREAS
westside = west_of(HWY10)
C['ANW'] = (rural & westside & north_of(WEST))
C['BSW'] = (rural & westside) - north_of(WEST)
C['DNE'] = (rural - westside) & north_of(EAST)
C['CSE'] = (rural - westside) - north_of(EAST)

# ------------------------------------------------------------------ Portage
PO = osm('portage')
PLP = city(550)
TUPPER = named(PO, 'Tupper Street North', 'Tupper Street South')
SASK = named(PO, 'Saskatchewan Avenue West', 'Saskatchewan Avenue East')
CRES = named(PO, 'Crescent Road West', 'Crescent Road East')
PR240 = lines(PO, lambda t: t.get('ref') in ('PR 240', '240'))
# "The tracks": west of Tupper the CN line along Fisher Ave (the P04 results
# stop there); east of Tupper the CP main line north of Trenton Ave (P06's
# results run up to it and east along 1A past Stephens Ave).
CNP = lines(PO, lambda t: t.get('name') == 'CN Rivers Subdivision' and t.get('usage') == 'main')
CPP = lines(PO, lambda t: t.get('name') == 'Carberry Subdivision')


def ext(geom, d=0.004):
    out = []
    m = linemerge(geom) if geom.geom_type == 'MultiLineString' else geom
    for p in getattr(m, 'geoms', [m]):
        c = list(p.coords)
        def push(a, b):
            dx, dy = a[0] - b[0], a[1] - b[1]; k = (dx * dx + dy * dy) ** .5 or 1
            return (a[0] + dx / k * d, a[1] + dy / k * d)
        out.append(LineString([push(c[0], c[1])] + c + [push(c[-1], c[-2])]))
    return unary_union(out)


def lat_on(geom, x):
    i = geom.intersection(LineString([(x, 49.8), (x, 50.1)]))
    ys = [p.y for p in getattr(i, 'geoms', [i]) if not i.is_empty and p.geom_type == 'Point']
    return min(ys) if ys else None


def lon_on(geom, y):
    i = geom.intersection(LineString([(-98.6, y), (-98.0, y)]))
    xs = [p.x for p in getattr(i, 'geoms', [i]) if not i.is_empty and p.geom_type == 'Point']
    return xs[0] if xs else None


edge = PLP.exterior if PLP.geom_type == 'Polygon' else unary_union([g.exterior for g in PLP.geoms])
faces = [f for f in polygonize(unary_union([ext(x) for x in (TUPPER, SASK, CNP, CPP, CRES, PR240)] + [edge]))
         if f.representative_point().within(PLP)]
P = {}
for f in faces:
    pt = f.representative_point(); x, y = pt.x, pt.y
    west = x < (lon_on(TUPPER, y) or -98.2908)
    tracks = lat_on(CNP if west else CPP, x)
    sk = lat_on(SASK, x)
    if tracks is not None and y > tracks:
        c = 'P05' if west else 'P07'
    elif sk is not None and y > sk:
        c = 'P04' if west else 'P06'
    else:
        cr, r = lat_on(CRES, x), lon_on(PR240, y)
        inside = (cr is None or y < cr) and (r is None or x < r) and f.bounds[1] < 49.955
        c = 'P01' if inside else ('P02' if west else 'P03')
    P.setdefault(c, []).append(f)
for k, fs in P.items():
    C[k] = unary_union(fs)
r38 = shape(SOURCE['R38']['geometry']).buffer(0)
C['R38'] = Polygon(r38.exterior, [h for h in r38.interiors if not Polygon(h).intersects(PLP)]) - PLP

# ------------------------------------------------------------------- output
def rnd(x):
    return [rnd(v) for v in x] if isinstance(x, (list, tuple)) else round(x, 6)


feats = []
for k in sorted(C):
    # Snap to the 6-decimal output grid here: rounding afterwards can fold a
    # near-degenerate corner into a self-crossing (D24 and DNE did, which
    # R's sf / s2 rejects).
    g = polys(shapely.set_precision(polys(C[k]), 1e-6))
    assert not g.is_empty and g.is_valid, k
    if k in BAR_LABEL:
        lx, ly = BAR(*BAR_LABEL[k])
    else:
        p = SOURCE.get(k, {}).get('properties', {})
        lx, ly = p.get('LogoLng'), p.get('LogoLat')
    if lx is None or not g.contains(Point(lx, ly)):
        lp = polylabel(max(getattr(g, 'geoms', [g]), key=lambda q: q.area), tolerance=1e-5)
        lx, ly = lp.x, lp.y
    m = mapping(g)
    feats.append({'type': 'Feature',
                  'properties': {'MLSArea': k, 'LogoLng': round(lx, 6), 'LogoLat': round(ly, 6)},
                  'geometry': {'type': m['type'], 'coordinates': rnd(m['coordinates'])}})

# Checks: Brandon and Portage areas must not overlap each other.
gs = {f['properties']['MLSArea']: shape(f['geometry']).buffer(0) for f in feats}
for i, a in enumerate(sorted(gs)):
    for b in sorted(gs)[i + 1:]:
        ov = gs[a].intersection(gs[b]).area * 111.32 ** 2 * 0.64 * 1e6
        assert ov < 50, f'{a} overlaps {b} by {ov:.0f} m2'
gap = (board - unary_union([gs[k] for k in gs if k in C and k not in P and k != 'R38'])).area * 111.32 ** 2 * 0.64 * 1e6
gapP = (PLP - unary_union([gs[k] for k in P])).area * 111.32 ** 2 * 0.64 * 1e6
print(f'Brandon board left uncovered: {gap:.0f} m2; Portage city left uncovered: {gapP:.0f} m2')
with open(OUT + '.tmp', 'w', encoding='utf-8', newline='\n') as fh:
    json.dump({'type': 'FeatureCollection', 'features': feats}, fh, separators=(',', ':'))
os.replace(OUT + '.tmp', OUT)
print(len(feats), 'areas ->', OUT, os.path.getsize(OUT) // 1024, 'KB')
