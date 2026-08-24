#!/usr/bin/env python3
"""Render ANSI pane output from stdin as a documentation PNG."""

import re
import sys
from PIL import Image, ImageDraw, ImageFont

ANSI = re.compile(r"\x1b\[([0-9;]*)m")
BACKGROUND = (39, 43, 51)
FOREGROUND = (224, 224, 224)
DIM = (139, 139, 139)
FONT_PATH = "/System/Library/Fonts/SFNSMono.ttf"


def runs(line):
    foreground = FOREGROUND
    background = BACKGROUND
    bold = False
    dim = False
    cursor = 0
    column = 0
    for match in ANSI.finditer(line):
        if match.start() > cursor:
            text = line[cursor:match.start()]
            yield column, text, foreground, background, bold, dim
            column += len(text)
        codes = [int(value) if value else 0 for value in match.group(1).split(";")]
        index = 0
        while index < len(codes):
            code = codes[index]
            if code == 0:
                foreground, background, bold, dim = FOREGROUND, BACKGROUND, False, False
            elif code == 1:
                bold = True
            elif code == 2:
                dim = True
            elif code == 22:
                bold = dim = False
            elif code == 38 and codes[index:index + 2] == [38, 2] and index + 4 < len(codes):
                foreground = tuple(codes[index + 2:index + 5])
                index += 4
            elif code == 48 and codes[index:index + 2] == [48, 2] and index + 4 < len(codes):
                background = tuple(codes[index + 2:index + 5])
                index += 4
            index += 1
        cursor = match.end()
    if cursor < len(line):
        yield column, line[cursor:], foreground, background, bold, dim


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: render-terminal-capture.py OUTPUT.png COLUMNS")
    output, columns_text = sys.argv[1:]
    columns = int(columns_text)
    source = sys.stdin.read().replace("\r", "")
    lines = source.splitlines()
    font = ImageFont.truetype(FONT_PATH, 20)
    bold_font = ImageFont.truetype(FONT_PATH, 20)
    cell_width = int(round(font.getlength("M")))
    cell_height = 29
    margin = 18
    title_height = 42
    width = margin * 2 + columns * cell_width
    height = margin * 2 + title_height + max(1, len(lines)) * cell_height
    image = Image.new("RGB", (width, height), (24, 27, 33))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((3, 3, width - 4, height - 4), radius=12, fill=BACKGROUND, outline=(84, 84, 84), width=2)
    draw.text((margin, 12), f"Herdr GitRail · live pane · {columns} columns", font=font, fill=(214, 176, 91))
    origin_y = margin + title_height
    for row, line in enumerate(lines):
        y = origin_y + row * cell_height
        for column, text, foreground, background, bold, dim in runs(line):
            if not text or column >= columns:
                continue
            text = text[:max(0, columns - column)]
            x = margin + column * cell_width
            if background != BACKGROUND:
                draw.rectangle((x, y, x + len(text) * cell_width, y + cell_height), fill=background)
            color = DIM if dim and foreground == FOREGROUND else foreground
            draw.text((x, y), text, font=bold_font if bold else font, fill=color)
    image.save(output, optimize=True)


if __name__ == "__main__":
    main()
