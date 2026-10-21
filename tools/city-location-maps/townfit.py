"""Georeference the provincial town / village / unincorporated community plans
($Town and Village Maps/<name>.gif|pdf) — scans or text-less vector pages.

    python townfit.py <workdir> <file> [<file> ...]

Per sheet (page = pixel coordinates of the image, or of a 150 dpi render of
a PDF):
  1. OCR (Tesseract) for the title's SEC-TWP-RGE list, the scale bar and
     the street names;
  2. seed: the centre of the listed sections (else the CGN place point for
     the file name), scale from the scale bar, north up;
  3. search: FFT chamfer over translation (and +-2 degrees, +-6% scale) of
     the drawn lines against OSM roads + the section grid around the seed;
  4. snap: trimmed ICP of the drawn lines, similarity then affine.
Writes <workdir>/town_<stem>.json and appends to town_summary.tsv.
"""
import json, math, os, re, subprocess, sys, time, urllib.parse, urllib.request
import fitz, numpy as np
import shapely
from PIL import Image, ImageDraw
from shapely.geometry import shape, Point, LineString
from shapely.strtree import STRtree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # utm.py beside this script
from utm import utm14  # noqa: E402
import parcelref  # noqa: E402

# TOWNFIT_SRC: another folder of plans, e.g. MLI_SRC below for MLI's vector
# redraws (https://mli.gov.mb.ca/towns/, named <Town>_S<sheet>.pdf).
SRC = os.environ.get('TOWNFIT_SRC', r'D:/Dropbox/Appraisal/Maps/$Town and Village Maps')
# Jason's master copy of MLI's plans (2026-10-21); the folder above holds the
# 1979-2014 scans that the 23 old-scan fits in fits/town still come from.
MLI_SRC = r'D:/Dropbox/Appraisal/Maps/$Town and Village Maps 2026'
WORK = '.'
WEB = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'web'))
TESS = r'C:/Program Files/Tesseract-OCR/tesseract.exe'
PDF_DPI = 250
# Scale-bar multipliers the search tries: the bar is read from OCR'd label
# centres: every verified fit is within 3% of it, and a wider search let
# Alonsa lock 7% off scale onto the wrong fields.
SCALES = tuple(float(v) for v in os.environ.get('TOWNFIT_SCALES', '0.96,0.98,1.0,1.02,1.04').split(','))


def load_image(path):
    if path.lower().endswith('.pdf'):
        pix = fitz.open(path)[0].get_pixmap(dpi=PDF_DPI, colorspace=fitz.csGRAY, alpha=False)
        return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width).copy()
    return np.array(Image.open(path).convert('L'))


def ocr(gray, work, stem):
    png = os.path.join(work, f'ocr_{stem}.png')
    Image.fromarray(gray).save(png)
    base = os.path.join(work, f'ocr_{stem}')
    subprocess.run([TESS, png, base, '--psm', '11', 'tsv'], capture_output=True, check=True)
    words = []
    with open(base + '.tsv', encoding='utf-8', errors='replace') as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split('\t')
            if len(p) >= 12 and p[11].strip() and float(p[10]) > 40:
                l, t, w, h = map(int, p[6:10])
                words.append({'t': p[11].strip(), 'x': l + w / 2, 'y': t + h / 2, 'box': (l, t, l + w, t + h), 'h': h})
    os.remove(png)
    return words


