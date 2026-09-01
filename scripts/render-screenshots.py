#!/usr/bin/env python3
"""Render the deterministic GitRail demo into the documentation screenshots.

Maintainer tool. `npm run screenshots:verify` needs neither this script nor its
one dependency; it only compares committed PNG bytes and deterministic terminal
output. Regenerate with:

    python3 -m pip install --user pillow
    python3 scripts/render-screenshots.py

The reference palette below is what a conventional dark terminal theme resolves
GitRail's indexed colors to. GitRail itself pins no 24-bit colors; see
docs/THEMING.md.
"""

import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "docs" / "screenshots"
FONT = "/System/Library/Fonts/Menlo.ttc"
# Menlo has no U+2442 BRANCH or U+29C9 TWO JOINED SQUARES, so fall back the way
# a terminal does rather than drawing .notdef boxes.
FALLBACK_FONT = "/System/Library/Fonts/Apple Symbols.ttf"

WIDTHS = (36, 52, 100)
ROWS = 69
CELL_W = 12
CELL_H = 29
PAD_X = 18
CANVAS_H = 2108
CAPTION_Y = 16
CONTENT_Y = 64
RADIUS = 14

PAGE_BG = (0x18, 0x1B, 0x21)
PANEL_BG = (0x27, 0x2B, 0x33)
DEFAULT_FG = (0xE0, 0xE0, 0xE0)

INDEXED = {
    0: (0x1B, 0x1E, 0x24), 1: (0xE0, 0x6C, 0x75), 2: (0x5B, 0xBE, 0x70),
    3: (0xD6, 0xB0, 0x5B), 4: (0x69, 0xA9, 0xE6), 5: (0xBE, 0x84, 0xDC),
    6: (0x56, 0xB6, 0xC2), 7: (0x8B, 0x8B, 0x8B), 8: (0x54, 0x54, 0x54),
    9: (0xFF, 0x7B, 0x86), 10: (0x7F, 0xD8, 0x8F), 11: (0xE5, 0xB4, 0x54),
    12: (0x82, 0xBD, 0xFF), 13: (0xD2, 0x9B, 0xEC), 14: (0x6F, 0xD3, 0xDE),
    15: (0xFF, 0xFF, 0xFF),
}


def snapshot(columns):
    result = subprocess.run(
        [
            "node", "scripts/git-rail.mjs", "--demo", "--snapshot",
            "--width", str(columns), "--height", str(ROWS),
        ],
        cwd=ROOT, capture_output=True, check=True, text=True,
    )
    return result.stdout


def parse(text):
    """Turn the last rendered frame into rows of (character, style) cells."""
    frame = text.split("\u001b[?2026h\u001b[H")[-1]
    rows = []
    style = {"fg": None, "bg": None, "bold": False, "dim": False, "reverse": False}
    for raw in frame.split("\n"):
        cells = []
        index = 0
        while index < len(raw):
            if raw[index] == "\u001b" and raw[index + 1:index + 2] == "[":
                end = index + 2
                while end < len(raw) and raw[end] not in "ABCDEFGHJKSTfhilmnsu":
                    end += 1
                if end < len(raw) and raw[end] == "m":
                    style = apply_sgr(style, raw[index + 2:end])
                index = end + 1
                continue
            if raw[index] in "\r":
                index += 1
                continue
            cells.append((raw[index], dict(style)))
            index += 1
        rows.append(cells)
    return rows[:ROWS]


def apply_sgr(style, body):
    style = dict(style)
    codes = [int(part) for part in body.split(";") if part.isdigit()] or [0]
    index = 0
    while index < len(codes):
        code = codes[index]
        if code == 0:
            style = {"fg": None, "bg": None, "bold": False, "dim": False, "reverse": False}
        elif code == 1:
            style["bold"] = True
        elif code == 2:
            style["dim"] = True
        elif code == 7:
            style["reverse"] = True
        elif code in (38, 48) and codes[index + 1:index + 2] == [5]:
            style["fg" if code == 38 else "bg"] = INDEXED.get(codes[index + 2], DEFAULT_FG)
            index += 2
        elif code in (38, 48) and codes[index + 1:index + 2] == [2]:
            style["fg" if code == 38 else "bg"] = tuple(codes[index + 2:index + 5])
            index += 4
        index += 1
    return style


def blend(color, other, ratio):
    return tuple(round(a + (b - a) * ratio) for a, b in zip(color, other))


def glyph_font(character, regular, bold, fallback, style, cache):
    """Pick a face that actually has the glyph, mirroring terminal fallback."""
    key = (character, style["bold"])
    if key not in cache:
        face = bold if style["bold"] else regular
        drawn = bytes(face.getmask(character))
        cache[key] = fallback if drawn == bytes(face.getmask("￿")) else face
    return cache[key]


def render(columns, rows):
    width = columns * CELL_W + PAD_X * 2
    image = Image.new("RGB", (width, CANVAS_H), PAGE_BG)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([0, 0, width - 1, CANVAS_H - 1], RADIUS, fill=PANEL_BG)
    regular = ImageFont.truetype(FONT, 20)
    bold = ImageFont.truetype(FONT, 20, index=1)
    fallback = ImageFont.truetype(FALLBACK_FONT, 18)
    faces = {}

    caption = f"Herdr GitRail · demo fixture · {columns} columns"
    while caption and regular.getlength(caption) > columns * CELL_W:
        caption = caption.rsplit(" · ", 1)[0] if " · " in caption else caption[:-1]
    draw.text((PAD_X, CAPTION_Y), caption, font=regular, fill=INDEXED[3])

    for row, cells in enumerate(rows):
        top = CONTENT_Y + row * CELL_H
        for column, (character, style) in enumerate(cells[:columns]):
            foreground = style["fg"] or DEFAULT_FG
            background = style["bg"] or PANEL_BG
            if style["reverse"]:
                foreground, background = background, foreground
            if style["dim"]:
                foreground = blend(foreground, background, 0.45)
            left = PAD_X + column * CELL_W
            if background != PANEL_BG:
                draw.rectangle([left, top, left + CELL_W - 1, top + CELL_H - 1], fill=background)
            if character != " ":
                face = glyph_font(character, regular, bold, fallback, style, faces)
                offset = 0 if face is not fallback else max(0, (CELL_W - round(face.getlength(character))) // 2)
                draw.text((left + offset, top + 3), character, font=face, fill=foreground)
    return image


def main():
    if not Path(FONT).exists():
        sys.exit(f"missing monospace font: {FONT}")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for columns in WIDTHS:
        image = render(columns, parse(snapshot(columns)))
        destination = OUTPUT / f"gitrail-{columns}.png"
        image.save(destination, optimize=True)
        print(f"{destination.relative_to(ROOT)} {image.width}x{image.height}")


if __name__ == "__main__":
    main()
