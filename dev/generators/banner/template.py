#!/usr/bin/env python3
"""Emit visual/hud/banner.ts's TEMPLATE rows: the mascot beside the word art,
with every palette RGB replaced by its ROLE token (`{H}` …), so the banner can
fill the roles from the live theme at render time.

    python3 dev/banner/template.py "WAR DOGS"     # paste the output into TEMPLATE

Roles are mascot.PALETTE's keys; the word art rides H (ink), A (mid), G
(shadow). Rows 3-4 are the mascot alone — banner.ts appends the status lines.
"""
import json
import re
import sys

import banner
import mascot
import wordart

text = " ".join(sys.argv[1:]) or "WAR DOGS"
missing = {c for c in text.upper() if c != " "} - set(wordart.FONT)
if missing:
    sys.exit("no glyph for: " + " ".join(sorted(missing)))
art = mascot.render(mascot.parse(mascot.ART))
# Half-blocks, not quadrants: one pixel per column, the MASCOT's own scale —
# the quadrant form drew the lettering at half that and read thin beside it
# (maintainer, 2026-08-22). Eight letters fit; the old 24-letter phrase did not.
words = wordart.render_half(banner.stack(banner.wrap(text, 10_000)))
rows = banner.beside(art, words).split("\n")
roles = {v: k for k, v in mascot.PALETTE.items() if v}


def tok(m):
    rgb = (int(m.group(2)), int(m.group(3)), int(m.group(4)))
    return f"{m.group(1)};2;{{{roles[rgb]}}}"


for r in rows:
    print("\t" + json.dumps(re.sub(r"(38|48);2;(\d+);(\d+);(\d+)", tok, r), ensure_ascii=False) + ",")