def parse_sections(words):
    """SEC-TWP-RGE triples from the title ("SEC. 36 - TWP. 10 - RGE. 6E.")."""
    text = ' '.join(w['t'] for w in sorted(words, key=lambda w: (round(w['y'] / 20), w['x'])))
    out = set()
    for m in re.finditer(r'SEC\.?\s*(\d{1,2})\D{0,12}?TWP\.?\s*(\d{1,3})\D{0,12}?RGE\.?\s*(\d{1,2})\s*([EW])', text, re.I):
        out.add(f'{int(m.group(1))}-{int(m.group(2))}-{int(m.group(3))}{m.group(4).upper()}')
    # A list like "SEC. 1, 2 & 11 - TWP. 11 - RGE. 6E." — take every number before TWP.
    for m in re.finditer(r"SEC(?:'?S)?\.?\s*([\d,&\sAND]+?)\s*-?\s*TWP\.?\s*(\d{1,3})\D{0,12}?RGE\.?\s*(\d{1,2})\s*([EW])", text, re.I):
        for n in re.findall(r'\d{1,2}', m.group(1)):
            out.add(f'{int(n)}-{int(m.group(2))}-{int(m.group(3))}{m.group(4).upper()}')
    return sorted(out)


def corner_labels(words, title_secs):
    """The section-corner labels: a "TWP - RGE" pair ("21  11W." or
    "11 -6E") with, usually, the section number in bold just above it.
    Each comes back as (x, y, [allowed section labels]): the section named
    above it, else the title's sections in that township, else the whole
    township."""
    out = []
    for i, a in enumerate(words):
        if not re.fullmatch(r'\d{1,3}', a['t']):
            continue
        for b in words:
            if b is a or abs(b['y'] - a['y']) > a['h'] * 0.6 or not 0 < b['x'] - a['x'] < a['h'] * 6:
                continue
            m = re.fullmatch(r'-?(\d{1,2})([EW])\.?,?', b['t'])
            if not m:
                continue
            twp, rge = int(a['t']), f'{int(m.group(1))}{m.group(2)}'
            if not 1 <= twp <= 130:
                continue
            cx = (a['box'][0] + b['box'][2]) / 2; cy = a['y']
            above = [w for w in words if re.fullmatch(r'\d{1,2}', w['t']) and 1 <= int(w['t']) <= 36
                     and 0 < cy - w['y'] < a['h'] * 4 and abs(w['x'] - cx) < a['h'] * 4 and w['h'] > a['h'] * 1.1]
            if above:
                n = min(above, key=lambda w: cy - w['y'])
                allowed = [f"{int(n['t'])}-{twp}-{rge}"]
                cx, cy = (cx + n['x']) / 2, (cy + n['y']) / 2
            else:
                # No readable number (OCR often misses the bold digit): any
                # section of the township. The title list is too often partial.
                allowed = [f'{k}-{twp}-{rge}' for k in range(1, 37)]
            out.append((cx, cy, allowed))
            break
    return out


def scale_from_bar(words):
    """Pixels per metre from the scale bar: the numbers on one row ("0 100
    200 300"; OCR often drops the 0) whose unit word (METRES / FEET) sits
    just below. Values must rise evenly with x; the slope is the scale.
    Returns (ppm, numbers used, largest value, metres per unit) or None."""
    units = ([(w, 1.0) for w in words if re.match(r'MET', w['t'], re.I)]
             + [(w, 0.3048) for w in words if re.fullmatch(r'(FEET|FT)\.?', w['t'], re.I)])
    best = None
    for uw, unit in units:
        # Number rows above the unit word, within a few line heights.
        nums = [w for w in words if re.fullmatch(r'\d{1,5}', w['t'])
                and 0 < uw['y'] - w['y'] < uw['h'] * 6 and abs(w['x'] - uw['x']) < uw['h'] * 40]
        # Group into rows by nearness in y (rounding into buckets split
        # Bissett's "100" and "600", one pixel apart).
        rows = []
        for w in sorted(nums, key=lambda w: w['y']):
            if rows and w['y'] - rows[-1][-1]['y'] < w['h'] * 0.6:
                rows[-1].append(w)
            else:
                rows.append([w])
        for row in rows:
            row = sorted(((int(w['t']), w['x']) for w in row), key=lambda t: t[1])[:10]
            # The largest subset that rises evenly with x: a lot number on
            # the same row (Arnaud's "27", 700 px right of "500 1500")
            # must not sink the whole bar.
            for mask in range(1, 1 << len(row)):
                pts = [row[i] for i in range(len(row)) if mask >> i & 1]
                if len(pts) < 2 or (best and len(pts) < best[1]):
                    continue
                vs = np.array([v for v, _ in pts], float); xs = np.array([x for _, x in pts], float)
                if np.any(np.diff(vs) <= 0):
                    continue
                slope, icpt = np.polyfit(vs, xs, 1)
                if slope <= 0 or (len(pts) > 2 and np.max(np.abs(np.polyval([slope, icpt], vs) - xs)) > max(6, 0.04 * (xs[-1] - xs[0]))):
                    continue
                # A bar's ticks are close together: reject pairs spread over
                # more than a fifth of the sheet's text width.
                if xs[-1] - xs[0] > uw['h'] * 50:
                    continue
                cand = (slope / unit, len(pts), int(vs[-1]), unit)
                if best is None or cand[1] > best[1]:
                    best = cand
    return best


