#!/usr/bin/env python3
"""Render the box soldier mascot in the terminal.

The art is hand-authored at 12x10 logical pixels -- a compact redraw of the
larger original, not a downsample of it -- and printed with half-block
characters (two pixels per terminal cell) in 24-bit color, so it occupies
12 columns by 5 rows.
"""
import sys

RESET = "\x1b[0m"

PALETTE = {
    ".": None,
    "C": (52, 96, 44),    # helmet edge
    "H": (89, 152, 73),   # helmet highlight
    "A": (69, 122, 54),   # helmet
    "E": (41, 82, 31),    # helmet shadow
    "J": (64, 116, 180),  # face edge
    "L": (92, 158, 224),  # face highlight
    "B": (58, 124, 196),  # face
    "G": (36, 92, 160),   # face shadow
    "F": (22, 62, 110),   # face deep shadow
    "K": (0, 0, 0),       # eyes
}

# The silhouette is mirror-symmetric; only the shading (H highlight on the
# left, E/G shadow on the right) is directional, lit from the upper left.
# Crown widths go 4, 8, 10 -- a wide jump that then eases off, which curves.
# A constant step per row draws a triangle and a repeated width draws a
# cylinder, so the dome depends on the taper changing. The 2x2 H patch is a
# specular highlight sitting on the dome, inset from the edge rather than
# hugging it. E shades one clean diagonal down the unlit side; broken up, it
# reads as dents bitten out of the rim. The face is twice as wide as it is
# tall, matching the original -- squarer than that and it reads as long.
#
# Both halves are lit from the upper left, so the L sheen sits opposite the
# G/F shadow and echoes the helmet's H patch. Shading the face from both
# sides instead only muddies it: at ten pixels wide there is room for one
# step per side, and the edge has to stay clearly lighter than the shadow.
ART = """\
....CCCC....
..CAHHAAEC..
.CAAHHAAAEC.
CCAAAAAAAECC
CCCCCCCCCCCC
.JLLBBBBBGJ.
.JLBKBBKBGJ.
.JBBKBBKBGJ.
.JBBBBBBBGJ.
.JJGGGGGFJJ.
"""


def parse(art):
    return [[PALETTE[c] for c in line] for line in art.splitlines() if line]


def render(grid):
    if len(grid) % 2:
        grid.append([None] * len(grid[0]))
    lines = []
    for top, bot in zip(grid[::2], grid[1::2]):
        out = []
        for t, b in zip(top, bot):
            if t is None and b is None:
                out.append(RESET + " ")
            elif b is None:
                out.append(RESET + "\x1b[38;2;%d;%d;%dm▀" % t)
            elif t is None:
                out.append(RESET + "\x1b[38;2;%d;%d;%dm▄" % b)
            else:
                out.append("\x1b[38;2;%d;%d;%d;48;2;%d;%d;%dm▀" % (t + b))
        lines.append("".join(out) + RESET)
    return "\n".join(lines)


if __name__ == "__main__":
    indent = " " * (int(sys.argv[1]) if len(sys.argv) > 1 else 0)
    print("\n".join(indent + line for line in render(parse(ART)).splitlines()))
