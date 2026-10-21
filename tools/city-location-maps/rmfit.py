"""Georeference the provincial RM maps ($MunicipalMaps-2017/<RM>.pdf) to the
Dominion Land Survey section grid (web/public/data/section-grid.json).

    python rmfit.py <workdir> [<RM file stem> ...]     (default: all)

Per map, page = M @ [E, N, 1] with E/N in UTM 14N metres:
  1. seed: bounding box of the drawn section lines vs the RM's boundary;
  2. township lock: the corner-section labels (1, 6, 31, 36) are matched to
     the nearest section with the same number. The grid repeats every
     1.6 km, so lines alone can lock a whole section off; a same-number
     section repeats only every 9.7 km;
  3. snap: trimmed ICP of the drawn section lines against the true section
     edges, similarity then affine.
Writes <workdir>/rm_<stem>.json and appends a line to rm_summary.tsv.
"""
import json, math, os, re, sys
import fitz, numpy as np
import shapely
from shapely.geometry import shape, Point, LineString, box
from shapely.strtree import STRtree
from shapely.ops import transform
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # utm.py beside this script
from utm import utm14  # noqa: E402

SRC = r'D:/Dropbox/Appraisal/Maps/$MunicipalMaps-2017'
WEB = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'web'))
GREY = (0.7, 0.7, 0.7)
R2 = lambda c: tuple(round(x, 2) for x in c) if c else None


def norm(s):
    s = s.lower().replace('sainte', 'ste').replace('saint', 'st')
    return re.sub(r'[^a-z]', '', s)


def muni_for(stem, feats):
    k = norm(stem.replace('_S2', ''))
    c = [f for f in feats if norm(re.sub(r'\s*\(.*\)', '', f['properties']['MUNI_LIST_NAME_WITH_TYPE'])) == k]
    if len(c) > 1:
        c = [f for f in c if not re.search(r'\((CITY|TOWN|VILLAGE)\)', f['properties']['MUNI_LIST_NAME_WITH_TYPE'])] or c
    return c[0] if c else None


def to_utm(geom):
    return transform(lambda x, y, z=None: tuple(zip(*[utm14(a, b) for a, b in zip(np.atleast_1d(x), np.atleast_1d(y))])), geom)


def sim_fit(src, dst):
    """Least squares page = [[p, q, c], [q, -p, f]] @ [E, N, 1] (north up,
    y down, uniform scale + rotation)."""
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


def page_lines(page):
    segs = []
    for dr in page.get_drawings():
        if dr.get('type') != 's' or R2(dr.get('color')) != GREY:
            continue
        for it in dr['items']:
            if it[0] == 'l':
                segs.append(((it[1].x, it[1].y), (it[2].x, it[2].y)))
    return segs


def sample(segs, step):
    out = []
    for a, b in segs:
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        for t in np.arange(0, L + 1e-9, step) / max(L, 1e-9):
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return np.array(out)


def corner_labels(page, work, stem):
    """Section numbers 1/6/31/36 at the township corners, in the small label
    size. Many 2017 pages carry no text layer (every label is outlined), so
    those are OCR'd from a 300 dpi render."""
    words = [((w[0] + w[2]) / 2, (w[1] + w[3]) / 2, w[4], w[3] - w[1]) for w in page.get_text('words')]
    if not words:
        import townfit
        dpi = 300
        pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY, alpha=False)
        gray = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width).copy()
        k = 72 / dpi
        words = [(w['x'] * k, w['y'] * k, w['t'], w['h'] * k) for w in townfit.ocr(gray, work, 'rm_' + stem)]
    cand = [w for w in words if w[2] in ('1', '6', '31', '36')]
    if not cand:
        return [], words
    # The corner labels share one small size; take the commonest height.
    hs = np.round([w[3] for w in cand], 0)
    vals, counts = np.unique(hs, return_counts=True)
    h0 = vals[np.argmax(counts)]
    return [(x, y, int(t)) for x, y, t, h in cand if abs(round(h) - h0) <= 1], words


def margin_labels(words):
    """The "Tp. 19" row labels and "Rge. 7E." column labels in the margins:
    ([(y, twp)], [(x, 'rgeE')])."""
    tps, rges = [], []
    # Only the margin's own size: the key-plan inset repeats "Tp. 14" etc.
    # in small type (Alexander: 4.3 pt against 9.8).
    hs = [w[3] for w in words if re.match(r'(Tp|Twp|Rge)', w[2], re.I)]
    hmax = max(hs) if hs else 0
    for i, (x, y, t, h) in enumerate(words):
        if h < hmax * 0.75:
            continue
        m = re.fullmatch(r'(Tp|Twp|Rge)\.?(\d{0,3}[EW]?)\.?', t, re.I)
        if not m:
            continue
        val = m.group(2)
        if not val:
            right = [w for w in words if abs(w[1] - y) < h * 0.6 and 0 < w[0] - x < h * 5]
            if not right:
                continue
            val = min(right, key=lambda w: w[0] - x)[2].rstrip('.,')
        if m.group(1).lower().startswith('t') and re.fullmatch(r'\d{1,3}', val):
            tps.append((y, int(val)))
        elif m.group(1).lower() == 'rge' and re.fullmatch(r'\d{1,2}[EW]', val.upper()):
            rges.append((x, val.upper()))
    return tps, rges


