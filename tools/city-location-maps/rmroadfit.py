"""Refit one RM map PDF to the Manitoba Road Network 2023 (provincial
highways), for a sheet whose MLI DXF is not in UTM 14N. Written for R.M. of
Headingley (2026-11-20): its DXF runs x ~2.4e6, y ~2.2e7, so rmdxf.py's fit
put the RM ~20 km off the page and the Addenda Pack dropped the map. Result
for Headingley: median 5.4 m, scale 22.0 m/pt (scale bar 22.1), anisotropy
0.6%; checked by drawing the road network over the sheet.

    python -I rmroadfit.py <this folder> <workdir>

<workdir> must hold roads.geojson, fetched from
https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Manitoba_Road_Network_2023/FeatureServer/0/query
(envelope around the RM, outSR=4326, f=geojson). The seed (PTH 1 x PR 334,
its spot on the page, the scale bar) is Headingley's; edit it for another
sheet. Writes <workdir>/hfit.json; copy M into fits/rm-dxf/rm_<stem>.json
and re-apply the crop offset to the published index entry (build_area.py
build_rm: M[:, 2] -= crop origin, M[1, 2] += title band).
"""
import json, sys, os, math
import numpy as np, shapely, fitz
from shapely.geometry import shape, LineString
from shapely.ops import unary_union
from shapely.strtree import STRtree
here, S = sys.argv[1], sys.argv[2]
sys.path.insert(0, here)
from utm import utm14
from rmfit import to_utm, apply, aff_fit, sim_fit
R = json.load(open(os.path.join(S, 'roads.geojson')))['features']
names = sorted({f['properties']['RteName'] for f in R}); print(names)
def route(n):
    return unary_union([to_utm(shape(f['geometry'])) for f in R if f['properties']['RteType'] != '-RAMP' and f['properties']['RteName'].strip() == n])
from shapely.ops import nearest_points
r1, r334 = route('1_H'), route('334_H')
p = nearest_points(r1, r334)[0]; print('1x334', p, r1.distance(r334))
page = fitz.open(r'D:/Dropbox/Appraisal/Maps/$MunicipalMaps-2017/Headingley.pdf')[0]
segs = []
for d in page.get_drawings():
    col = d.get('color'); w = d.get('width') or 0
    if col is None or max(col) > 0.15 or w < 1.2: continue
    for it in d['items']:
        if it[0] == 'l': segs.append([(it[1].x, it[1].y), (it[2].x, it[2].y)])
        elif it[0] == 'c': segs.append([(it[1].x, it[1].y), (it[4].x, it[4].y)])
print('black thick segs', len(segs))
src = []
for a, b in segs:
    L = math.dist(a, b); n = max(1, int(L / 1.5))
    src += [(a[0] + (b[0]-a[0])*i/n, a[1] + (b[1]-a[1])*i/n) for i in range(n + 1)]
src = np.array(src)
src = src[(src[:,1] > 210) & (src[:,1] < 760) & (src[:,0] > 130)]   # drop legend / title
ref = [to_utm(shape(f['geometry'])) for f in R if f['properties']['RteType'] != '-RAMP']
lines = np.array([g for g in ref for g in (g.geoms if g.geom_type.startswith('Multi') else [g])], dtype=object)
tree = STRtree(lines)
E0, N0 = (p.x, p.y) if p.geom_type == 'Point' else (p.centroid.x, p.centroid.y)
s = 90.3 / 2000  # pt per metre from the scale bar
x0, y0 = 437*72/110, 612*72/110
M = np.array([[s, 0, x0 - s*E0], [0, -s, y0 + s*N0]])
for fit, r in [(sim_fit, r) for r in (800, 400, 200, 100, 50)] + [(aff_fit, 40), (aff_fit, 25)]:
    for it in range(40):
        Minv = np.linalg.inv(np.vstack([M, [0,0,1]]))[:2]
        U = apply(Minv, src); pts = shapely.points(U)
        ln = lines[tree.nearest(pts)]
        nr = shapely.get_coordinates(shapely.line_interpolate_point(ln, shapely.line_locate_point(ln, pts)))
        d = np.hypot(*(U - nr).T); k = d < r
        Mn = fit(src[k], nr[k])
        if np.abs(Mn - M).max() < 1e-9: M = Mn; break
        M = Mn
print('median m', round(float(np.median(d)),1), 'kept<25', round(float((d<25).mean()),3), 'm/pt', 1/math.sqrt(abs(np.linalg.det(M[:,:2]))), 'aniso', np.linalg.norm(M[:,0])/np.linalg.norm(M[:,1]))
print('1x334 page', apply(M, np.array([[E0, N0]])).round(1), 'drawn ~', (x0, y0))
json.dump({'M': M.tolist(), 'median_m': float(np.median(d)), 'kept': float((d<25).mean())}, open(os.path.join(S, 'hfit.json'), 'w'))
