#!/usr/bin/env python3
"""Proposed scripts/fonts/subset-widget-fonts.py (prototype, scratch copy).

Splits Inter Medium (OFL; src/assets/fonts/inter-500.woff2, the dashboard's
copy) into unicode-range subsets for the widgets and prints the @font-face
block for public/widget/presentation-default-fonts.css. IRANSans is a licensed
font and is shipped byte-for-byte; this script only checks that the declared
IRANSans unicode-range covers every character the files have.

One-off, run by a developer when the font or the ranges change (the build
never runs it; its output is committed):
  python3 -m venv /tmp/ft && /tmp/ft/bin/pip install 'fonttools[woff]==4.67.0'
  /tmp/ft/bin/python scripts/fonts/subset-widget-fonts.py [repo-root] [out-dir]
"""
import os, sys
from fontTools.ttLib import TTFont
from fontTools import subset

ROOT = sys.argv[1] if len(sys.argv) > 1 else '.'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'public/widget/fonts')
INTER = os.path.join(ROOT, 'src/assets/fonts/inter-500.woff2')
IRANSANS = [os.path.join(ROOT, 'public/widget/fonts/iransans-%d.woff2' % w) for w in (400, 500, 700)]

def parse(spec):
    cps = set()
    for part in spec.replace(' ', '').upper().replace('U+', '').split(','):
        a, _, b = part.partition('-')
        cps.update(range(int(a, 16), int(b or a, 16) + 1))
    return cps

def fmt(cps):
    cps, out, i = sorted(cps), [], 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1: j += 1
        out.append('U+%04X' % cps[i] if i == j else 'U+%04X-%04X' % (cps[i], cps[j])); i = j + 1
    return ', '.join(out)

IRANSANS_RANGE = 'U+0000-00FF, U+02BC-02F3, U+0300-0323, U+0600-06FF, U+2000-2044, U+2202-2265, U+FB50-FDFF, U+FE70-FEFF'
SPLIT = [  # (file suffix, wanted characters); each later set loses what an earlier one took
    ('latin', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329,'
              'U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD,'
              'U+011E-011F, U+0130, U+015E-015F, U+20BA,'          # Turkish (a widget locale)
              'U+2190-2199, U+2264-2265, U+2713, U+25CF'),         # symbols in the widgets' own strings
    ('cyrillic-greek', 'U+0370-03FF, U+0400-052F, U+1C80-1C8A, U+1F00-1FFF, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F, U+2116, U+20B4'),
    ('latin-ext', 'U+0100-02FF, U+0300-036F, U+1D00-1DBF, U+1E00-1EFF, U+2070-209F, U+20A0-20C0, U+2100-218F,'
                  'U+2190-23FF, U+2C60-2C7F, U+A720-A7FF'),
]  # Left out on purpose: Private Use, enclosed alphanumerics, box drawing, dingbats/emoji (U+2600-27BF).

for path in IRANSANS:
    missing = set(TTFont(path).getBestCmap()) - parse(IRANSANS_RANGE)
    assert not missing, '%s has characters outside its unicode-range: %s' % (path, fmt(missing))

cmap = set(TTFont(INTER).getBestCmap())
taken, faces = set(), []
for suffix, spec in SPLIT:
    cps = (parse(spec) & cmap) - taken
    taken |= cps
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features += ['tnum', 'pnum']            # font-variant-numeric: tabular-nums
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14]  # keeps the copyright and OFL notice
    opts.hinting = False
    opts.notdef_outline = True
    font = TTFont(INTER, recalcTimestamp=False)          # deterministic bytes
    s = subset.Subsetter(opts); s.populate(unicodes=cps); s.subset(font)
    name = 'inter-500-%s.woff2' % suffix
    font.flavor = 'woff2'; font.save(os.path.join(OUT, name))
    faces.append((name, fmt(cps), os.path.getsize(os.path.join(OUT, name)), len(cps)))

# Latin last: a browser that ignored unicode-range would use the last face.
for name, rng, size, n in sorted(faces, key=lambda f: f[0] == 'inter-500-latin.woff2'):
    print("@font-face {\n  font-family: 'InterWY'; font-style: normal; font-weight: 500; font-display: swap;\n"
          "  src: url(fonts/%s) format('woff2');\n  unicode-range: %s;\n}  /* %d bytes, %d characters */" % (name, rng, size, n))