def main():
    work = sys.argv[1]
    stems = sys.argv[2:] or sorted(f[:-4] for f in os.listdir(SRC) if f.endswith('.pdf') and f != 'rm_maps_meta.pdf')
    feats = json.load(open(os.path.join(WEB, 'public', 'mb-municipalities.geojson')))['features']
    print('loading section grid…', flush=True)
    grid = json.load(open(os.path.join(WEB, 'public', 'data', 'section-grid.json')))['features']
    gcent = np.array([[sum(c[0] for c in f['geometry']['coordinates'][0][:-1]) / 4,
                       sum(c[1] for c in f['geometry']['coordinates'][0][:-1]) / 4] for f in grid])
    gutm = np.array([utm14(*c) for c in gcent])
    glab = [f['properties']['label'].split('-') for f in grid]
    gtwp = np.array([int(b) for _, b, _ in glab]); grge = np.array([c for _, _, c in glab])
    for stem in stems:
        res = {'stem': stem}
        try:
            muni = muni_for(stem, feats)
            if not muni:
                raise RuntimeError('no municipality match')
            res['muni'] = muni['properties']['MUNI_LIST_NAME_WITH_TYPE']
            mpoly = to_utm(shape(muni['geometry']))
            x0, y0, x1, y1 = shape(muni['geometry']).bounds
            pad = 0.25
            near = np.nonzero((gcent[:, 0] > x0 - pad) & (gcent[:, 0] < x1 + pad) & (gcent[:, 1] > y0 - pad * 0.6) & (gcent[:, 1] < y1 + pad * 0.6))[0]
            if len(near) < 20:
                raise RuntimeError(f'only {len(near)} surveyed sections near the RM')
            secs = [to_utm(shape(grid[i]['geometry'])) for i in near]
            secnum = np.array([int(grid[i]['properties']['label'].split('-')[0]) for i in near])
            edges = [LineString(s.exterior.coords) for s in secs]
            etree = STRtree(edges)
            page = fitz.open(os.path.join(SRC, stem + '.pdf'))[0]
            segs = page_lines(page)
            if len(segs) < 50:
                raise RuntimeError(f'only {len(segs)} grey section-line segments')
            src = sample(segs, 2.0)
            # 1. seed: the margin's township rows and range columns against the
            # grid's township / range centres; the bounding box only when the
            # margins do not give two of each.
            labs, words = corner_labels(page, work, stem)
            tps, rges = margin_labels(words)
            res['margins'] = f'{len(tps)} tp, {len(rges)} rge'
            M = None
            if len(tps) >= 2 and len(rges) >= 2:
                twps = {t for _, t in tps}; rgs = {r for _, r in rges}
                Nc = []; Ec = []
                for y, t in tps:
                    k = np.nonzero((gtwp == t) & np.isin(grge, list(rgs)))[0]
                    if len(k): Nc.append((y, float(np.median(gutm[k, 1]))))
                for x, r in rges:
                    k = np.nonzero((grge == r) & np.isin(gtwp, list(twps)))[0]
                    if len(k): Ec.append((x, float(np.median(gutm[k, 0]))))
                if len(Nc) >= 2 and len(Ec) >= 2:
                    ax, c = np.polyfit([e for _, e in Ec], [x for x, _ in Ec], 1)
                    ay, f = np.polyfit([n for _, n in Nc], [y for y, _ in Nc], 1)
                    M = np.array([[ax, 0, c], [0, ay, f]])
                    res['seed'] = 'margins'
            if M is None:
                px0, py0 = src.min(0); px1, py1 = src.max(0)
                ux0, uy0, ux1, uy1 = mpoly.bounds
                s = math.sqrt(((px1 - px0) * (py1 - py0)) / ((ux1 - ux0) * (uy1 - uy0)))
                M = np.array([[s, 0, (px0 + px1) / 2 - s * (ux0 + ux1) / 2], [0, -s, (py0 + py1) / 2 + s * (uy0 + uy1) / 2]])
                res['seed'] = 'bbox'
            res['m_seed'] = M.tolist()
            # 2. township lock from corner labels
            res['labels'] = len(labs)
            # Only without a margin seed: river-lot numbers read as section
            # numbers (Ritchot) and drag a lock off a good seed.
            if len(labs) >= 4 and res['seed'] != 'margins':
                L = np.array([l[:2] for l in labs]); Ln = np.array([l[2] for l in labs])
                cent = np.array([sp.centroid.coords[0] for sp in secs])
                for it in range(25):
                    U = apply(inv(M), L)
                    tgt = np.empty_like(U); dd = np.empty(len(U))
                    for i, (u, n) in enumerate(zip(U, Ln)):
                        cand = np.nonzero(secnum == n)[0]
                        j = cand[np.argmin(np.hypot(*(cent[cand] - u).T))]
                        tgt[i] = cent[j]; dd[i] = math.hypot(*(cent[j] - u))
                    keep = dd < max(2.5 * np.median(dd), 900)
                    if keep.sum() < 3:
                        keep[:] = True
                    M = sim_fit(L[keep], tgt[keep])
                res['label_median_m'] = round(float(np.median(dd)), 0)
                res['m_lock'] = M.tolist()
            # 3. snap section lines to the true section edges
            earr = np.array(edges, dtype=object)

            def nearest(U):
                pts = shapely.points(U)
                ln = earr[etree.nearest(pts)]
                return shapely.get_coordinates(shapely.line_interpolate_point(ln, shapely.line_locate_point(ln, pts)))
            sub = src[:: max(1, len(src) // 4000)]
            # The match radius shrinks from half a section, so a seed a few
            # hundred metres out (a margin seed is north-up; pages turn up to
            # ~2 degrees) still settles on the right section lines.
            def snap(M, radii):
                stages = [('similarity', sim_fit, r) for r in radii] + [('similarity', sim_fit, 40), ('affine', aff_fit, 40)]
                for mode, fit, radius in stages:
                    for it in range(30):
                        U = apply(inv(M), sub)
                        nr = nearest(U)
                        d = np.hypot(*(U - nr).T)
                        keep = d < (radius if radius > 40 else max(2.5 * np.median(d), 40))
                        if keep.sum() < 20:
                            break
                        Mn = fit(sub[keep], nr[keep])
                        done = np.abs(Mn - M).max() < 1e-7
                        M = Mn
                        if done or radius > 40 and it >= 8:
                            break
                return M, d, keep
            M, d, keep = snap(M, (600, 300, 150, 80))
            # 4. Township lock. Section lines repeat every 1.6 km, so the snap
            # can settle a whole section off (Cornwallis: 1,640 m east, every
            # corner label in the wrong section). Try whole-section shifts and
            # keep the one that puts the most corner labels in a section of
            # their own number; re-snap if it moved.
            stree = STRtree(secs)

            def labels_ok(M):
                if not labs:
                    return 0
                U = apply(inv(M), np.array([l[:2] for l in labs]))
                i, j = stree.query(shapely.points(U), predicate='within')
                return len({a for a, b in zip(i, j) if secnum[b] == labs[a][2]})
            SEC = 1609.3
            best = (labels_ok(M), 0, 0)
            for dx in range(-3, 4):
                for dy in range(-3, 4):
                    if dx or dy:
                        Ms = M.copy(); Ms[:, 2] -= M[:, :2] @ [dx * SEC, dy * SEC]
                        n = labels_ok(Ms)
                        if n > best[0]:
                            best = (n, dx, dy)
            if best[1] or best[2]:
                Ms = M.copy(); Ms[:, 2] -= M[:, :2] @ [best[1] * SEC, best[2] * SEC]
                M, d, keep = snap(Ms, (300, 150, 80))
                res['shift_sections'] = [best[1], best[2]]
            res['median_m'] = round(float(np.median(d[keep])), 1)
            res['kept'] = round(float(keep.mean()), 3)
            res['m_per_pt'] = round(1 / math.sqrt(abs(np.linalg.det(M[:, :2]))), 2)
            res['aniso'] = round(float(np.linalg.norm(M[:, 0]) / np.linalg.norm(M[:, 1])), 4)
            res['rot'] = round(math.degrees(math.atan2(-M[1, 0], M[0, 0])), 2)
            # Check: every corner label must now sit in a section of its own number.
            if labs:
                res['labels_ok'] = f'{labels_ok(M)}/{len(labs)}'
            res['M'] = M.tolist()
            res['status'] = 'ok'
        except Exception as ex:  # one bad map must not stop the batch
            res['status'] = f'FAIL: {ex}'
        json.dump(res, open(os.path.join(work, f'rm_{stem}.json'), 'w'))
        line = '\t'.join(str(res.get(k, '')) for k in ('stem', 'muni', 'status', 'median_m', 'kept', 'm_per_pt', 'aniso', 'rot', 'labels', 'label_median_m', 'labels_ok', 'seed', 'margins', 'shift_sections'))
        print(line, flush=True)
        with open(os.path.join(work, 'rm_summary.tsv'), 'a') as f:
            f.write(line + '\n')


if __name__ == '__main__':
    main()
