#!/usr/bin/env python3
"""Print the mascot beside the word art, top-aligned.

The text keeps wordart.py's quadrant rendering, so it stays on one line and
the banner stays 5 rows -- the mascot's own height. Quadrants put two pixels
in a column where the mascot's half-blocks put one, so the lettering is drawn
at half the mascot's pixel scale. That is the trade being made here: matching
the stroke weight would double the text's width to 92 columns and force it
onto two lines, which is wider and taller than this fits in.

Under the word art sit two status lines of ordinary terminal text, not pixel
art, so they read at the font's own size rather than the lettering's.

Lines are padded by visible width, measured with the color escapes stripped,
since those bytes occupy no columns.
"""
import re
import shutil
import sys

import mascot
import wordart

GAP = 2       # columns between the mascot and the text
LINE_GAP = 1  # blank pixel rows between wrapped text lines
RESET = "\x1b[0m"
ANSI = re.compile(r"\x1b\[[0-9;]*m")

# The word art is 3 rows and the mascot is 5, so the two rows beside the
# mascot's face would otherwise sit empty -- the status lines fill them and
# the banner stays 5 rows tall.
LABEL = mascot.PALETTE["H"]  # same green as the lettering
VALUE = (150, 150, 150)      # dim grey, subordinate to the labels
SEP = (90, 90, 90)           # dimmer still: separators are not content

INFO = [("Pi", "v8.0"), ("Model:", "Claude Opus 5"), ("Effort:", "Max")]
PATH = "~/project"  # sample text for the preview, like INFO


def sgr(rgb, bold=False):
    return ("\x1b[1m" if bold else "") + "\x1b[38;2;%d;%d;%dm" % rgb


def status(pairs, path):
    """Two lines: bold green labels with dim values, then the path."""
    joined = (sgr(SEP) + " \u00b7 " + RESET).join(
        sgr(LABEL, True) + k + RESET + " " + sgr(VALUE) + v + RESET
        for k, v in pairs
    )
    return [joined, sgr(VALUE) + path + RESET]


def width(line):
    """Columns a rendered line occupies, ignoring SGR escapes."""
    return len(ANSI.sub("", line))


def wrap(text, budget):
    """Greedily split text into lines that fit budget pixel columns."""
    lines, cur = [], ""
    for word in text.split():
        trial = f"{cur} {word}".strip()
        if cur and wordart.line_width(trial) > budget:
            lines.append(cur)
            cur = word
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def stack(lines, gap=LINE_GAP):
    """Rasterize wrapped lines into one grid, left-aligned."""
    grids = [wordart.layout(l) for l in lines]
    w = max(len(g[0]) for g in grids)
    out = []
    for i, g in enumerate(grids):
        if i:
            out.extend([None] * w for _ in range(gap))
        out.extend(r + [None] * (w - len(r)) for r in g)
    return out


def beside(left, right, gap=GAP):
    """Join two blocks side by side, both flush to the top row."""
    rows_l, rows_r = left.split("\n"), right.split("\n")
    inner = max(width(r) for r in rows_l)
    out = []
    for i in range(max(len(rows_l), len(rows_r))):
        l = rows_l[i] if i < len(rows_l) else ""
        r = rows_r[i] if i < len(rows_r) else ""
        out.append(l + RESET + " " * (inner - width(l) + gap) + r)
    return "\n".join(out)


if __name__ == "__main__":
    text = " ".join(sys.argv[1:]) or "Security Research System"
    missing = {c for c in text.upper() if c != " "} - set(wordart.FONT)
    if missing:
        sys.exit("no glyph for: " + " ".join(sorted(missing)))

    art = mascot.render(mascot.parse(mascot.ART))
    mascot_cols = max(width(l) for l in art.split("\n"))
    # Quadrants pack two pixels into a column, so the pixel budget is twice
    # the column budget. Narrower terminals wrap onto more lines.
    budget = (shutil.get_terminal_size().columns - mascot_cols - GAP) * 2
    words = wordart.render_quad(stack(wrap(text, budget)))
    right = "\n".join(words.split("\n") + status(INFO, PATH))
    print(beside(art, right))
