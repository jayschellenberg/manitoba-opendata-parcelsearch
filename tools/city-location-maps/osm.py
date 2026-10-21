"""Download OSM roads around a city: osm_<city>.json in the current dir.
    python -I osm.py <city> "<MUNI (TYPE)>"
Overpass sometimes answers 502; run it again.
"""
import json, sys, urllib.request, urllib.parse
from shapely.geometry import shape
name, muni = sys.argv[1], sys.argv[2]
g = json.load(open(r'D:/Dropbox/ClaudeCode/MBOpenData/mb-parcelsearch/web/public/mb-municipalities.geojson'))
f = next(f for f in g['features'] if f['properties']['MUNI_LIST_NAME_WITH_TYPE'] == muni)
x0, y0, x1, y1 = shape(f['geometry']).bounds
d = 0.06
q = f'[out:json][timeout:120];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)(_link)?$"]({y0-d},{x0-d*1.5},{y1+d},{x1+d*1.5});out geom;'
req = urllib.request.Request('https://overpass-api.de/api/interpreter', data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': 'mb-parcelsearch georef (jksconsulting)'})
js = json.load(urllib.request.urlopen(req, timeout=180))
ways = [{'hw': e['tags'].get('highway'), 'name': e['tags'].get('name'), 'ref': e['tags'].get('ref'), 'pts': [[p['lon'], p['lat']] for p in e['geometry']]} for e in js['elements'] if e['type'] == 'way']
json.dump(ways, open(f'osm_{name}.json', 'w'))
print(name, len(ways))
