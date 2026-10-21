"""Georeference the RM map PDFs against MLI's own DXF of the same map
(https://mli.gov.mb.ca/municipalities/ -> dxf_zip_files2/<RM>_dxf.zip,
UTM 14N metres). The PDF is a print of that drawing, so its grey section
lines and the DXF's Section_Township layer are the same lines: a bounding-
box seed plus a short ICP gives an essentially exact fit, including the
river-lot and partly unsurveyed RMs the section-grid fit (rmfit.py) missed.

    python -I rmdxf.py <workdir> <dxf root> [<RM file stem> ...]   (default: all)

Writes <workdir>/rm_<stem>.json in rmfit.py's format (M, muni, median_m,
...) and appends to rm_summary.tsv.
"""
import glob, json, math, os, re, sys
import fitz, numpy as np
import shapely
from shapely.geometry import LineString
from shapely.strtree import STRtree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rmfit  # noqa: E402

LAYERS = ('Section_Township',)


def dxf_lines(path, layers=LAYERS):
    """LINE and LWPOLYLINE geometry on `layers`, as lists of (x, y)."""
    L = [l.strip() for l in open(path, errors='replace').read().split('\n')]
    out = []
    i = 0
    n = len(L)
    while i < n - 1:
        if L[i] == '0' and L[i + 1] in ('LINE', 'LWPOLYLINE'):
            kind = L[i + 1]
            j = i + 2
            layer = None; xs = []; ys = []; x1 = y1 = x2 = y2 = None; closed = False
            while j < n - 1 and L[j] != '0':
                code, val = L[j], L[j + 1]
                if code == '8': layer = val
                elif kind == 'LINE':
                    if code == '10': x1 = float(val)
                    elif code == '20': y1 = float(val)
                    elif code == '11': x2 = float(val)
                    elif code == '21': y2 = float(val)
                else:
                    if code == '10': xs.append(float(val))
                    elif code == '20': ys.append(float(val))
                    elif code == '70': closed = bool(int(val) & 1)
                j += 2
            if layer in layers:
                if kind == 'LINE' and None not in (x1, y1, x2, y2):
                    out.append([(x1, y1), (x2, y2)])
                elif kind == 'LWPOLYLINE' and len(xs) > 1 and len(xs) == len(ys):
                    pts = list(zip(xs, ys))
                    out.append(pts + ([pts[0]] if closed else []))
            i = j
        else:
            i += 1
    return out


def norm(s):
    return re.sub(r'[^a-z]', '', s.lower().replace('deloroine', 'deloraine'))


