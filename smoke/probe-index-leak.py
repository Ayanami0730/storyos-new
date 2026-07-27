#!/usr/bin/env python3
"""How much of a manuscript was copied verbatim out of the index.

The measurement this exists for. `runs-070/lbw081` scored 78.6 with Reading
Experience at 2, and its opening paragraphs contain object-file lines in quotation
marks — including *"the watch stopped at a time relevant to establishing the minute
of death"*, which is registry language about why a fact matters to an
investigation and cannot occur in fiction.

Counting long quoted spans does not measure this, because dialogue is quoted too:
the run that scored 88.2 has more of them than the run that scored 78.6. What
distinguishes them is whether the quoted text came from the index, so that is what
this counts — shared runs of twelve words between `story.md` and the index files,
excluding the manuscript itself.

    python3 smoke/probe-index-leak.py runs-070/lbw081/run runs/lbw081/run
"""

from __future__ import annotations

import sys
from pathlib import Path

MIN_RUN = 12
INDEX_SUFFIXES = {".yaml", ".yml"}
# Only the *descriptive* index: entity sketches, object and location descriptions,
# world rules. These are the files written in registry language, and they are what
# must never appear on the page.
#
# Everything that stores a prose `quote` is excluded, and this is not a detail —
# the first version of this probe included `continuity/deltas/*.json` and
# `canon-facts.jsonl`, which hold the writer's own verbatim quotes for every claim,
# so every manuscript matched itself and every run reported 100% leaked. A measure
# that returns the same number for a run that scored 88.2 and one that scored 78.6
# is measuring the wrong thing.
KEEP_DIRS = {"objects", "locations", "characters", "world", "factions", "relations"}
SKIP_NAMES = {"state.jsonl", "beliefs.jsonl"}


def words(text: str) -> list[str]:
    return [
        w
        for w in text.lower().replace("\u2019", "").replace("\u201c", "").replace("\u201d", "")
        .replace('"', "").replace("'", "").split()
        if w
    ]


def grams(tokens: list[str], n: int = MIN_RUN) -> set[str]:
    return {" ".join(tokens[i : i + n]) for i in range(max(0, len(tokens) - n + 1))}


def main(runs: list[str]) -> int:
    print(f"{'run':34s} {'story words':>11s} {'leaked spans':>13s} {'leaked words':>13s} {'%':>6s}")
    for run in runs:
        root = Path(run)
        story = root / "story.md"
        if not story.exists():
            print(f"{run:34s} (no story.md)")
            continue

        index_tokens: list[str] = []
        project = root / "project"
        for path in sorted(project.rglob("*")):
            if not path.is_file() or path.suffix not in INDEX_SUFFIXES:
                continue
            parts = path.relative_to(project).parts
            if not parts or parts[0] not in KEEP_DIRS or path.name in SKIP_NAMES:
                continue
            try:
                index_tokens += words(path.read_text(errors="replace")) + ["\u0000"]
            except OSError:
                pass

        index_grams = grams(index_tokens)
        story_words = words(story.read_text(errors="replace"))

        # Maximal runs rather than every n-gram, so one pasted sentence counts once
        # instead of once per starting offset.
        spans: list[int] = []
        i = 0
        while i + MIN_RUN <= len(story_words):
            if " ".join(story_words[i : i + MIN_RUN]) in index_grams:
                length = MIN_RUN
                while (
                    i + length < len(story_words)
                    and " ".join(story_words[i + length - MIN_RUN + 1 : i + length + 1])
                    in index_grams
                ):
                    length += 1
                spans.append(length)
                i += length
            else:
                i += 1

        leaked = sum(spans)
        pct = 100 * leaked / len(story_words) if story_words else 0
        print(
            f"{run:34s} {len(story_words):11d} {len(spans):13d} {leaked:13d} {pct:5.1f}%"
        )
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    raise SystemExit(main(sys.argv[1:]))
