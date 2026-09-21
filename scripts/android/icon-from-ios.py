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
MONO_SCALE = 0.60     # the themed-icon silhouette, inside the same safe zone
MONO_SAT = 0.28       # a silhouette wants a generous threshold, not a precise one
MIN_STROKE = 5000     # the W is three ribbons; keeping one gave a W in fragments
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


def silhouette(src: Image.Image) -> Image.Image:
    """The W as a solid shape, for Android 13's themed icons.

    This is the one thing the mark CAN be reduced to. A silhouette does not
    care that the ribbons are shaded — only where their outline is — so the
    threshold can be generous where a colour lift could not be. All three
    strokes are kept, which is exactly what the failed colour attempt got
    wrong by keeping only the largest.
    """
    from collections import deque

    a = np.asarray(src.convert("RGB")).astype(np.float32)
    mx, mn = a.max(axis=2), a.min(axis=2)
    solid = np.where(mx == 0, 0.0, (mx - mn) / np.maximum(mx, 1e-6)) < MONO_SAT
    h, w = solid.shape

    seen = np.zeros_like(solid)
    keep = np.zeros_like(solid)
    for sy in range(h):
        for sx in range(w):
            if not solid[sy, sx] or seen[sy, sx]:
                continue
            q, comp = deque([(sy, sx)]), []
            seen[sy, sx] = True
            while q:
                y, x = q.popleft()
                comp.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and solid[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            if len(comp) >= MIN_STROKE:
                ys, xs = zip(*comp)
                keep[np.array(ys), np.array(xs)] = True

    outside = np.zeros_like(keep)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not keep[y, x] and not outside[y, x]:
                outside[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if not keep[y, x] and not outside[y, x]:
                outside[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not keep[ny, nx] and not outside[ny, nx]:
                outside[ny, nx] = True
                q.append((ny, nx))

    mask = Image.fromarray(((keep | ~outside) * 255).astype(np.uint8), "L")
    shape = Image.new("RGBA", src.size, (255, 255, 255, 0))
    shape.putalpha(mask)
    return shape.crop(mask.getbbox())


def main() -> None:
    src = Image.open(SOURCE)
    mono = silhouette(src)
    for density, size in ADAPTIVE.items():
        out = RES / f"mipmap-{density}"
        out.mkdir(parents=True, exist_ok=True)
        layer(src, size).convert("RGB").save(out / "ic_launcher_background.png")
        # No foreground: the mark cannot be separated from its field (see the
        # module note), so the whole composition is the background layer and
        # the foreground is left out of the adaptive XML entirely.
        for stale in ("ic_launcher_foreground.png",):
            (out / stale).unlink(missing_ok=True)

        # Android 13 tints this with the wallpaper's palette, so it must be a
        # shape on transparency and nothing else — no colour, no field.
        canvas = Image.new("RGBA", (size, size), (255, 255, 255, 0))
        target = int(size * MONO_SCALE)
        shape = mono.copy()
        shape.thumbnail((target, target), Image.LANCZOS)
        canvas.paste(shape, ((size - shape.width) // 2, (size - shape.height) // 2), shape)
        canvas.save(out / "ic_launcher_monochrome.png")

    for density, size in LEGACY.items():
        out = RES / f"mipmap-{density}"
        out.mkdir(parents=True, exist_ok=True)
        # Pre-Oreo launchers apply no mask, so the design's own rounded square
        # is the right shape there and the source goes in as it is.
        src.resize((size, size), Image.LANCZOS).convert("RGB").save(out / "ic_launcher.png")

    print("wrote adaptive background + monochrome + legacy icons for " + ", ".join(ADAPTIVE))


if __name__ == "__main__":
    main()
