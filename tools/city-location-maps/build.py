"""Turn fitted highway-map city pages into the app's city location maps.

    python -I build.py <workdir> brandon steinbach thompson ...

Reads <workdir>/fit_<city>.json (from roadfit.py) and the source PDF, and
writes
    web/public/city-<city>.svg     the page cropped to what is drawn on it
    web/src/lib/cityMapData.js     crop size, UTM->page transform, obstacles
for every city listed (the data file is rewritten whole, so list them all).
See README.md for the full recipe.
"""
import json, os, sys
import fitz, numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.normpath(os.path.join(HERE, '..', '..', 'web'))
SRC = r'D:/Dropbox/Appraisal/Maps/Manitoba/Highways-2026'
# The municipality each page belongs to (mb-municipalities.geojson
# MUNI_LIST_NAME_WITH_TYPE) and the name the title box uses.
CITIES = {
    'brandon': ('BRANDON (CITY)', 'Brandon'),
    'dauphin': ('DAUPHIN (CITY)', 'Dauphin'),
    'flinflon': ('FLIN FLON (CITY)', 'Flin Flon'),
    'morden': ('MORDEN (CITY)', 'Morden'),
    'neepawa': ('NEEPAWA (TOWN)', 'Neepawa'),
    'niverville': ('NIVERVILLE (TOWN)', 'Niverville'),
    'portagelaprairie': ('PORTAGE LA PRAIRIE (CITY)', 'Portage la Prairie'),
    'selkirk': ('SELKIRK (CITY)', 'Selkirk'),
    'steinbach': ('STEINBACH (CITY)', 'Steinbach'),
    'stonewall': ('STONEWALL (TOWN)', 'Stonewall'),
    'thepas': ('THE PAS (TOWN)', 'The Pas'),
    'thompson': ('THOMPSON (CITY)', 'Thompson'),
    'winkler': ('WINKLER (CITY)', 'Winkler'),
}
MARGIN = 8          # white kept around the drawn content, points
# A white band across the top for the "Subject Property Location within
# <city>" title box, so it covers none of the map: the box is 21 map units
# tall plus a 4-unit margin, and cityMaps.js draws every page 380 units wide
# (UNIT_WIDTH there), so the band is 28 units of that.
TITLE_BAND_UNITS, UNIT_WIDTH = 28, 380
BACKGROUND = {(1.0, 1.0, 1.0), (1.0, 0.99, 0.85), (0.89, 0.96, 0.99)}  # paper, city, water
R2 = lambda c: tuple(round(x, 2) for x in c) if c else None


def content_box(page):
    """Bounding box of everything drawn, from a render (drawings run far
    past the page under their clip paths, so their own rects lie)."""
    dpi = 72
    pix = page.get_pixmap(dpi=dpi, alpha=False)
    a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
    ink = (a < 245).any(axis=2)
    ys, xs = np.nonzero(ink)
    k = 72 / dpi
    return fitz.Rect(xs.min() * k - MARGIN, ys.min() * k - MARGIN,
                     (xs.max() + 1) * k + MARGIN, (ys.max() + 1) * k + MARGIN) & page.rect


def obstacles(page, crop):
    """Label and symbol boxes, in cropped page points: every text line, every
    small filled symbol (shields, POI squares, compass) and every image."""
    boxes = []
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            if ''.join(s['text'] for s in l['spans']).strip():
                boxes.append(fitz.Rect(l['bbox']))
    for dr in page.get_drawings():
        r = dr['rect']
        if dr.get('fill') and R2(dr['fill']) not in BACKGROUND and max(r.width, r.height) < 40:
            boxes.append(r)
    for im in page.get_image_info():
        boxes.append(fitz.Rect(im['bbox']))
    out = []
    for r in boxes:
        r = r & crop
        if r.is_empty or r.width * r.height < 2:
            continue
        out.append([round(r.x0 - crop.x0, 1), round(r.y0 - crop.y0, 1),
                    round(r.x1 - crop.x0, 1), round(r.y1 - crop.y0, 1)])
    # Drop boxes wholly inside another (glyph pieces of one shield, etc.).
    out.sort(key=lambda b: -(b[2] - b[0]) * (b[3] - b[1]))
    kept = []
    for b in out:
        if not any(k[0] <= b[0] and k[1] <= b[1] and k[2] >= b[2] and k[3] >= b[3] for k in kept):
            kept.append(b)
    return kept


def main():
    work, names = sys.argv[1], sys.argv[2:]
    entries = []
    for name in names:
        muni, label = CITIES[name]
        fit = json.load(open(os.path.join(work, f'fit_{name}.json')))
        page = fitz.open(os.path.join(SRC, f'{name}.pdf'))[0]
        M = np.array(fit['M'])
        if page.rotation:
            # Drawings (what the fit used) are in the unrotated page frame,
            # the render and crop in the rotated one: carry M across.
            R = page.rotation_matrix
            M = np.array([[R.a, R.c, R.e], [R.b, R.d, R.f]]) @ np.vstack([M, [0, 0, 1]])
        crop = content_box(page)
        crop.y0 = max(0, crop.y0 - TITLE_BAND_UNITS * crop.width / UNIT_WIDTH)
        obs = obstacles(page, crop)
        M[:, 2] -= [crop.x0, crop.y0]
        # The crop is in the displayed (rotated) frame; the PDF's CropBox is
        # in the unrotated one (Portage la Prairie's page is /Rotate 90).
        page.set_cropbox((crop * page.derotation_matrix).normalize())
        svg = page.get_svg_image(text_as_path=True)
        with open(os.path.join(WEB, 'public', f'city-{name}.svg'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(svg)
        entries.append((name, muni, label, crop, M, obs, fit))
        print(f'{name}: {crop.width:.1f} x {crop.height:.1f} pt, {len(obs)} obstacles, median fit {fit["median_m"]:.1f} m, svg {len(svg) // 1024} KB')

    js = ['// Generated by tools/city-location-maps/build.py — do not edit by hand.',
          '// The Manitoba highway map\'s city pages (Highways-2026), cropped to what',
          '// is drawn: page size in points, the UTM 14N -> page affine (fitted to',
          '// OpenStreetMap roads, see tools/city-location-maps/README.md) and the',
          '// label / symbol boxes the SUBJECT callout steers around.',
          '// MB-only (not shared with the Winnipeg app).',
          '',
          'export const CITY_MAP_DATA = {']
    for name, muni, label, crop, M, obs, fit in entries:
        rows = ',\n'.join('    ' + ','.join(json.dumps(b) for b in obs[i:i + 6]) for i in range(0, len(obs), 6))
        js += [f'  {name}: {{',
               f'    label: {json.dumps(label)},',
               f'    muni: {json.dumps(muni)},',
               f'    width: {crop.width:.3f},',
               f'    height: {crop.height:.3f},',
               f'    // where the crop sits on the source PDF page, points',
               f'    origin: [{crop.x0:.3f}, {crop.y0:.3f}],',
               f'    // page x = a*E + b*N + c, page y = d*E + e*N + f; median road fit {fit["median_m"]:.1f} m',
               f'    affine: [{", ".join(repr(float(v)) for v in M[0])}, {", ".join(repr(float(v)) for v in M[1])}],',
               f'    obstacles: [\n{rows},\n    ],',
               '  },']
    js += ['};', '']
    with open(os.path.join(WEB, 'src', 'lib', 'cityMapData.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(js))


if __name__ == '__main__':
    main()
