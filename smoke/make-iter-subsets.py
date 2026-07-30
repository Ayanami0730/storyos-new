#!/usr/bin/env python3
"""Build the two subsets an iteration runs on.

A full pass is 21 LongBench-Write cells and 12 LiveNovelBench cells per tier, which
is four to seven hours and a whole gateway. That is a measurement, not a development
loop: by the time it lands the change that motivated it is three changes old. So
iteration runs on a subset chosen to be the part of each benchmark we are worst at,
because a fix that does not move those tasks does not move the row either.

**LongBench-Write: one or two tasks per length band, lowest quality first.** The
benchmark spans 100 to 20,000 words in five bands and the harness behaves
differently across them — below 500 words a task is one scene, at 20,000 it is
seventeen — so a subset that skips a band cannot see a regression in it. Our 21-task
row never touched the 0-500 band at all, and that is the band where the scene loop
has the least room to help and the most room to get in the way.

**LiveNovelBench: the worst task per tier by quality and by error density.** Ranked
by the sum of the two ranks rather than by either alone, since the interesting cells
are the ones that are bad at both — `task-romance-the-night-we-met` at 60k is
WQ 3.56 with CE 7.96 and attainment 0.84, and a change that fixes it is a change
that matters.

Two sizes, because the 40k and 60k cells are four to seven hours each and the point
of a loop is that it closes:

    fast   — LBW bands 0-500 through 4k-10k, LNB 20k only.  ~1 h
    full   — adds LBW 10k-20k and LNB 40k/60k.              ~7 h

    make-iter-subsets.py            # writes both, prints what it chose
    make-iter-subsets.py --fast     # only the fast pair
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

LBW = Path.home() / "storyos/experiments/longbench-write"
REPO = Path(__file__).resolve().parent.parent

#: Chosen from the scored 21-task row, worst `S_q` first inside each band, with both
#: languages represented wherever the band has both. The 0-500 pair is new: that band
#: was never in the row, so there is no score to rank by and the two picks are the
#: creative-writing tasks at the band's extremes (200 words zh, 500 words en).
LBW_SUBSET: dict[str, list[tuple[str, str]]] = {
    "0-500": [
        ("lbw008", "200w zh — untested band, one scene, verse form"),
        ("lbw029", "500w en — untested band, the only short task ever run (0.7.5)"),
    ],
    "500-2k": [
        ("lbw067", "2000w zh — S_q 1.83, our worst task; 分两部分写 structure"),
        ("lbw068", "2000w zh — S_q 3.33; 五篇日记, the missing-fifth-part defect"),
    ],
    "2k-4k": [
        ("lbw079", "2500w en — S_q 3.33, worst in band"),
        ("lbw076", "2400w zh — S_q 3.50"),
    ],
    "4k-10k": [
        ("lbw112", "10000w zh — S_q 2.83, S-bar 67.7; 共五幕 structure"),
        ("lbw103", "5000w en — S_q 3.17"),
    ],
    "10k-20k": [
        ("lbw119", "20000w zh — S_q 2.67, 17 scenes, ~2 h on its own"),
    ],
}

FAST_BANDS = ["0-500", "500-2k", "2k-4k", "4k-10k"]

#: Ranked by quality rank + error rank over the scored cells of each tier.
LNB_SUBSET: dict[str, list[tuple[str, str]]] = {
    "20k": [
        ("task-historical-a-far-flung-life", "WQ 3.75, CE 5.45, Plot 3.07 — worst on both"),
        ("task-romance-star-shipped", "WQ 3.35 (lowest), CE 4.46"),
        ("task-horror-molka", "WQ 4.09 but CE 5.79 — error-dominated"),
    ],
    "40k": [
        ("task-fantasy-the-tapestry-of-fate", "WQ 3.98, CE 6.75 (highest in tier)"),
        ("task-historical-elizabeth-and-marilyn", "WQ 3.76 (lowest), attainment 0.94"),
    ],
    "60k": [
        ("task-romance-the-night-we-met", "WQ 3.56, CE 7.96, attainment 0.84 — worst on all three"),
        ("task-fantasy-the-book-witch", "WQ 4.05 but CE 7.59"),
        ("task-mystery-a-violent-masterpiece", "CE 6.35, attainment 0.73 — the shortfall case"),
    ],
}

#: Where a tier's task records live. More than one file per tier because the 40k
#: batches were split across two rounds and the two tasks this subset wants are in
#: the earlier one — `runs-40kv2` holds ten of the tier's twelve.
TIER_SOURCE = {
    "20k": ["runs-20kv2/tasks.jsonl"],
    "40k": ["runs-40kv2/tasks.jsonl", "runs-r1/tasks-40k.jsonl", "runs-lnb/tasks-all.jsonl"],
    "60k": ["runs-60kv2/tasks.jsonl"],
}


def lbw_tasks() -> dict[str, dict]:
    return {
        (row := json.loads(line))["task_id"]: row
        for line in (LBW / "tasks.jsonl").open()
    }


def lnb_tasks(tier: str) -> dict[str, dict]:
    """Task records as the batch runner wants them, keyed on the benchmark's own id."""
    out: dict[str, dict] = {}
    for rel in TIER_SOURCE[tier]:
        src = Path.home() / "storyos-v3" / rel
        if not src.is_file():
            continue
        for line in src.open():
            row = json.loads(line)
            key = row.get("bench_task_id") or row["task_id"]
            # First file wins, so the batch that produced the scored row is preferred.
            out.setdefault(key, row)
    return out


def write(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fast", action="store_true", help="only the fast pair")
    args = ap.parse_args()

    lbw = lbw_tasks()
    out = REPO / "subsets"

    for name, bands in [("fast", FAST_BANDS), ("full", list(LBW_SUBSET))]:
        if args.fast and name != "fast":
            continue
        rows = []
        print(f"\n=== LongBench-Write subset: {name} ===")
        for band in bands:
            for tid, why in LBW_SUBSET[band]:
                t = lbw[tid]
                rows.append(
                    {
                        "task_id": tid,
                        "prompt": t["prompt"],
                        "target_words": t["length"],
                        "bench": "longbench-write",
                        "flags": [],
                    }
                )
                print(f"  [{band:<8}] {tid}  {why}")
        write(out / f"lbw-{name}.jsonl", rows)
        print(f"  -> subsets/lbw-{name}.jsonl ({len(rows)} tasks)")

    for name, tiers in [("fast", ["20k"]), ("full", ["20k", "40k", "60k"])]:
        if args.fast and name != "fast":
            continue
        for tier in tiers:
            src = lnb_tasks(tier)
            rows = []
            print(f"\n=== LiveNovelBench subset: {name}, {tier} ===")
            for tid, why in LNB_SUBSET[tier]:
                if tid not in src:
                    print(f"  MISSING {tid} in {TIER_SOURCE[tier]}/tasks.jsonl")
                    continue
                rows.append(src[tid])
                print(f"  {tid}  {why}")
            write(out / f"lnb-{name}-{tier}.jsonl", rows)
            print(f"  -> subsets/lnb-{name}-{tier}.jsonl ({len(rows)} tasks)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
