#!/usr/bin/env python3
"""Draws the iOS launch image: the launch loader's first frame, as a picture.

iOS shows the launch image the instant the icon is tapped, before a single
line of the app has run; `LaunchView` only appears once the app has started.
With a flat colour there, the loader seemed to arrive late. With this, the
loader is on screen from the first instant, and `LaunchView` takes over in
the same place and starts it turning.

So this has to be `LaunchLoader` (ios/Webyar/Sources/App/WebyarApp.swift)
at rest, to the pixel it can be: the same sizes, line widths, colours and
starting angles. It reads nothing from the Swift file — keep the numbers
below in step with it and run this again after changing either:

    python3 scripts/ios/render-launch-loader.py

Writes Assets.xcassets/LaunchLoader.imageset at 2x and 3x, light and dark
(the faint track is the brand blue at 10%, and the brand blue differs by
appearance). Needs Pillow.

Angles follow SwiftUI's: 0 at three o'clock, increasing clockwise, because
the y axis points down.
"""
import json
import math
import os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(
    os.path.dirname(__file__), '..', '..',
    'ios', 'Webyar', 'Resources', 'Assets.xcassets', 'LaunchLoader.imageset',
)

# LaunchLoader, in points.
CANVAS = 56          # room for the bead's glow beyond the ring
OUTER = 40           # outer ring diameter
INNER = 24           # inner arc diameter
OUTER_LINE = 2.5
INNER_LINE = 2.0
ARC = 0.32           # the comet's share of the circle
INNER_ARC = 0.22
COMET_ROTATION = -90 # `rotationEffect` of the comet at rest
INNER_ROTATION = 90  # `rotationEffect` of the inner arc at rest
BEAD = OUTER_LINE * 1.9
BEAD_GLOW = 3        # the bead's `shadow` radius

DEEP = (0.047, 0.314, 0.914)
CYAN = (0.180, 0.839, 1.000)
BRAND = {'light': (0.231, 0.478, 0.949), 'dark': (0.353, 0.580, 1.000)}  # Theme.Palette.brand

SUPERSAMPLE = 4


def lerp(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def comet_colour(t):
    """The comet's AngularGradient: deep at 0% opacity → deep at 55% → cyan."""
    if t <= 0.55:
        rgb, alpha = DEEP, t / 0.55
    else:
        rgb, alpha = lerp(DEEP, CYAN, (t - 0.55) / 0.45), 1.0
    return rgb, alpha


def over(dst, rgb, alpha):
    """Source-over onto a premultiplied (r, g, b, a) pixel."""
    r, g, b, a = dst
    return (rgb[0] * alpha + r * (1 - alpha), rgb[1] * alpha + g * (1 - alpha),
            rgb[2] * alpha + b * (1 - alpha), alpha + a * (1 - alpha))


def render(scale, appearance):
    px = CANVAS * scale * SUPERSAMPLE
    unit = scale * SUPERSAMPLE          # pixels per point
    centre = px / 2
    track_rgb = BRAND[appearance]

    def arc_hit(x, y, radius, line, start_deg, sweep_deg):
        """Where on the arc (0…1) the point falls, or None. Round caps."""
        dx, dy = x - centre, y - centre
        dist = math.hypot(dx, dy)
        half = line * unit / 2
        r = radius * unit
        angle = (math.degrees(math.atan2(dy, dx)) - start_deg) % 360
        if abs(dist - r) <= half and angle <= sweep_deg:
            return angle / sweep_deg
        for t, a in ((0.0, start_deg), (1.0, start_deg + sweep_deg)):
            ex, ey = centre + r * math.cos(math.radians(a)), centre + r * math.sin(math.radians(a))
            if math.hypot(x - ex, y - ey) <= half:
                return t
        return None

    pixels = []
    comet_sweep = ARC * 360
    for j in range(px):
        y = j + 0.5
        row = []
        for i in range(px):
            x = i + 0.5
            p = (0.0, 0.0, 0.0, 0.0)
            # The track: the whole outer circle, brand blue at 10%.
            if abs(math.hypot(x - centre, y - centre) - OUTER / 2 * unit) <= OUTER_LINE * unit / 2:
                p = over(p, track_rgb, 0.10)
            # The comet.
            t = arc_hit(x, y, OUTER / 2, OUTER_LINE, COMET_ROTATION, comet_sweep)
            if t is not None:
                rgb, alpha = comet_colour(t)
                p = over(p, rgb, alpha)
            # The inner arc: cyan at 55%.
            if arc_hit(x, y, INNER / 2, INNER_LINE, INNER_ROTATION, INNER_ARC * 360) is not None:
                p = over(p, CYAN, 0.55)
            row.append(p)
        pixels.append(row)

    image = Image.new('RGBA', (px, px))
    image.putdata([
        (round(r / a * 255) if a else 0, round(g / a * 255) if a else 0,
         round(b / a * 255) if a else 0, round(a * 255))
        for row in pixels for (r, g, b, a) in row
    ])

    # The bead at the comet's head, over its own soft glow.
    head = math.radians(COMET_ROTATION + comet_sweep)
    bx = centre + OUTER / 2 * unit * math.cos(head)
    by = centre + OUTER / 2 * unit * math.sin(head)
    bead_r = BEAD / 2 * unit
    cyan255 = tuple(round(c * 255) for c in CYAN)
    glow = Image.new('RGBA', (px, px), cyan255 + (0,))
    glow_mask = Image.new('L', (px, px), 0)
    ImageDraw.Draw(glow_mask).ellipse((bx - bead_r, by - bead_r, bx + bead_r, by + bead_r), fill=round(0.9 * 255))
    glow_mask = glow_mask.filter(ImageFilter.GaussianBlur(BEAD_GLOW * unit / 2))
    glow.putalpha(glow_mask)
    image = Image.alpha_composite(image, glow)
    bead = Image.new('RGBA', (px, px), cyan255 + (0,))
    bead_mask = Image.new('L', (px, px), 0)
    ImageDraw.Draw(bead_mask).ellipse((bx - bead_r, by - bead_r, bx + bead_r, by + bead_r), fill=255)
    bead.putalpha(bead_mask)
    image = Image.alpha_composite(image, bead)

    return image.resize((CANVAS * scale, CANVAS * scale), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    images = []
    for appearance in ('light', 'dark'):
        for scale in (2, 3):
            name = f'LaunchLoader-{appearance}@{scale}x.png'
            render(scale, appearance).save(os.path.join(OUT, name), optimize=True)
            entry = {'filename': name, 'idiom': 'universal', 'scale': f'{scale}x'}
            if appearance == 'dark':
                entry['appearances'] = [{'appearance': 'luminosity', 'value': 'dark'}]
            images.append(entry)
    with open(os.path.join(OUT, 'Contents.json'), 'w') as f:
        json.dump({'images': images, 'info': {'author': 'xcode', 'version': 1}}, f, indent=2)
        f.write('\n')
    print('wrote', os.path.normpath(OUT))


if __name__ == '__main__':
    main()
