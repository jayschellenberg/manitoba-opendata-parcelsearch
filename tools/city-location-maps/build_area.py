"""Build the R2 assets for the RM maps and community plans (lib/areaMaps.js).

    python build_area.py <rm workdir> <town workdir> <review.json> <outdir>

review.json: {"rm": {"<stem>": "ok" | "reject"}, "town": {"<file>": ...}};
only sheets marked "ok" are built. Writes to <outdir>:
    rm/<slug>.svg        RM page, cropped to its frame, white title band on top
    plan/<slug>.png      community plan, greyscale, white title band on top
    index.json           {version, generated, maps: [{id, kind, label, muni,
                          file, width, height, affine, obstacles}]}
Upload <outdir> to r2-mb:mb-ortho/location-maps/ (README.md).
"""
import datetime, json, os, re, sys
import fitz, numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import townfit  # noqa: E402
import rmfit  # noqa: E402

UNIT_WIDTH = 380          # cityMaps.js / areaMaps.js measure pages this wide
TITLE_BAND_UNITS = 28     # room for the title box (21 units + margin)
TYPE_LABEL = {'RM': 'R.M. of {}', 'MUNICIPALITY': 'Municipality of {}', 'LGD': 'LGD of {}',
              'TOWN': 'Town of {}', 'VILLAGE': 'Village of {}', 'CITY': 'City of {}'}


def title_case(name):
    s = name.strip().lower()
    s = re.sub(r"(^|[\s\-.'(])([a-z])", lambda m: m.group(1) + m.group(2).upper(), s)
    return re.sub(r'(?!^)\b(Du|De|La|Le|Des|Of|And)\b', lambda m: m.group(0).lower(), s)


def rm_label(muni):
    m = re.match(r'^(.*?)\s*\(([^)]+)\)\s*$', muni)
    name, typ = (m.group(1), m.group(2).strip()) if m else (muni, '')
    return TYPE_LABEL.get(typ, '{}').format(title_case(name))


def boxes_inside(boxes, w, h):
    out = []
    for x0, y0, x1, y1 in boxes:
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
        if x1 - x0 > 1 and y1 - y0 > 1:
            out.append([round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)])
    return out


