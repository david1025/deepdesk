#!/usr/bin/env python3
"""Package a built macOS app with DeepDesk's Finder installation layout."""

import argparse
from pathlib import Path
import plistlib
import tempfile

import dmgbuild
from PIL import Image, ImageDraw, ImageFilter, ImageFont

WINDOW_WIDTH = 544
WINDOW_HEIGHT = 328
APP_X = 147
APPLICATIONS_X = 397
ICON_Y = 144


def draw_background(path: Path, scale: int) -> None:
    width, height = WINDOW_WIDTH * scale, WINDOW_HEIGHT * scale
    canvas = Image.new("RGB", (width, height))
    base = ImageDraw.Draw(canvas)
    top = (201, 217, 250)
    middle = (241, 246, 255)
    bottom = (229, 225, 247)
    for y in range(height):
        t = y / (height - 1)
        start, end = (top, middle) if t < 0.57 else (middle, bottom)
        fraction = t / 0.57 if t < 0.57 else (t - 0.57) / 0.43
        color = tuple(round(a + (b - a) * fraction) for a, b in zip(start, end))
        base.line((0, y, width, y), fill=color)

    # A soft blue highlight behind the icons keeps the center light and legible.
    alpha = Image.new("L", canvas.size)
    highlights = ImageDraw.Draw(alpha)
    highlights.ellipse(
        (35 * scale, -130 * scale, 520 * scale, 210 * scale),
        fill=180,
    )
    tint = Image.new("RGB", canvas.size, (225, 240, 255))
    canvas = Image.composite(tint, canvas, alpha.filter(ImageFilter.GaussianBlur(56 * scale)))
    draw = ImageDraw.Draw(canvas)

    x0, x1 = 233 * scale, 306 * scale
    center = ICON_Y * scale
    thickness = 4 * scale
    for x in range(x0, x1):
        t = (x - x0) / (x1 - x0)
        color = (round(199 - 124 * t), round(215 - 110 * t), round(249 - 24 * t))
        draw.line((x, center - thickness // 2, x, center + thickness // 2), fill=color)
    tip_color = (75, 105, 225)
    head = [(297 * scale, 134 * scale), (309 * scale, center), (297 * scale, 154 * scale)]
    draw.line(head, fill=tip_color, width=thickness, joint="curve")

    english = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", 15 * scale)
    chinese = ImageFont.truetype("/System/Library/Fonts/Hiragino Sans GB.ttc", 13 * scale)
    draw.text(
        (width // 2, 246 * scale), "Drag DeepSeek to Applications",
        font=english, fill=(52, 65, 104), anchor="mm",
    )
    draw.text(
        (width // 2, 270 * scale), "拖动 DeepSeek 到 Applications 完成安装",
        font=chinese, fill=(66, 80, 117), anchor="mm",
    )
    canvas.save(path, dpi=(72 * scale, 72 * scale))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, help="Path to the built DeepSeek.app")
    parser.add_argument("output", type=Path, help="Path for the new .dmg")
    args = parser.parse_args()
    app = args.app.resolve()
    output = args.output.resolve()
    plist = app / "Contents" / "Info.plist"
    if app.suffix != ".app" or not plist.is_file():
        parser.error("app must be a built .app with Contents/Info.plist")
    if output.suffix != ".dmg" or output.exists():
        parser.error("output must be a new .dmg path")

    with plist.open("rb") as handle:
        info = plistlib.load(handle)
    version = info.get("DeepDeskReleaseVersion") or info["CFBundleShortVersionString"]
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="deepdesk-dmg-") as tmp:
        background = Path(tmp) / "Install.png"
        draw_background(background, 1)
        draw_background(background.with_name("Install@2x.png"), 2)
        dmgbuild.build_dmg(
            str(output),
            f"DeepDesk {version}",
            settings={
                "format": "UDZO",
                "files": [str(app)],
                "symlinks": {"Applications": "/Applications"},
                "background": str(background),
                "window_rect": ((160, 140), (WINDOW_WIDTH, WINDOW_HEIGHT)),
                "icon_locations": {app.name: (APP_X, ICON_Y), "Applications": (APPLICATIONS_X, ICON_Y)},
                "icon_size": 104,
                "text_size": 15,
            },
        )
    print(output)


if __name__ == "__main__":
    main()
