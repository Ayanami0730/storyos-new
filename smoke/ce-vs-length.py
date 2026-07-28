#!/usr/bin/env python3
"""Does writing more words raise or lower the contradiction density?

This decides the optimisation direction, and the two plausible answers point
opposite ways. Density is `kept_errors / (words/10_000)`. If the error count grows
roughly in proportion to length, density is flat and length is neutral. If errors
front-load — a system contradicts itself while establishing the world and then
mostly stops — density falls as the manuscript grows, and over-delivering length is
the cheapest available win on the axis we are worst at.

Answered from the baseline population rather than from our own runs, because we
have one arm at one length and the baselines span 4,000 to 95,000 words on the same
twelve tasks with the same frozen detector. Their spread is the only place the
shape of the curve is visible.

Reads the per-story consistency records, which carry both the raw count and the
words it was divided by, so the count is not re-derived from the density.
"""

from __future__ import annotations

import collections
import json
import math
import statistics
import sys
from pathlib import Path

FACT = Path.home() / "storyos-data" / "fact-metric"


def stories(tier: str) -> list[dict]:
    d = FACT / f"consistency-{tier}" / "stories"
    rows: list[dict] = []
    if not d.is_dir():
        return rows
    for p in sorted(d.rglob("*.json*")):
        try:
            text = p.read_text()
        except OSError:
            continue
        if p.suffix == ".jsonl":
            for line in text.splitlines():
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        else:
            try:
                obj = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, list):
                rows += [o for o in obj if isinstance(o, dict)]
            elif isinstance(obj, dict):
                rows.append(obj)
    return rows


def pick(row: dict, *names):
    for n in names:
        if n in row and row[n] is not None:
            return row[n]
    return None


def pearson(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    if n < 3:
        return float("nan")
    mx, my = statistics.mean(xs), statistics.mean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return num / (dx * dy) if dx and dy else float("nan")


def main() -> None:
    tiers = sys.argv[1:] or ["20k", "40k", "60k"]
    pts: list[tuple[str, str, float, float, float]] = []
    for tier in tiers:
        for r in stories(tier):
            words = pick(r, "words", "story_words")
            kept = pick(r, "kept_count", "kept", "errors_kept")
            dens = pick(r, "consistency_errors_per_10k", "errors_per_10k")
            sysname = pick(r, "system") or "?"
            if not words or dens is None:
                continue
            if kept is None:
                kept = dens * (float(words) / 10_000)
            pts.append((tier, sysname, float(words), float(kept), float(dens)))

    if not pts:
        print("no per-story consistency records found under", FACT)
        return

    print(f"{len(pts)} scored manuscripts across tiers {', '.join(tiers)}")

    # Shape of the curve, over the whole population: if errors were proportional
    # to length, `kept` would rise with words and density would be flat.
    ws = [p[2] for p in pts]
    ks = [p[3] for p in pts]
    ds = [p[4] for p in pts]
    print()
    print(f"  corr(words, kept error count) = {pearson(ws, ks):+.3f}")
    print(f"  corr(words, errors per 10k)   = {pearson(ws, ds):+.3f}")
    print("  (a strongly negative second number means length lowers density,")
    print("   i.e. errors do not keep pace with the words they are divided by)")

    print()
    print("== by length band, pooled across systems ==")
    bands = [(0, 10_000), (10_000, 20_000), (20_000, 30_000),
             (30_000, 45_000), (45_000, 70_000), (70_000, 10**9)]
    print(f"  {'band':<18} {'n':>3} {'mean words':>11} {'mean errors':>12} {'mean per10k':>12}")
    for lo, hi in bands:
        sel = [p for p in pts if lo <= p[2] < hi]
        if not sel:
            continue
        label = f"{lo//1000}k-{hi//1000}k" if hi < 10**9 else f"{lo//1000}k+"
        print(
            f"  {label:<18} {len(sel):>3} {statistics.mean(p[2] for p in sel):>11,.0f} "
            f"{statistics.mean(p[3] for p in sel):>12.1f} "
            f"{statistics.mean(p[4] for p in sel):>12.2f}"
        )

    # Same question inside each system, which removes the possibility that the
    # band effect is just "the systems that write long happen to be better".
    print()
    print("== within a single system, across tiers (removes system as a factor) ==")
    per_sys: dict[str, list[tuple[float, float, float]]] = collections.defaultdict(list)
    for _, s, w, k, d in pts:
        per_sys[s].append((w, k, d))
    print(f"  {'system':<28} {'n':>3} {'corr(words,per10k)':>19} {'words range':>22}")
    for s, v in sorted(per_sys.items()):
        if len(v) < 6:
            continue
        r = pearson([x[0] for x in v], [x[2] for x in v])
        print(
            f"  {s:<28} {len(v):>3} {r:>+19.3f} "
            f"{min(x[0] for x in v):>10,.0f}-{max(x[0] for x in v):<10,.0f}"
        )

    # The concrete counterfactual: our own absolute error counts, redivided by the
    # length a competitor delivered on the same target. This is only an upper bound
    # on the gain — it assumes writing more adds no errors, which is the assumption
    # the correlation above is there to test.
    print()
    print("== counterfactual: our error counts at a longer delivery ==")
    ours = [p for p in pts if str(p[1]).startswith("storyos")]
    if ours:
        mean_kept = statistics.mean(p[3] for p in ours)
        mean_words = statistics.mean(p[2] for p in ours)
        print(f"  ours now: {mean_words:,.0f} words, {mean_kept:.1f} kept errors "
              f"-> {mean_kept/(mean_words/10_000):.2f} per 10k")
        for tgt in (25_000, 30_000, 34_000, 40_000):
            print(f"  same errors at {tgt:,} words -> {mean_kept/(tgt/10_000):.2f} per 10k")


if __name__ == "__main__":
    main()
