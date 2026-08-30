#!/usr/bin/env python3
"""Render a phrase as three-line pixel word art in the terminal.

Depth is a hard drop shadow: the glyph is drawn again one pixel down and one
pixel right, behind the letter, in blue. Green reads as the lit face, blue as
what falls behind it. The font is 4 pixels tall and the shadow adds a fifth
row, so the art is always exactly 3 terminal rows.

Width is the tight constraint. Half-block characters pack two pixels per cell
vertically but only one horizontally, putting this phrase at 90 columns --
past a standard 80. Quadrant blocks pack 2x2 and halve it to 45, which is the
default. A quadrant cell carries only two colors though, and a drop shadow
puts green, blue and background in the same cell about a quarter of the time;
those cells keep the letter and drop the shadow pixel, so the shadow thins
slightly but the letterforms stay exact. Pass --wide for the half-block
version, which is pixel-exact at the cost of wrapping under 90 columns.
"""
import sys

import mascot

RESET = "\x1b[0m"

# Pulled from the mascot rather than copied as literals: retuning its palette
# silently left these behind once already, and hardcoded values give no hint
# they have gone stale. Ink is the helmet highlight, shadow the face's shadow
# blue -- the same role there as here.
INK = mascot.PALETTE["H"]
MID = mascot.PALETTE["A"]
SHADOW = mascot.PALETTE["G"]

# Color per glyph row. The switch from INK to MID falls on the boundary
# between quadrant cell rows, so no cell ever holds both and the letter costs
# no more accuracy than a flat one would. Darkening only the last row instead
# would straddle that boundary, and a cell forced to drop one of them loses
# part of a glyph rather than part of the shadow.
BANDS = [INK, INK, MID, MID]
# When a quadrant cell cannot hold every color, earlier entries win. Letter
# before shadow: the shadow can erode, the letterforms cannot.
PRIORITY = [INK, MID, SHADOW]

# 3x4 glyphs; '#' is ink. Deliberately compact -- the drop shadow adds a row
# and a column, so the letters themselves have to stay small to fit 3 rows.
FONT = {
    "A": [".#.", "#.#", "###", "#.#"],
    "C": [".##", "#..", "#..", ".##"],
    "E": ["###", "#..", "##.", "###"],
    "H": ["#.#", "#.#", "###", "#.#"],
    "I": ["###", ".#.", ".#.", "###"],
    "M": ["#.#", "###", "#.#", "#.#"],
    "R": ["##.", "#.#", "##.", "#.#"],
    "S": [".##", "#..", "..#", "##."],
    "T": ["###", ".#.", ".#.", ".#."],
    "U": ["#.#", "#.#", "#.#", "###"],
    "Y": ["#.#", "#.#", ".#.", ".#."],
    # 2026-08-22, for "WAR DOGS". W is five wide: at three, it is H's twin.
    "D": ["##.", "#.#", "#.#", "##."],
    "G": [".##", "#..", "#.#", ".##"],
    "O": [".#.", "#.#", "#.#", ".#."],
    "W": ["#.#.#", "#.#.#", "#.#.#", ".#.#."],
}
GAP = 1        # blank columns between glyphs
WORD_GAP = 2   # blank columns between words


def line_width(text):
    """Pixel columns text will occupy, including the shadow's overhang."""
    return 1 + sum(
        WORD_GAP if ch == " " else len(FONT[ch.upper()][0]) + (GAP if i < len(text) - 1 else 0)
        for i, ch in enumerate(text)
    )


def layout(text, bands=None):
    """Rasterize text to a 5-row grid of RGB-or-None, shadow behind ink.

    bands gives a color per glyph row; see BANDS for why the split sits where
    it does. A caller can override it, but a split that does not land on a
    quadrant cell-row boundary costs accuracy.
    """
    bands = bands or BANDS
    text = text.upper()
    width = 1  # the shadow overhangs one column past the last glyph
    for i, ch in enumerate(text):
        width += WORD_GAP if ch == " " else len(FONT[ch][0]) + (GAP if i < len(text) - 1 else 0)
    grid = [[None] * width for _ in range(5)]
    x = 0
    for ch in text:
        if ch == " ":
            x += WORD_GAP
            continue
        glyph = FONT[ch]
        for j, line in enumerate(glyph):          # shadow first, behind
            for i, p in enumerate(line):
                if p == "#":
                    grid[j + 1][x + i + 1] = SHADOW
        for j, line in enumerate(glyph):          # ink over it
            for i, p in enumerate(line):
                if p == "#":
                    grid[j][x + i] = bands[j]
        x += len(glyph[0]) + GAP
    return grid


def pad(grid, rows, cols):
    for r in grid:
        r.extend([None] * (cols - len(r)))
    while len(grid) < rows:
        grid.append([None] * cols)
    return grid


def render_half(grid):
    """Two pixels per cell stacked vertically, each its own color: exact."""
    w = max(len(r) for r in grid)
    grid = pad([list(r) for r in grid], (len(grid) + 1) // 2 * 2, w)
    out = []
    for top, bot in zip(grid[::2], grid[1::2]):
        line = []
        for t, b in zip(top, bot):
            if t is None and b is None:
                line.append(RESET + " ")
            elif b is None:
                line.append(RESET + "\x1b[38;2;%d;%d;%dm▀" % t)
            elif t is None:
                line.append(RESET + "\x1b[38;2;%d;%d;%dm▄" % b)
            else:
                line.append("\x1b[38;2;%d;%d;%d;48;2;%d;%d;%dm▀" % (t + b))
        out.append("".join(line) + RESET)
    return "\n".join(out)


# Quadrant glyphs indexed by a 4-bit mask: 1=top-left 2=top-right
# 4=bottom-left 8=bottom-right. A set bit takes the foreground color.
QUAD = " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█"


def render_quad(grid):
    """2x2 pixels per cell -- half the width, at some cost to the shadow.

    A cell holds one foreground and one background color. Two inks with no
    background pixel still draw exactly, as ink-on-ink. Two inks plus
    background cannot, so PRIORITY decides: the letter survives whole and the
    shadow gives up the pixel, which erodes the shadow rather than putting
    holes in the glyphs or flooding the cell with blue.
    """
    w = max(len(r) for r in grid)
    w += w % 2
    grid = pad([list(r) for r in grid], (len(grid) + 1) // 2 * 2, w)
    out = []
    for top, bot in zip(grid[::2], grid[1::2]):
        line = []
        for x in range(0, w, 2):
            quad = [top[x], top[x + 1], bot[x], bot[x + 1]]
            inks = [c for c in PRIORITY if c in quad]
            if not inks:
                line.append(RESET + " ")
                continue
            fg = inks[0]
            bg = inks[1] if len(inks) > 1 and None not in quad else None
            mask = sum(1 << i for i, c in enumerate(quad) if c == fg)
            style = "\x1b[38;2;%d;%d;%dm" % fg
            if bg:
                style += "\x1b[48;2;%d;%d;%dm" % bg
            line.append(RESET + style + QUAD[mask])
        out.append("".join(line) + RESET)
    return "\n".join(out)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--wide"]
    text = " ".join(args) if args else "Security Research System"
    missing = {c for c in text.upper() if c != " "} - set(FONT)
    if missing:
        sys.exit("no glyph for: " + " ".join(sorted(missing)))
    grid = layout(text)
    print((render_half if "--wide" in sys.argv else render_quad)(grid))
