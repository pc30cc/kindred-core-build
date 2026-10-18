#!/usr/bin/env python3
"""scripts/fonts/subset-widget-fonts.py

Splits Inter Medium (OFL; src/assets/fonts/inter-500.woff2, the dashboard's
copy) into unicode-range subsets for the widgets and prints the @font-face
block for public/widget/presentation-default-fonts.css. IRANSans is a licensed
font and is shipped byte-for-byte; this script only checks that the declared
IRANSans unicode-range covers every character the files have.

With --figtree it also cuts Figtree (OFL 1.1, no Reserved Font Name, so a
subset keeps the name; licence: public/widget/fonts/OFL-Figtree.txt), the
Latin face of the International edition's t1-intl / t2-intl skins, from the
variable files (wght 300-900) of the npm package
@fontsource-variable/figtree@5.2.10 (`npm pack` it and pass its `files`
folder; their SHA-256 is checked below, so the output is always the same):
  - figtree-latin.woff2: Basic Latin, Latin-1, the punctuation and symbols an
    English or Turkish panel draws (with Turkish dotless i), every weight in
    one file. Combining marks are left out (about 0.8 KB, never drawn by the
    widget's own text).
  - figtree-tr.woff2: the rest of Turkish (G/S with breve and cedilla, the
    dotted capital I), its own file, so an English first paint fetches the
    Latin file only (18.5 KB; one file with Turkish would cost every English
    visitor about 1-2 KB more).
Each file is declared once per weight the skins use (400, 500, 600, 700,
800), all pointing at the same URL: the browser fetches it once and draws
every weight from its wght axis.

One-off, run by a developer when the font or the ranges change (the build
never runs it; its output is committed):
  python3 -m venv /tmp/ft && /tmp/ft/bin/pip install 'fonttools[woff]==4.67.0'
  /tmp/ft/bin/python scripts/fonts/subset-widget-fonts.py [repo-root] [out-dir] [--figtree <package>/files]
"""
import hashlib, os, sys
from fontTools.ttLib import TTFont
from fontTools import subset

ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
FIGTREE = sys.argv[sys.argv.index('--figtree') + 1] if '--figtree' in sys.argv else None
if FIGTREE: ARGS.remove(FIGTREE)
ROOT = ARGS[0] if len(ARGS) > 0 else '.'
OUT = ARGS[1] if len(ARGS) > 1 else os.path.join(ROOT, 'public/widget/fonts')
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

# ─── Figtree (International skins) ─────────────────────────────────────────
FIGTREE_SOURCES = {  # @fontsource-variable/figtree@5.2.10, files/
    'latin': ('figtree-latin-wght-normal.woff2', '4ba7d3d096695818fe0686be4f1e82c6b05134e18a22260336130335027462dd'),
    'tr': ('figtree-latin-ext-wght-normal.woff2', 'bf7828e2c258cffcfa50a048ee388a36b95bc16b452e8d36fa797635dbe15965'),
}
FIGTREE_SPLIT = [  # (file suffix, wanted characters), disjoint
    ('tr', 'U+011E-011F, U+0130, U+015E-015F'),
    ('latin', 'U+0020-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122'),
]
FIGTREE_WEIGHTS = (400, 500, 600, 700, 800)
TURKISH = 'çÇğĞıİöÖşŞüÜ'

if FIGTREE:
    faces = []
    for suffix, spec in FIGTREE_SPLIT:
        src_name, digest = FIGTREE_SOURCES[suffix]
        src = os.path.join(FIGTREE, src_name)
        with open(src, 'rb') as fh:
            got = hashlib.sha256(fh.read()).hexdigest()
        assert got == digest, '%s is not the expected @fontsource-variable/figtree@5.2.10 file (%s)' % (src, got)
        font = TTFont(src, recalcTimestamp=False)
        cps = parse(spec) & set(font.getBestCmap())
        opts = subset.Options()
        opts.flavor = 'woff2'
        opts.layout_features += ['tnum', 'pnum']
        opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14]  # the copyright and OFL notice (fvar's names are kept too)
        opts.hinting = False
        opts.notdef_outline = True
        s = subset.Subsetter(opts); s.populate(unicodes=cps); s.subset(font)
        assert 'fvar' in font and 'gvar' in font, 'the subset lost its weight axis'
        name = 'figtree-%s.woff2' % suffix
        font.flavor = 'woff2'; font.save(os.path.join(OUT, name))
        faces.append((name, fmt(cps), os.path.getsize(os.path.join(OUT, name)), len(cps), cps))
    covered = set().union(*(f[4] for f in faces))
    missing = [ch for ch in TURKISH + 'AZaz09' if ord(ch) not in covered]
    assert not missing, 'Figtree subsets miss %s' % ''.join(missing)
    assert not faces[0][4] & faces[1][4], 'the Figtree subsets overlap'
    # Latin last in each weight: a browser that ignored unicode-range would use the last face.
    for weight in FIGTREE_WEIGHTS:
        for name, rng, size, n, _ in faces:
            print("@font-face {\n  font-family: 'Figtree'; font-style: normal; font-weight: %d; font-display: swap;\n"
                  "  src: url(fonts/%s) format('woff2');\n  unicode-range: %s;\n}  /* %d bytes, %d characters */" % (weight, name, rng, size, n))
