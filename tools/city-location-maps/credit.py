"""Source credit on the city location maps.

The city pages come from the Manitoba Official Highway Map (Manitoba
Transportation and Infrastructure), Government of Manitoba information under
the OpenMB Information and Data Use Licence, which asks for a credit. This
adds a thin white band under each page with one line of credit, so every
location map made from it (Addenda Pack, Province Location Map panel) carries
the credit wherever it is pasted.

build.py calls add_credit() on each page it writes. Run this file directly to
stamp pages that were built before the credit existed, without refitting:

    python credit.py            # dry run: what would change
    python credit.py --apply    # rewrite web/public/city-*.svg and the heights
                                # and obstacles in web/src/lib/cityMapData.js

Idempotent: a page that already carries the credit is left alone.
"""
import os
import re
import sys

# Kept to ~100 characters: the font scales with page width, so this fills
# about 60% of any page's width (a longer line overflows narrow pages).
CREDIT = ('Base map: Manitoba Official Highway Map 2026 (Manitoba Transportation '
          'and Infrastructure), OpenMB licence')
# Same unit system as build.py's title band (UNIT_WIDTH units across the page).
CREDIT_BAND_UNITS, UNIT_WIDTH = 9, 380
MARKER = 'id="mb-highway-credit"'

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, '..', '..', 'web')

_ROOT = re.compile(r'<svg\b[^>]*>')


def _num(attr, tag):
    m = re.search(rf'\b{attr}="([\d.]+)"', tag)
    return float(m.group(1)) if m else None


def add_credit(svg):
    """Return (svg_with_credit, band_height_pt). band is 0 if already stamped."""
    if MARKER in svg:
        return svg, 0.0
    root = _ROOT.search(svg)
    if not root:
        raise ValueError('no <svg> root element')
    tag = root.group(0)
    w, h = _num('width', tag), _num('height', tag)
    band = CREDIT_BAND_UNITS * w / UNIT_WIDTH
    nh = h + band
    new_tag = re.sub(r'\bheight="[\d.]+"', f'height="{nh:.4f}"', tag)
    new_tag = re.sub(r'\bviewBox="0 0 [\d.]+ [\d.]+"', f'viewBox="0 0 {w:g} {nh:.4f}"', new_tag)
    size = band * 0.52
    text = (f'<rect x="0" y="{h:.4f}" width="{w:g}" height="{band:.4f}" fill="#ffffff"/>'
            f'<text {MARKER} x="{w - band * 0.6:.3f}" y="{h + band * 0.62:.3f}" text-anchor="end" '
            f'font-family="Arial, Helvetica, sans-serif" font-size="{size:.3f}" fill="#555555">'
            f'{CREDIT}</text>')
    out = svg[:root.start()] + new_tag + svg[root.end():]
    i = out.rindex('</svg>')
    return out[:i] + text + '\n' + out[i:], band


def credit_obstacle(width, height, band):
    """The band as a callout obstacle, in page points ([x0, y0, x1, y1])."""
    return [0.0, round(height, 1), round(width, 1), round(height + band, 1)]


def _apply_existing(write):
    pub = os.path.join(WEB, 'public')
    data_path = os.path.join(WEB, 'src', 'lib', 'cityMapData.js')
    js = open(data_path, encoding='utf-8').read()
    for fn in sorted(f for f in os.listdir(pub) if re.fullmatch(r'city-[a-z]+\.svg', f)):
        name = fn[5:-4]
        path = os.path.join(pub, fn)
        svg = open(path, encoding='utf-8').read()
        tag = _ROOT.search(svg).group(0)
        w, h = _num('width', tag), _num('height', tag)
        out, band = add_credit(svg)
        if not band:
            print(f'{name}: already credited')
            continue
        block = re.search(rf'(\n  {name}: \{{.*?\n  \}},)', js, re.S)
        if not block:
            raise SystemExit(f'{name}: no entry in cityMapData.js')
        b = block.group(1)
        nb = re.sub(r'height: [\d.]+,', f'height: {h + band:.3f},', b, count=1)
        ob = credit_obstacle(w, h, band)
        nb = nb.replace('    obstacles: [\n', f'    obstacles: [\n    [{ob[0]}, {ob[1]}, {ob[2]}, {ob[3]}],\n', 1)
        js = js.replace(b, nb)
        print(f'{name}: {w:g} x {h:.1f} pt -> +{band:.2f} pt credit band')
        if write:
            with open(path, 'w', encoding='utf-8', newline='\n') as f:
                f.write(out)
    if write:
        with open(data_path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(js)


if __name__ == '__main__':
    _apply_existing('--apply' in sys.argv)
