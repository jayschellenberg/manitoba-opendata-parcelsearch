import json, sys, os, re
import fitz, numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, r'D:/Dropbox/ClaudeCode/MBOpenData/mb-parcelsearch/tools/city-location-maps')
from utm import utm14
from shapely.geometry import shape
work, stem = sys.argv[1], sys.argv[2]
r = json.load(open(f'{work}/rm_{stem}.json')); M = np.array(r['M'])
dpi = 110; k = dpi / 72
page = fitz.open(f'D:/Dropbox/Appraisal/Maps/$MunicipalMaps-2017/{stem}.pdf')[0]
pix = page.get_pixmap(dpi=dpi)
im = Image.frombytes('RGB', (pix.width, pix.height), pix.samples); d = ImageDraw.Draw(im)
W = r'D:/Dropbox/ClaudeCode/MBOpenData/mb-parcelsearch/web/public/'
g = json.load(open(W + 'mb-municipalities.geojson'))['features']
f = next(f for f in g if f['properties']['MUNI_LIST_NAME_WITH_TYPE'] == r['muni'])
geom = shape(f['geometry'])
for poly in getattr(geom, 'geoms', [geom]):
    P = [tuple(k * (M @ [*utm14(*p), 1])) for p in poly.exterior.coords]
    d.line(P, fill=(255, 0, 0), width=3)
pl = json.load(open(W + 'mb-places.json')); fl = pl['fields']
x0, y0, x1, y1 = geom.bounds
for row in pl['rows']:
    lat, lon = row[fl.index('lat')], row[fl.index('lon')]
    if x0 - .1 < lon < x1 + .1 and y0 - .1 < lat < y1 + .1 and row[fl.index('type')] in ('TOWN', 'VILG', 'HAM', 'UNP', 'CITY'):
        x, y = k * (M @ [*utm14(lon, lat), 1])
        d.ellipse([x - 5, y - 5, x + 5, y + 5], outline=(255, 0, 255), width=3)
        d.text((x + 7, y - 6), row[0], fill=(255, 0, 255))
im.save(f'{work}/rmov_{stem}.png')