def bar_from_geometry(gray, words):
    """One number over the bar ("0" missed, as on Bellsite's "0 ... 1500"):
    measure the drawn bar instead. Its longest dark run between the number
    and the unit word ends at the tick under the number and starts at 0."""
    H, W = gray.shape
    units = ([(w, 1.0) for w in words if re.match(r'MET', w['t'], re.I)]
             + [(w, 0.3048) for w in words if re.fullmatch(r'(FEET|FT)\.?', w['t'], re.I)])
    for uw, unit in units:
        nums = [w for w in words if re.fullmatch(r'\d{2,5}', w['t'])
                and 0 < uw['y'] - w['y'] < uw['h'] * 6 and abs(w['x'] - uw['x']) < uw['h'] * 25]
        for n in nums:
            y0, y1 = int(n['box'][3]), int(uw['box'][1])
            if y1 - y0 < 3:
                continue
            # Only the bar's neighbourhood: across the full width a road in
            # the same rows is longer than the bar.
            bx0 = max(0, int(min(uw['x'], n['x']) - uw['h'] * 25)); bx1 = min(W, int(n['x'] + n['h'] * 2))
            band = gray[y0:y1, bx0:bx1] < 128
            best = None
            for row in band:
                d = np.diff(np.r_[0, row.astype(np.int8), 0])
                starts, ends = np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]
                # Bars are drawn as segments with small gaps between them:
                # merge runs closer than a character height.
                runs = []
                for a0, a1 in zip(starts, ends):
                    if runs and a0 - runs[-1][1] < n['h']:
                        runs[-1][1] = a1
                    else:
                        runs.append([a0, a1])
                for a0, a1 in runs:
                    if best is None or a1 - a0 > best[1] - best[0]:
                        best = (a0, a1)
            if best:
                best = (best[0] + bx0, best[1] + bx0)
            if best and abs(best[1] - n['x']) < n['h'] * 1.5 and best[1] - best[0] > n['h'] * 3:
                return ((best[1] - best[0]) / (int(n['t']) * unit), 1, int(n['t']), unit)
    return None


def ratio_scale(words, dpi=300):
    """"1 INCH = 500 FEET" -> pixels per metre at `dpi`."""
    text = ' '.join(w['t'] for w in sorted(words, key=lambda w: (round(w['y'] / 20), w['x'])))
    # OCR often loses the "1 INCH =" (Badger read "SCALE: 500 FEET").
    # The "1" comes back as "|", "l" or "I" as often as not.
    m = re.search(r'SCALE\W*(?:[1|lI]?\s*INCH\s*=?\s*)?([\d,]{2,6})\s*(FEET|FT|MET)', text, re.I)
    if not m:
        return None
    n = int(m.group(1).replace(',', ''))
    unit = 1.0 if m.group(2).upper().startswith('MET') else 0.3048
    return (dpi / (n * unit), 0, n, unit)


