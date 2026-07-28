#!/usr/bin/env python3
"""Score the person-drift detector against measured ground truth.

Recall is checked against the seven `perspective_confusions` LiveNovelBench found
in our 20,000-word manuscript — the subtype that is 78% of our consistency error
count and the reason this detector exists.

The precision side matters more than it looks. A detector that fires on ordinary
prose would spend a repair round per scene on nothing, and repair rounds are the
scarcest thing in the loop. So it is also run over manuscripts the same judge
measured at 0.00–1.71 errors per 10k, where almost every hit is a false one.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("probe", HERE / "probe-person-drift.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

DATA = pathlib.Path(os.path.expanduser("~/storyos-data"))
OURS = pathlib.Path.home() / "storyos-v3/runs-070/lnb20k-fantasy-daughter-of-crows/run/story.md"
GT = DATA / "fact-metric/consistency-20k/stories/storyos__task-fantasy-daughter-of-crows.json"


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower())


def main() -> int:
    text = OURS.read_text(encoding="utf-8", errors="replace")
    hits = probe.scan(text, "third person limited, Rue")
    truth = [
        e for e in json.load(GT.open())["instances"]
        if e["subtype"] == "perspective_confusions"
    ]

    print(f"=== recall: the {len(truth)} perspective errors the judge found ===")
    found = 0
    hay = [norm(h["quote"]) for h in hits]
    for e in truth:
        # Match on any long run of the judge's quote, not on its opening. The
        # judge often quotes a sentence of lead-in before the offending one, and
        # keying on the first 40 characters scored a hit as a miss.
        q = norm(e["exact_quote"]).split()
        ok = any(
            " ".join(q[i : i + 8]) in h
            for h in hay
            for i in range(max(1, len(q) - 7))
        )
        found += ok
        print(f"  [{'FOUND' if ok else 'MISS '}] {e['exact_quote'][:88]}")
    print(f"  recall {found}/{len(truth)}")

    words = len(text.split())
    print(f"\n=== rate on our manuscript: {len(hits)} hits, "
          f"{len(hits)/words*10000:.2f} per 10k words (judge: {len(truth)/words*10000:.2f}) ===")

    print("\n=== precision proxy: manuscripts the same judge measured near-clean ===")
    for sysname, person in [
        ("raw-gpt-5.5", "third person limited"),
        ("raw-gpt-5.6-sol", "third person limited"),
        ("agentwrite", "third person limited"),
        ("agents-room-style", "third person limited"),
        ("bare-long-context", "third person limited"),
    ]:
        p = DATA / f"outputs/{sysname}/novelbench/task-fantasy-daughter-of-crows.txt"
        if not p.exists():
            continue
        t = p.read_text(encoding="utf-8", errors="replace")
        h = probe.scan(t, person)
        w = len(t.split())
        print(f"  {sysname:28s} {w:6d}w  {len(h):4d} hits  {len(h)/w*10000:6.2f}/10k")
        for x in h[:2]:
            print(f"        {x['quote'][:120]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
