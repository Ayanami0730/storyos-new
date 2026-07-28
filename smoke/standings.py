#!/usr/bin/env python3
"""Where we actually stand, on both benchmarks, from the scored artefacts only.

The question this exists to answer is which configuration could plausibly lead on
both benchmarks, and that cannot be read off either scoreboard alone: LiveNovelBench
scores quality and contradiction density per target tier, LongBench-Write scores a
length/quality composite per task, and the two use different frozen judges.

Every number here is read from a scoring output on disk. Nothing is recomputed
from manuscripts, because the judges are the frozen part and re-deriving their
arithmetic is how a table stops matching the files it claims to summarise. Where n
is small the spread is printed beside the mean, since a 0.1 gap between arms whose
own standard deviation is 0.2 is not a gap.
"""

from __future__ import annotations

import collections
import json
import statistics
import sys
from pathlib import Path

DATA = Path.home() / "storyos-data"
QUAL = DATA / "quality-judge"
FACT = DATA / "fact-metric"


def load_jsonl(p: Path) -> list[dict]:
    if not p.is_file():
        return []
    out = []
    for line in p.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def quality_rows(tier: str) -> list[dict]:
    return load_jsonl(QUAL / f"aggregation-{tier}" / "stories-gpt-5.6-sol.jsonl")


def composite(row: dict) -> float | None:
    """The frozen five-dimension composite, however this row happens to store it."""
    for key in ("writing_quality_docs08", "writing_quality"):
        v = row.get(key)
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, dict):
            for k2 in ("composite", "mean", "score"):
                if isinstance(v.get(k2), (int, float)):
                    return float(v[k2])
    return None


def consistency_rows(tier: str) -> list[dict]:
    d = FACT / f"consistency-{tier}"
    if not d.is_dir():
        return []
    rows: list[dict] = []
    for p in sorted(d.rglob("*.jsonl")):
        for r in load_jsonl(p):
            if "consistency_errors_per_10k" in r or "errors_per_10k" in r:
                rows.append(r)
    for p in sorted(d.rglob("*.json")):
        try:
            obj = json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if isinstance(obj, dict) and (
            "consistency_errors_per_10k" in obj or "errors_per_10k" in obj
        ):
            rows.append(obj)
        elif isinstance(obj, list):
            rows += [
                o for o in obj
                if isinstance(o, dict)
                and ("consistency_errors_per_10k" in o or "errors_per_10k" in o)
            ]
    return rows


def ce(row: dict) -> float | None:
    for k in ("consistency_errors_per_10k", "errors_per_10k"):
        if isinstance(row.get(k), (int, float)):
            return float(row[k])
    return None


def spread(vals: list[float]) -> str:
    if not vals:
        return "-"
    if len(vals) == 1:
        return f"{vals[0]:.3f} (n=1)"
    return f"{statistics.mean(vals):.3f} +-{statistics.stdev(vals):.3f} (n={len(vals)})"


def report_tier(tier: str) -> None:
    q = quality_rows(tier)
    c = consistency_rows(tier)
    if not q and not c:
        print(f"\n### {tier}: nothing scored yet")
        return

    qs: dict[str, list[float]] = collections.defaultdict(list)
    ws: dict[str, list[float]] = collections.defaultdict(list)
    for r in q:
        v = composite(r)
        if v is not None:
            qs[r.get("system", "?")].append(v)
        if isinstance(r.get("story_words"), (int, float)):
            ws[r.get("system", "?")].append(float(r["story_words"]))

    cs: dict[str, list[float]] = collections.defaultdict(list)
    for r in c:
        v = ce(r)
        if v is not None:
            cs[r.get("system", "?")].append(v)

    systems = sorted(set(qs) | set(cs))
    print(f"\n### {tier} target")
    print(
        f"  {'system':<28} {'quality composite':<24} {'errors / 10k words':<24} {'mean words':>10}"
    )
    # Rank by quality where we have it, since that is the column both benches
    # weight most heavily.
    def key(s: str) -> tuple:
        return (-(statistics.mean(qs[s]) if qs.get(s) else -99),)

    for s in sorted(systems, key=key):
        w = f"{statistics.mean(ws[s]):,.0f}" if ws.get(s) else "-"
        print(
            f"  {s:<28} {spread(qs.get(s, [])):<24} {spread(cs.get(s, [])):<24} {w:>10}"
        )


def report_lbw() -> None:
    """LongBench-Write, gpt-5.5 judge, whatever comparison table exists on disk."""
    print("\n### LongBench-Write (frozen judge gpt-5.5)")
    cmp_dir = Path.home() / "storyos-v3"
    candidates = sorted(cmp_dir.glob("runs-*/scoring/compare*.json")) + sorted(
        cmp_dir.glob("runs-*/compare*.json")
    )
    if candidates:
        for p in candidates[-3:]:
            print(f"  {p}")
    else:
        print("  (no comparison table on disk; run smoke/compare-lbw.py)")


def main() -> None:
    tiers = sys.argv[1:] or ["arms", "20k", "40k", "60k"]
    for t in tiers:
        report_tier(t)
    report_lbw()


if __name__ == "__main__":
    main()
