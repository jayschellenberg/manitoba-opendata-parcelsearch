"""Fit a town sheet of the 2017 municipal series ($MunicipalMaps-2017) that
has neither a section grid nor an MLI DXF, so rmfit.py and rmdxf.py both
fail on it. Written for Virden_S2 (Town of Virden, 2026-11-20): trimmed ICP
of the page's dark linework against the assessment-parcel edges, seeded at
the SW corner of 22-10-26W (Thomas Dr x PR 257) with the printed scale bar.
Result: median 0.2 m, 81% of points within 5 m, anisotropy 0.03%, rotation
1.4 degrees; the printed bar reads ~6% off the fitted scale.

    python -I townparcelfit.py <this folder> <workdir>

<workdir> must hold parcels.geojson: the ROLL_ENTRY FeatureServer
(web/src/arcgis.js) queried with an envelope round the town, outSR=4326,
f=geojson. Writes <workdir>/rm_Virden_S2.json (copied to fits/rm-dxf/) and
virden-check.png, the parcels drawn over the sheet. The seed section, its
page position and the clip boxes are Virden's; edit them for another sheet.
"""
import json, sys, os, math
import numpy as np, shapely, fitz
from shapely.geometry import shape, LineString
from shapely.strtree import STRtree
here, work = sys.argv[1], sys.argv[2]
sys.path.insert(0, here)
from utm import utm14
from rmfit import to_utm, apply, aff_fit, sim_fit, inv
WEB = os.path.join(here, '..', '..', 'web')
grid = json.load(open(os.path.join(WEB, 'public', 'data', 'section-grid.json')))['features']
s22 = next(f for f in grid if f['properties']['label'] == '22-10-26W')
g = to_utm(shape(s22['geometry'])); x0, y0, x1, y1 = g.bounds
print('sec22 utm', [round(v) for v in g.bounds])
F = json.load(open(os.path.join(work, 'parcels.geojson')))['features']
L = []
for f in F:
    gg = to_utm(shape(f['geometry']))
    for poly in (gg.geoms if gg.geom_type == 'MultiPolygon' else [gg]):
        L.append(poly.exterior)
        L += list(poly.interiors)
print('parcel rings', len(L))
lines = np.array(L, dtype=object); tree = STRtree(lines)
page = fitz.open(r'D:/Dropbox/Appraisal/Maps/$MunicipalMaps-2017/Virden_S2.pdf')[0]
segs = []
for d in page.get_drawings():
    col = d.get('color')
    if col is None or max(col) > 0.3: continue
    for it in d['items']:
        if it[0] == 'l': segs.append((it[1], it[2]))
        elif it[0] == 'c': segs.append((it[1], it[4]))
        elif it[0] == 're': r = it[1]; segs += [(r.tl, r.tr), (r.tr, r.br), (r.br, r.bl), (r.bl, r.tl)]
src = []
for a, b in segs:
    Ln = math.dist(a, b); n = max(1, int(Ln / 1.5))
    src += [(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n) for i in range(n + 1)]
src = np.array(src)
src = src[(src[:, 1] > 216) & (src[:, 1] < 755) & (src[:, 0] > 50) & (src[:, 0] < 560)]
src = src[~((src[:, 0] > 505) & (src[:, 1] < 260))]   # the G.I.A. note
print('page pts', len(src))
s = (283 - 168) * 72 / 110 / 300   # pt per metre from the 0-300 m bar
px, py = 250 * 72 / 110, 997 * 72 / 110   # SW corner of sec 22 on the page
M = np.array([[s, 0, px - s * x0], [0, -s, py + s * y0]])
sub = src[:: max(1, len(src) // 6000)]
for fit, r in [(sim_fit, r) for r in (150, 80, 40, 20, 10)] + [(aff_fit, 8), (aff_fit, 5)]:
    for it in range(40):
        U = apply(inv(M), sub); pts = shapely.points(U)
        ln = lines[tree.nearest(pts)]
        nr = shapely.get_coordinates(shapely.line_interpolate_point(ln, shapely.line_locate_point(ln, pts)))
        d = np.hypot(*(U - nr).T); k = d < r
        Mn = fit(sub[k], nr[k])
        if np.abs(Mn - M).max() < 1e-10: M = Mn; break
        M = Mn
det = abs(np.linalg.det(M[:, :2]))
print('median', round(float(np.median(d)), 2), 'kept<5', round(float((d < 5).mean()), 3), 'm/pt', round(1 / math.sqrt(det), 3), 'bar m/pt', round(1 / s, 3),
      'aniso', round(float(np.linalg.norm(M[:, 0]) / np.linalg.norm(M[:, 1])), 4), 'rot', round(math.degrees(math.atan2(-M[1, 0], M[0, 0])), 2))
json.dump({'stem': 'Virden_S2', 'method': 'parcels', 'muni': 'VIRDEN (TOWN)', 'median_m': round(float(np.median(d)), 1),
           'kept': round(float((d < 5).mean()), 3), 'm_per_pt': round(1 / math.sqrt(det), 2), 'M': M.tolist(), 'status': 'ok',
           'note': 'No section grid or MLI DXF for this town sheet. Fitted 2026-11-20 by trimmed ICP of the page linework against the assessment-parcel edges, seeded at the SW corner of 22-10-26W with the scale bar; checked by overlay.'},
          open(os.path.join(work, 'rm_Virden_S2.json'), 'w'))
# overlay check
for r in L:
    P = apply(M, np.array(r.coords))
    if ((P[:, 0] > 0) & (P[:, 0] < 612) & (P[:, 1] > 0) & (P[:, 1] < 792)).any():
        page.draw_polyline([fitz.Point(*p) for p in P], color=(1, 0, 0), width=0.3)
page.get_pixmap(dpi=110).save(os.path.join(work, 'virden-check.png'))
page.get_pixmap(dpi=300, clip=fitz.Rect(300, 380, 420, 480)).save(os.path.join(work, 'virden-zoom.png'))