def overpass(lat, lon, r_deg, cache):
    if os.path.exists(cache):
        return json.load(open(cache))
    q = (f'[out:json][timeout:90];way["highway"]({lat - r_deg},{lon - r_deg * 1.6},{lat + r_deg},{lon + r_deg * 1.6});out geom;')
    for attempt in range(4):
        try:
            req = urllib.request.Request('https://overpass-api.de/api/interpreter', data=urllib.parse.urlencode({'data': q}).encode(),
                                         headers={'User-Agent': 'mb-parcelsearch georef (jksconsulting)'})
            js = json.load(urllib.request.urlopen(req, timeout=120))
            ways = [[[p['lon'], p['lat']] for p in e['geometry']] for e in js['elements'] if e['type'] == 'way']
            json.dump(ways, open(cache, 'w'))
            time.sleep(1.5)
            return ways
        except Exception:
            time.sleep(10 * (attempt + 1))
    raise RuntimeError('overpass failed')


def line_pixels(gray, words):
    """Dark pixels that are lines, not text: blank every OCR word box and
    every small connected blob."""
    ink = gray < 128
    for w in words:
        x0, y0, x1, y1 = w['box']
        ink[max(0, y0 - 3):y1 + 3, max(0, x0 - 3):x1 + 3] = False
    ys, xs = np.nonzero(ink)
    return np.c_[xs, ys].astype(float)


def to_utm_poly(geom):
    from shapely.geometry import Polygon
    return Polygon([utm14(*p) for p in geom['coordinates'][0]])


def sim_fit(src, dst):
    e, n = dst.T; x, y = src.T
    A = np.zeros((2 * len(e), 4))
    A[:len(e)] = np.c_[e, n, np.ones_like(e), np.zeros_like(e)]
    A[len(e):] = np.c_[-n, e, np.zeros_like(e), np.ones_like(e)]
    p, q, c, f = np.linalg.lstsq(A, np.r_[x, y], rcond=None)[0]
    return np.array([[p, q, c], [q, -p, f]])


def aff_fit(src, dst):
    X = np.c_[dst, np.ones(len(dst))]
    return np.vstack([np.linalg.lstsq(X, src[:, k], rcond=None)[0] for k in range(2)])


def inv(M):
    return np.linalg.inv(np.vstack([M, [0, 0, 1]]))[:2]


def apply(M, P):
    return (M @ np.c_[P, np.ones(len(P))].T).T


class Ctx:
    def __init__(self):
        self.places = json.load(open(os.path.join(WEB, 'public', 'mb-places.json')))
        print('loading section grid…', flush=True)
        g = json.load(open(os.path.join(WEB, 'public', 'data', 'section-grid.json')))['features']
        self.grid = {f['properties']['label']: f['geometry'] for f in g}
        self.gc = np.array([f['geometry']['coordinates'][0][0] for f in g])
        self.gfeat = g
        self.parcels = parcelref.load(WORK)


def place_point(ctx, stem):
    name = re.sub(r'_S?\d+$|_index$', '', stem).replace('_', ' ').lower()
    flds = ctx.places['fields']; rows = ctx.places['places'] if 'places' in ctx.places else ctx.places.get('rows', [])
    i_n, i_lat, i_lon = flds.index('name'), flds.index('lat'), flds.index('lon')
    norm = lambda s: re.sub(r'[^a-z]', '', s.lower().replace('saint', 'st').replace('sainte', 'ste'))
    hits = [r for r in rows if norm(r[i_n]) == norm(name)]
    return (hits[0][i_lon], hits[0][i_lat]) if hits else None