def build_rm(stem, fit, work, outdir):
    page = fitz.open(os.path.join(rmfit.SRC, stem + '.pdf'))[0]
    pix = page.get_pixmap(dpi=72, alpha=False)
    a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
    ys, xs = np.nonzero((a < 245).any(axis=2))
    crop = fitz.Rect(xs.min() - 4, ys.min() - 4, xs.max() + 5, ys.max() + 5) & page.rect
    band = TITLE_BAND_UNITS * crop.width / UNIT_WIDTH
    # Labels and symbols: the text layer, else the OCR the fit already ran.
    words = [fitz.Rect(w[:4]) for w in page.get_text('words')]
    if not words:
        tsv = os.path.join(work, f'ocr_rm_{stem}.tsv')
        k = 72 / 300
        if os.path.exists(tsv):
            for line in open(tsv, encoding='utf-8', errors='replace').read().splitlines()[1:]:
                p = line.split('\t')
                if len(p) >= 12 and p[11].strip() and float(p[10]) > 40:
                    l, t, w_, h_ = map(int, p[6:10])
                    words.append(fitz.Rect(l * k, t * k, (l + w_) * k, (t + h_) * k))
    boxes = [[r.x0 - crop.x0, r.y0 - crop.y0 + band, r.x1 - crop.x0, r.y1 - crop.y0 + band] for r in words]
    page.set_cropbox(crop)
    svg = page.get_svg_image(text_as_path=True)
    W, H = crop.width, crop.height
    # Extend the viewBox up by the band (renderLocationMap paints white
    # first): image y = page y + band, hence the shifts below.
    svg = re.sub(r'width="[\d.]+" height="[\d.]+" viewBox="0 0 [\d.]+ [\d.]+"',
                 f'width="{W:.3f}" height="{H + band:.3f}" viewBox="0 {-band:.3f} {W:.3f} {H + band:.3f}"', svg, count=1)
    M = np.array(fit['M'])
    M[:, 2] -= [crop.x0, crop.y0]
    M[1, 2] += band
    slug = re.sub(r'[^a-z0-9]+', '-', stem.lower()).strip('-')
    os.makedirs(os.path.join(outdir, 'rm'), exist_ok=True)
    with open(os.path.join(outdir, 'rm', slug + '.svg'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(svg)
    return {'id': f'rm-{slug}', 'kind': 'rm', 'label': rm_label(fit['muni']), 'muni': fit['muni'],
            'file': f'rm/{slug}.svg', 'width': round(W, 3), 'height': round(H + band, 3),
            'affine': [float(v) for v in M.reshape(-1)], 'obstacles': boxes_inside(boxes, W, H + band)}


def build_plan(fname, fit, work, outdir, label):
    stem = os.path.splitext(fname)[0]
    gray = townfit.load_image(os.path.join(fit.get('src', townfit.SRC), fname))
    H, W = gray.shape
    band = int(round(TITLE_BAND_UNITS * W / UNIT_WIDTH))
    img = np.full((H + band, W), 255, np.uint8)
    img[band:] = gray
    M = np.array(fit['M'])
    M[1, 2] += band
    boxes = []
    tsv = os.path.join(work, f'ocr_{stem}.tsv')
    if os.path.exists(tsv):
        for line in open(tsv, encoding='utf-8', errors='replace').read().splitlines()[1:]:
            p = line.split('\t')
            if len(p) >= 12 and p[11].strip() and float(p[10]) > 40:
                l, t, w_, h_ = map(int, p[6:10])
                boxes.append([l, t + band, l + w_, t + h_ + band])
    slug = re.sub(r'[^a-z0-9]+', '-', stem.lower()).strip('-')
    os.makedirs(os.path.join(outdir, 'plan'), exist_ok=True)
    Image.fromarray(img).save(os.path.join(outdir, 'plan', slug + '.png'), optimize=True)
    return {'id': f'plan-{slug}', 'kind': 'community', 'label': label, 'muni': None,
            'file': f'plan/{slug}.png', 'width': W, 'height': H + band,
            'affine': [float(v) for v in M.reshape(-1)], 'obstacles': boxes_inside(boxes, W, H + band)}


def plan_label(fname, places):
    """Community name: the CGN name for the file stem, else the stem."""
    stem = re.sub(r'_S?\d+$', '', os.path.splitext(fname)[0])
    norm = lambda s: re.sub(r'[^a-z]', '', s.lower().replace('saint', 'st').replace('sainte', 'ste'))
    i_n = places['fields'].index('name')
    hit = next((r[i_n] for r in places['rows'] if norm(r[i_n]) == norm(stem)), None)
    return hit or title_case(stem.replace('_', ' '))


def main():
    rm_work, town_work, review_path, outdir = sys.argv[1:5]
    review = json.load(open(review_path))
    places = json.load(open(os.path.join(townfit.WEB, 'public', 'mb-places.json')))
    maps = []
    for stem, verdict in sorted(review.get('rm', {}).items()):
        if verdict == 'ok':
            maps.append(build_rm(stem, json.load(open(os.path.join(rm_work, f'rm_{stem}.json'))), rm_work, outdir))
            print('rm', stem, flush=True)
    for fname, verdict in sorted(review.get('town', {}).items()):
        if verdict == 'ok':
            stem = os.path.splitext(fname)[0]
            fit = json.load(open(os.path.join(town_work, f'town_{stem}.json')))
            maps.append(build_plan(fname, fit, town_work, outdir, plan_label(fname, places)))
            print('plan', fname, flush=True)
    idx = {'version': 1, 'generated': datetime.date.today().isoformat(), 'maps': maps}
    with open(os.path.join(outdir, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(idx, f, separators=(',', ':'))
    print(len(maps), 'maps')


if __name__ == '__main__':
    main()