def main():
    work, root = sys.argv[1], sys.argv[2]
    stems = sys.argv[3:] or sorted(f[:-4] for f in os.listdir(rmfit.SRC) if f.endswith('.pdf') and f != 'rm_maps_meta.pdf')
    feats = json.load(open(os.path.join(rmfit.WEB, 'public', 'mb-municipalities.geojson')))['features']
    # One folder per RM; big RMs come as several sheets ("Alexander Sheet
    # 1.dxf", "... Sheet 2.dxf"), merged here. Folder names carry MLI's
    # typos (Mossy_River, North_Cyress-Langford), so match fuzzily.
    import difflib
    dxfs = {}
    for d in glob.glob(os.path.join(root, '*', '')):
        files = glob.glob(os.path.join(d, '*.dxf'))
        if files:
            dxfs[norm(os.path.basename(os.path.dirname(d)))] = files
    for stem in stems:
        res = {'stem': stem, 'method': 'dxf'}
        try:
            muni = rmfit.muni_for(stem, feats)
            res['muni'] = muni['properties']['MUNI_LIST_NAME_WITH_TYPE'] if muni else None
            key = norm(stem.replace('_S2', ''))
            hit = dxfs.get(key) or dxfs.get((difflib.get_close_matches(key, list(dxfs), n=1, cutoff=0.85) or [None])[0])
            if not hit:
                raise RuntimeError('no DXF')
            res['dxf'] = [os.path.basename(p) for p in hit]
            ref = [ln for p in hit for ln in dxf_lines(p)]
            if len(ref) < 20:
                raise RuntimeError(f'only {len(ref)} section-line entities in the DXF')
            lines = np.array([LineString(p) for p in ref if len(p) > 1], dtype=object)
            tree = STRtree(lines)
            R = shapely.get_coordinates(lines)
            page = fitz.open(os.path.join(rmfit.SRC, stem + '.pdf'))[0]
            segs = rmfit.page_lines(page)
            if len(segs) < 20:
                raise RuntimeError(f'only {len(segs)} grey section-line segments on the page')
            src = rmfit.sample(segs, 2.0)
            pr = page.rect
            src = src[(src[:, 0] >= pr.x0) & (src[:, 0] <= pr.x1) & (src[:, 1] >= pr.y0) & (src[:, 1] <= pr.y1)]
            px0, py0 = np.percentile(src, 0.5, axis=0); px1, py1 = np.percentile(src, 99.5, axis=0)

            def bbox_seed(RR):
                ux0, uy0 = np.percentile(RR, 0.5, axis=0); ux1, uy1 = np.percentile(RR, 99.5, axis=0)
                s = math.sqrt(((px1 - px0) * (py1 - py0)) / ((ux1 - ux0) * (uy1 - uy0)))
                return np.array([[s, 0, (px0 + px1) / 2 - s * (ux0 + ux1) / 2], [0, -s, (py0 + py1) / 2 + s * (uy0 + uy1) / 2]])
            # Seeds, best result kept: the section-grid fit (fits/rm/), when
            # there is one; the merged DXF's bounding box; and each sheet's
            # own box (a two-sheet RM's page may show one sheet, or both at
            # a scale the merged box misjudges).
            seeds = []
            old = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fits', 'rm', f'rm_{stem}.json')
            if os.path.exists(old) and json.load(open(old)).get('M'):
                seeds.append(('grid', np.array(json.load(open(old))['M'])))
            seeds.append(('bbox', bbox_seed(R)))
            if len(hit) > 1:
                for p in hit:
                    RR = shapely.get_coordinates(np.array([LineString(q) for q in dxf_lines(p) if len(q) > 1], dtype=object))
                    if len(RR) > 10:
                        seeds.append((os.path.basename(p), bbox_seed(RR)))
            sub = src[:: max(1, len(src) // 5000)]

            def refine(M):
                for fit, radius in [(rmfit.sim_fit, r) for r in (2000, 800, 300, 100, 40)] + [(rmfit.aff_fit, 20), (rmfit.aff_fit, 10)]:
                    for it in range(25):
                        U = rmfit.apply(rmfit.inv(M), sub)
                        pts = shapely.points(U)
                        ln = lines[tree.nearest(pts)]
                        nr = shapely.get_coordinates(shapely.line_interpolate_point(ln, shapely.line_locate_point(ln, pts)))
                        d = np.hypot(*(U - nr).T)
                        keep = d < radius
                        if keep.sum() < 20:
                            break
                        Mn = fit(sub[keep], nr[keep])
                        done = np.abs(Mn - M).max() < 1e-9
                        M = Mn
                        if done:
                            break
                return M, d
            best = None
            for name_, M0 in seeds:
                M, d = refine(M0)
                score = float((d < 20).mean())
                if best is None or score > best[0]:
                    best = (score, M, d, name_)
            _, M, d, res['seed'] = best
            res['median_m'] = round(float(np.median(d)), 1)
            res['kept'] = round(float((d < 20).mean()), 3)
            res['m_per_pt'] = round(1 / math.sqrt(abs(np.linalg.det(M[:, :2]))), 2)
            res['aniso'] = round(float(np.linalg.norm(M[:, 0]) / np.linalg.norm(M[:, 1])), 4)
            res['rot'] = round(math.degrees(math.atan2(-M[1, 0], M[0, 0])), 2)
            res['M'] = M.tolist()
            res['status'] = 'ok'
        except Exception as ex:
            res['status'] = f'FAIL: {ex}'
        json.dump(res, open(os.path.join(work, f'rm_{stem}.json'), 'w'))
        line = '\t'.join(str(res.get(k, '')) for k in ('stem', 'muni', 'status', 'median_m', 'kept', 'm_per_pt', 'aniso', 'rot'))
        print(line, flush=True)
        with open(os.path.join(work, 'rm_summary.tsv'), 'a') as f:
            f.write(line + '\n')


if __name__ == '__main__':
    main()