def fit_one(ctx, work, fname):
    stem = os.path.splitext(fname)[0]
    res = {'file': fname, 'src': SRC}
    gray = load_image(os.path.join(SRC, fname))
    H, W = gray.shape
    res['size'] = [W, H]
    words = ocr(gray, work, stem)
    secs = parse_sections(words)
    res['sections'] = secs
    bar = scale_from_bar(words)
    if not bar:
        # The bar's small numbers often escape a full-page pass (Beausejour):
        # read the strip above each unit word again at 3x.
        for uw in [w for w in words if re.match(r'MET|FEET|FT', w['t'], re.I)]:
            x0 = max(0, int(uw['x'] - uw['h'] * 40)); x1 = min(W, int(uw['x'] + uw['h'] * 40))
            y0 = max(0, int(uw['y'] - uw['h'] * 6)); y1 = min(H, int(uw['y'] + uw['h']))
            crop = np.array(Image.fromarray(gray[y0:y1, x0:x1]).resize(((x1 - x0) * 3, (y1 - y0) * 3), Image.LANCZOS))
            extra = [{**w, 'x': x0 + w['x'] / 3, 'y': y0 + w['y'] / 3, 'h': w['h'] / 3,
                      'box': tuple(v / 3 + o for v, o in zip(w['box'], (x0, y0, x0, y0)))}
                     for w in ocr(crop, work, stem + '_bar')]
            bar = scale_from_bar(extra)
            if bar:
                res['bar_zoom'] = True
                break
    if not bar:
        bar = bar_from_geometry(gray, words)
        if bar:
            res['bar_geometry'] = True
    scales = SCALES
    if not bar:
        # "SCALE: 1 INCH = 500 FEET" and no bar (Badger): the scans carry no
        # dpi, but the pages are ~2420 x 3170 px, letter at 300 dpi. Seed
        # from that and search wider; review these by eye.
        bar = ratio_scale(words)
        if bar:
            res['ratio_scale'] = True
            scales = tuple(round(0.76 + 0.03 * i, 2) for i in range(17))
    if not bar:
        raise RuntimeError('no scale bar read')
    ppm = bar[0]
    res['bar'] = [round(float(ppm), 4), bar[2], 'm' if bar[3] == 1 else 'ft']
    labels = corner_labels(words, secs)
    res['labels'] = [[round(x), round(y), al[0] if len(al) == 1 else f'{len(al)} secs'] for x, y, al in labels]
    # Seed: the title's sections, else the sections the corner labels name,
    # else the CGN place point for the file name.
    named = secs or sorted({al[0] for _, _, al in labels if len(al) == 1})
    geoms = [shape(ctx.grid[t]) for t in named if t in ctx.grid]
    if geoms:
        c = np.mean([g.centroid.coords[0] for g in geoms], axis=0)
        lon, lat = float(c[0]), float(c[1]); res['seed'] = 'sections'
    else:
        pp = place_point(ctx, stem)
        if not pp:
            raise RuntimeError('no sections parsed and no place match')
        lon, lat = pp; res['seed'] = 'place'
    # Reference lines: OSM roads + section edges within reach of the sheet.
    half_m = max(W, H) / ppm / 2 + 2500
    r_deg = half_m / 111000
    # Reference: the assessment-parcel edges (the plans draw lot lines and
    # road-allowance edges, i.e. parcel edges); OSM roads + the section grid
    # only where the fabric is thin.
    rings = parcelref.rings_in(ctx.parcels, lon - r_deg * 1.6, lat - r_deg, lon + r_deg * 1.6, lat + r_deg)
    ref = [LineString([utm14(*p) for p in r]) for r in rings if len(r) > 1]
    res['ref'] = f'{len(ref)} parcels'
    if len(ref) < 40:
        ways = overpass(lat, lon, r_deg, os.path.join(work, f'osm_town_{stem}.json'))
        ref += [LineString([utm14(*p) for p in w]) for w in ways if len(w) > 1]
        sel = np.nonzero((np.abs(ctx.gc[:, 0] - lon) < r_deg * 1.6) & (np.abs(ctx.gc[:, 1] - lat) < r_deg))[0]
        for i in sel:
            ref.append(LineString([utm14(*p) for p in ctx.gfeat[i]['geometry']['coordinates'][0]]))
        res['ref'] += f' + {len(ways)} osm + grid'
    if len(ref) < 10:
        raise RuntimeError('too little reference geometry')
    tree = STRtree(ref)
    E0, N0 = utm14(lon, lat)
    pts = line_pixels(gray, words)
    if len(pts) < 500:
        raise RuntimeError('no line work found')
    rng = np.random.default_rng(0)
    sub = pts[rng.choice(len(pts), min(len(pts), 20000), replace=False)]
    # Reference distance raster, 10 m cells (the ICP below refines).
    C = 10.0
    ext = half_m + 500
    Wr = Hr = int(2 * ext / C)
    occ = np.zeros((Hr, Wr), bool)
    dens = shapely.get_coordinates(shapely.segmentize(np.array(ref, dtype=object), C / 2))
    col = ((dens[:, 0] - (E0 - ext)) / C).astype(int); row = (((N0 + ext) - dens[:, 1]) / C).astype(int)
    ok = (row >= 0) & (row < Hr) & (col >= 0) & (col < Wr)
    occ[row[ok], col[ok]] = True
    CAP = 8
    dt = np.where(occ, 0.0, CAP)
    for _ in range(CAP):
        m = dt.copy()
        m[1:] = np.minimum(m[1:], dt[:-1] + 1); m[:-1] = np.minimum(m[:-1], dt[1:] + 1)
        m[:, 1:] = np.minimum(m[:, 1:], dt[:, :-1] + 1); m[:, :-1] = np.minimum(m[:, :-1], dt[:, 1:] + 1)
        dt = m
    Fdt = np.fft.rfft2(dt)
    # Section polygons the corner labels must land in, buffered 150 m (labels
    # sit near the lines), in UTM.
    lab_polys = []
    for x, y, allowed in labels:
        polys = [to_utm_poly(ctx.grid[t]).buffer(150) for t in allowed if t in ctx.grid]
        if polys:
            lab_polys.append((x, y, polys))
    res['label_constraints'] = len(lab_polys)
    best = None
    cx, cy = W / 2, H / 2
    for rot in (-2, -1, 0, 1, 2):
        for sf in scales:
            r = math.radians(rot); s = 1 / (ppm * sf)
            dx, dy = sub[:, 0] - cx, sub[:, 1] - cy
            u = s * (dx * math.cos(r) + dy * math.sin(r)); v = s * (dx * math.sin(r) - dy * math.cos(r))
            umin, vmax = u.min(), v.max()
            ui = np.round((u - umin) / C).astype(int); vi = np.round((vmax - v) / C).astype(int)
            if ui.max() >= Wr or vi.max() >= Hr:
                continue
            P = np.zeros((Hr, Wr)); np.add.at(P, (vi, ui), 1)
            corr = np.fft.irfft2(Fdt * np.conj(np.fft.rfft2(P)), s=P.shape)
            valid = corr[: Hr - vi.max(), : Wr - ui.max()].copy()
            votes = np.zeros(valid.shape, np.int16)
            # Translations (kx, ky) that put every corner label inside one of
            # its allowed sections: a label at metre offset (uL, vL) lands at
            # E = (E0 - ext) + kx*C + (uL - umin), N = (N0 + ext) - ky*C - (vmax - vL).
            for x, y, polys in lab_polys:
                ddx, ddy = x - cx, y - cy
                uL = s * (ddx * math.cos(r) + ddy * math.sin(r)); vL = s * (ddx * math.sin(r) - ddy * math.cos(r))
                mask = Image.new('1', (valid.shape[1], valid.shape[0]), 0)
                dr = ImageDraw.Draw(mask)
                for poly in polys:
                    for part in getattr(poly, 'geoms', [poly]):
                        dr.polygon([((E - (E0 - ext) - (uL - umin)) / C, ((N0 + ext) - N - (vmax - vL)) / C)
                                    for E, N in part.exterior.coords], fill=1)
                votes += np.array(mask, bool)
            # Keep the placements that satisfy the most corner labels, so one
            # misread label (Amaranth) cannot veto the right answer; with two or
            # fewer, all must hold (one alone let Alonsa lock 7% off scale).
            if lab_polys:
                need = votes.max()
                n = len(lab_polys)
                if need < (n if n <= 2 else n - 1):
                    continue
                valid[votes < need] = np.inf
            k = np.unravel_index(np.argmin(valid), valid.shape)
            score = valid[k] / len(sub)
            if best is None or score < best[0]:
                best = (score, rot, sf, k, umin, vmax)
    if best is None:
        raise RuntimeError('no placement satisfies the corner labels')
    score, rot, sf, (ky, kx), umin, vmax = best
    res['search'] = [round(float(score), 2), rot, sf]
    r = math.radians(rot); s = 1 / (ppm * sf)
    a, b = s * math.cos(r), s * math.sin(r)
    Eo = (E0 - ext) + kx * C - umin; No = (N0 + ext) - ky * C - vmax
    Fwd = np.array([[a, b, Eo - a * cx - b * cy], [b, -a, No - b * cx + a * cy]])
    M = inv(Fwd)

    refarr = np.array(ref, dtype=object)

    def nearest(U):
        pts = shapely.points(U)
        lines = refarr[tree.nearest(pts)]
        return shapely.get_coordinates(shapely.line_interpolate_point(lines, shapely.line_locate_point(lines, pts)))
    icp = sub[rng.choice(len(sub), min(len(sub), 5000), replace=False)]
    # Similarity only: the plans are drafted true to scale, and an affine on
    # sparse matches buys shear, not accuracy (Anola: 2% anisotropy).
    for mode, fit in (('similarity', sim_fit),):
        for it in range(30):
            U = apply(inv(M), icp)
            nr = nearest(U)
            d = np.hypot(*(U - nr).T)
            keep = d < max(2.5 * np.median(d), 8)
            Mn = fit(icp[keep], nr[keep])
            done = np.abs(Mn - M).max() < 1e-9
            M = Mn
            if done:
                break
    res['median_m'] = round(float(np.median(d[keep])), 1)
    res['kept'] = round(float(keep.mean()), 3)
    res['m_per_px'] = round(1 / math.sqrt(abs(np.linalg.det(M[:, :2]))), 4)
    res['bar_m_per_px'] = round(1 / ppm, 4)
    res['aniso'] = round(float(np.linalg.norm(M[:, 0]) / np.linalg.norm(M[:, 1])), 4)
    res['rot'] = round(math.degrees(math.atan2(-M[1, 0], M[0, 0])), 2)
    res['M'] = M.tolist()
    # A fit that wandered off its own scale bar latched onto the wrong lines
    # (Bellsite: 13% off). Ratio-scale sheets have no bar to hold to.
    drift = res['m_per_px'] / res['bar_m_per_px'] - 1
    res['scale_drift'] = round(drift, 3)
    if not res.get('ratio_scale') and abs(drift) > 0.06:
        raise RuntimeError(f'scale drifted {drift:+.0%} from the bar')
    return res


def main():
    global WORK
    work = WORK = sys.argv[1]
    ctx = Ctx()
    for fname in sys.argv[2:]:
        if os.environ.get('TOWNFIT_SKIP') and os.path.exists(os.path.join(work, f'town_{os.path.splitext(fname)[0]}.json')):
            continue
        try:
            res = fit_one(ctx, work, fname); res['status'] = 'ok'
        except Exception as ex:
            res = {'file': fname, 'status': f'FAIL: {ex}'}
        json.dump(res, open(os.path.join(work, f'town_{os.path.splitext(fname)[0]}.json'), 'w'))
        line = '\t'.join(str(res.get(k, '')) for k in ('file', 'status', 'seed', 'sections', 'bar', 'ref', 'label_constraints', 'search', 'median_m', 'kept', 'm_per_px', 'bar_m_per_px', 'aniso', 'rot'))
        print(line, flush=True)
        with open(os.path.join(work, 'town_summary.tsv'), 'a') as f:
            f.write(line + '\n')


if __name__ == '__main__':
    main()
