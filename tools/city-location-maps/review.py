"""Contact sheets for eyeballing town-plan fits: the scan with the
assessment parcels drawn on it (lots magenta, larger parcels cyan), four
sheets per image, name + fit numbers on each.

    python review.py <town workdir> <outdir> [<file> ...]   (default: all ok)
"""
import json, math, os, sys
import numpy as np, shapely
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import townfit, parcelref  # noqa: E402
from qa import inv_utm  # noqa: E402
from utm import utm14  # noqa: E402

THUMB = 880


def thumb(work, fname, ref):
    stem = os.path.splitext(fname)[0]
    r = json.load(open(os.path.join(work, f'town_{stem}.json')))
    gray = townfit.load_image(os.path.join(townfit.SRC, fname))
    H, W = gray.shape
    k = THUMB / W
    im = Image.fromarray(gray).convert('RGB').resize((THUMB, int(H * k)), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    if r.get('status') == 'ok':
        M = np.array(r['M'])
        Mi = np.linalg.inv(np.vstack([M, [0, 0, 1]]))[:2]
        ll = [inv_utm(*(Mi @ [x, y, 1])) for x, y in ((0, 0), (W, 0), (0, H), (W, H))]
        rings = parcelref.rings_in(ref, min(p[0] for p in ll), min(p[1] for p in ll), max(p[0] for p in ll), max(p[1] for p in ll))
        for rg in rings:
            small = np.ptp(rg[:, 0]) * 71000 < 300 and np.ptp(rg[:, 1]) * 111000 < 300
            P = [tuple(k * (M @ [*utm14(*p), 1])) for p in rg]
            d.line(P, fill=(230, 0, 230) if small else (0, 170, 220), width=1)
        txt = f"{fname}  {r.get('median_m')} m  labels {r.get('label_constraints')}  seed {r.get('seed')}  scale {r.get('m_per_px')}/{r.get('bar_m_per_px')}"
    else:
        txt = f"{fname}  {r.get('status')}"
    d.rectangle([0, 0, THUMB, 18], fill=(255, 255, 210))
    d.text((4, 3), txt, fill=(0, 0, 0))
    return im


def main():
    work, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    files = sys.argv[3:]
    if not files:
        for line in open(os.path.join(work, 'town_summary.tsv'), encoding='utf-8'):
            p = line.rstrip('\n').split('\t')
            if len(p) > 1 and p[1] == 'ok':
                files.append(p[0])
    ref = parcelref.load(work)
    for n in range(0, len(files), 4):
        ims = [thumb(work, f, ref) for f in files[n:n + 4]]
        h = max(i.height for i in ims[:2]) + (max(i.height for i in ims[2:]) if len(ims) > 2 else 0)
        sheet = Image.new('RGB', (THUMB * 2 + 6, h + 6), (90, 90, 90))
        for i, im in enumerate(ims):
            y = 0 if i < 2 else max(x.height for x in ims[:2]) + 6
            sheet.paste(im, ((i % 2) * (THUMB + 6), y))
        sheet.save(os.path.join(out, f'sheet_{n // 4:03d}.png'))
        print(n // 4, files[n:n + 4], flush=True)


if __name__ == '__main__':
    main()
