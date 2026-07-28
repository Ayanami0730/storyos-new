#!/usr/bin/env python3
"""How much harness-facing annotation is shipping inside the manuscripts?

The consistency audit's largest single subtype is `style_shifts`, 30 of ~97 kept
instances, and reading them shows they are not a literary judgement: the writer is
leaving its own bookkeeping in the prose.

    [staging folio A-0001 — Gate Ritual and Plaque]
    [bracketed provenance: unnamed in builder]
    [see s-001]
    (staging: invented by writer — family relation labelled as 'her brother')

Same family as the v0.7.3 defect, where the writer quoted its packet verbatim and
registry language reached the page; a different channel, because here it is
composing the annotation itself. Counted per manuscript so the fix has a
before-and-after, and reported as spans rather than a boolean because one leak
per scene and thirty are different problems.
"""

import re
import sys
from pathlib import Path

#: Each pattern is a shape seen in a real manuscript, not a guess at one.
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("staging note", re.compile(r"[\[(][^\])\n]{0,120}\bstaging\b[^\])\n]{0,120}[\])]", re.I)),
    ("scene cross-ref", re.compile(r"[\[(]\s*(?:see|cf\.?|ref)\s+s-\d{3}[^\])\n]{0,40}[\])]", re.I)),
    ("folio/id label", re.compile(r"[\[(][^\])\n]{0,60}\bfolio\s+[A-Z]-\d{3,}[^\])\n]{0,80}[\])]")),
    ("provenance note", re.compile(r"[\[(][^\])\n]{0,120}\b(?:provenance|invented by (?:the )?writer|established by this scene|unnamed in builder)\b[^\])\n]{0,120}[\])]", re.I)),
    ("role name in brackets", re.compile(r"[\[(][^\])\n]{0,80}\b(?:context-builder|index-manager|verifier|orchestrator|packet)\b[^\])\n]{0,80}[\])]", re.I)),
]


def scan(text: str) -> list[tuple[str, str]]:
    hits: list[tuple[str, str]] = []
    for label, pat in PATTERNS:
        for m in pat.finditer(text):
            hits.append((label, m.group(0)[:120]))
    return hits


def main(paths: list[str]) -> int:
    rows = []
    for root in paths:
        for f in sorted(Path(root).rglob("*.txt")):
            text = f.read_text(errors="replace")
            words = len(text.split())
            hits = scan(text)
            rows.append((f, words, hits))

    print(f"{'manuscript':<52} {'words':>7} {'leaks':>6} {'per10k':>7}")
    print("-" * 76)
    total_hits = total_words = 0
    for f, words, hits in rows:
        total_hits += len(hits)
        total_words += words
        per10k = len(hits) / (words / 10_000) if words else 0
        print(f"{f.parent.parent.name + '/' + f.stem:<52} {words:>7,} {len(hits):>6} {per10k:>7.2f}")
    if total_words:
        print(
            f"\ntotal: {total_hits} leak(s) over {total_words:,} words = "
            f"{total_hits / (total_words / 10_000):.2f} per 10k"
        )
    shapes: dict[str, int] = {}
    for _f, _w, hits in rows:
        for label, _q in hits:
            shapes[label] = shapes.get(label, 0) + 1
    for label, n in sorted(shapes.items(), key=lambda kv: -kv[1]):
        print(f"  {label:<24} {n}")
    print("\nexamples:")
    seen = 0
    for _f, _w, hits in rows:
        for label, quote in hits:
            if seen >= 8:
                break
            print(f"  [{label}] {quote}")
            seen += 1
    return 0


if __name__ == "__main__":
    raise SystemExit(
        main(sys.argv[1:] or [str(Path.home() / "storyos-data" / "outputs")])
    )
