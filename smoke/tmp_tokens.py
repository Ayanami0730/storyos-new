#!/usr/bin/env python3
"""Dump the token inventory check-zh-prompts.py demands, for one file."""
import re
import sys
from collections import Counter
from pathlib import Path

FENCE = re.compile(r"```.*?```", re.DOTALL)
TICK = re.compile(r"`[^`\n]+`")
SNAKE = re.compile(r"\b[a-z]{3,}(?:_[a-z]+)+\b")
PATHY = re.compile(r"\b[\w.-]+/[\w./*-]+\b")
HEADING = re.compile(r"^#{1,6}\s+", re.MULTILINE)

text = Path(sys.argv[1]).read_text()
for kind, rx in (
    ("FENCE", FENCE),
    ("TICK", TICK),
    ("SNAKE", SNAKE),
    ("PATH", PATHY),
):
    c = Counter(rx.findall(text))
    print(f"=== {kind} ({len(c)} distinct, {sum(c.values())} total)")
    for tok, n in sorted(c.items()):
        print(f"  {n}x  {tok!r}")
print(f"=== HEADINGS: {len(HEADING.findall(text))}")
print(f"=== CHARS: {len(text)}")
