import json, sys, os
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, r'D:/Dropbox/ClaudeCode/MBOpenData/mb-parcelsearch/tools/city-location-maps')
from utm import utm14
import townfit, parcelref
work, stem = sys.argv[1], sys.argv[2]
r = json.load(open(f'{work}/town_{stem}.json')); M = np.array(r['M'])
g = townfit.load_image(os.path.join(townfit.SRC, r['file']))
im = Image.fromarray(g).convert('RGB'); d = ImageDraw.Draw(im)
Mi = np.linalg.inv(np.vstack([M, [0, 0, 1]]))[:2]
H, W = g.shape
import math
# window: page corners -> lon/lat via utm inverse is not available; use generous box from centre
cE, cN = Mi @ [W / 2, H / 2, 1]
# crude inverse: search lon/lat by Newton on utm14
def inv_utm(E, N):
    lon, lat = -98.0, 50.0
    for _ in range(20):
        e, n = utm14(lon, lat); de, dn = E - e, N - n
        lon += de / (111320 * math.cos(math.radians(lat))); lat += dn / 110570
    return lon, lat
lon, lat = inv_utm(cE, cN)
ref = parcelref.load(work)
for ring in parcelref.rings_in(ref, lon - 0.05, lat - 0.03, lon + 0.05, lat + 0.03):
    P = [tuple(M @ [*utm14(*p), 1]) for p in ring]
    d.line(P, fill=(255, 0, 255), width=3)
im.thumbnail((1400, 1400)); im.save(f'{work}/ov2_{stem}.png')
