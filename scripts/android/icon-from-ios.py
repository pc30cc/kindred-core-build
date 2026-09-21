#!/usr/bin/env python3
"""Builds the Android launcher icon from the iOS app icon.

One mark, two platforms. `ios/.../AppIcon-1024.png` is the source of truth, so
the two can only differ by someone changing it and not re-running this.

It is not a resize, because the two platforms want different things. iOS draws
a square, full-bleed, and rounds the corners itself. Android hands the icon to
the launcher, which masks it to a circle, a squircle or a teardrop — and only
the middle 66% is guaranteed to survive. The W spans 85% of the source's
width, so a straight resize loses both of its ends to a circular mask.

WHAT WAS TRIED FIRST, because the obvious thing does not work: lifting the
white mark off its blue field and re-placing it smaller. The mark will not
lift. Its ribbons are shaded blue where they twist, so any rule that separates
"white mark" from "blue field" also cuts the mark into pieces — saturation,
luminance and the red channel all do. The rendering is unmistakable: the W
comes out in fragments.

So the artwork is kept whole and shrunk into the safe zone, and the field is
extended to fill the rest. The extension is a linear gradient sampled from the
source's own corners, and the artwork fades into it along a CIRCLE. That last
detail is the one that matters: every square-edged fade — feathered, blurred,
edge-replicated — left a faint rectangle visible inside the circular mask,
because the source carries a vignette and its edges do not match the extension
uniformly. A circular falloff cannot leave a straight edge.

A proper adaptive icon would draw the W as a vector on a transparent
foreground, and should, when whoever holds the source artwork can supply one.
This is the faithful version available without it.

Requires Pillow and numpy.  Usage: python3 scripts/android/icon-from-ios.py
"""
from pathlib import Path
import sys

try:
    from PIL import Image, ImageDraw
    import numpy as np
except ImportError:
    sys.exit("needs Pillow and numpy:  pip install Pillow numpy")

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "ios/WebyarNative/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
RES = ROOT / "android/app/src/main/res"

# Adaptive layers are 108dp square; the legacy launcher icon is 48dp.
ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

INNER = 0.68          # how much of the canvas the artwork occupies
R0, R1 = 0.82, 1.02   # opaque through the mark, gone before the corners
# Sampled from the source's own field, excluding the mark and the pale corner.
FIELD_BOTTOM_LEFT = (5, 56, 205)
FIELD_TOP_RIGHT = (50, 216, 252)


def field(size: int) -> Image.Image:
    """The gradient the artwork sits in, bottom-left deep to top-right bright."""
    out = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(out)
    for i in range(size * 2):
        t = i / (size * 2 - 1)
        draw.line(
            [(0, i), (i, 0)],
            fill=tuple(
                int(FIELD_BOTTOM_LEFT[k] + (FIELD_TOP_RIGHT[k] - FIELD_BOTTOM_LEFT[k]) * t)
                for k in range(3)
            ),
        )
    return out


def layer(src: Image.Image, size: int) -> Image.Image:
    inner = int(size * INNER)
    offset = (size - inner) // 2

    art = src.resize((inner, inner), Image.LANCZOS).convert("RGBA")
    yy, xx = np.mgrid[0:inner, 0:inner]
    centre = (inner - 1) / 2
    radius = np.sqrt((xx - centre) ** 2 + (yy - centre) ** 2) / (inner / 2)
    art.putalpha(Image.fromarray((np.clip((R1 - radius) / (R1 - R0), 0, 1) * 255).astype(np.uint8), "L"))

    out = field(size).convert("RGBA")
    out.alpha_composite(art, (offset, offset))
    return out


def main() -> None:
    src = Image.open(SOURCE)
    for density, size in ADAPTIVE.items():
        out = RES / f"mipmap-{density}"
        out.mkdir(parents=True, exist_ok=True)
        layer(src, size).convert("RGB").save(out / "ic_launcher_background.png")
        # No foreground: the mark cannot be separated from its field (see the
        # module note), so the whole composition is the background layer and
        # the foreground is left out of the adaptive XML entirely.
        for stale in ("ic_launcher_foreground.png",):
            (out / stale).unlink(missing_ok=True)

    for density, size in LEGACY.items():
        out = RES / f"mipmap-{density}"
        out.mkdir(parents=True, exist_ok=True)
        # Pre-Oreo launchers apply no mask, so the design's own rounded square
        # is the right shape there and the source goes in as it is.
        src.resize((size, size), Image.LANCZOS).convert("RGB").save(out / "ic_launcher.png")

    print("wrote adaptive background + legacy icons for " + ", ".join(ADAPTIVE))


if __name__ == "__main__":
    main()
