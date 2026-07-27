#!/usr/bin/env python3
"""Put our row for one task next to every baseline's, from the frozen judgements.

Read-only against the reproduction worktree. Ours comes from this repo's own
scoring directory, so the two never share a file — the baselines' table is
converged and a stray write there would put our row in somebody else's result.

    python3 smoke/compare-lbw.py lbw029 lbw081
"""

from __future__ import annotations

import json
import os
import pathlib
import sys

LBW = pathlib.Path(
    os.environ.get("LBW_ROOT", pathlib.Path.home() / "storyos/experiments/longbench-write")
)
REPO = pathlib.Path(__file__).resolve().parent.parent
BASELINE_JUDGEMENTS = LBW / "judgements/gpt-5.5"


def rows_for(path: pathlib.Path, task: str) -> dict | None:
    """The last judgement for this task in a jsonl file, or None."""
    if not path.exists():
        return None
    hits = [
        row
        for line in path.read_text().splitlines()
        if line.strip()
        for row in [json.loads(line)]
        if row.get("task_id") == task and "scores" in row
    ]
    return hits[-1] if hits else None


def s_bar(row: dict) -> float:
    return (20 * row["s_quality_raw"] + row["s_length"]) / 2


def main(tasks: list[str]) -> None:
    for task in tasks:
        # Ours may exist under several run directories (e.g. an ablation arm), so
        # every one is listed rather than the first found — a silently picked row
        # is how two different configurations get reported as one.
        ours = []
        for jsonl in sorted(REPO.glob(f"runs/{task}*/scoring/judgements/gpt-5.5/storyos-v3.jsonl")):
            row = rows_for(jsonl, task)
            if row:
                ours.append((jsonl.parents[3].name, row))

        table = [(f"storyos-v3 [{name}]", row) for name, row in ours]
        for f in sorted(BASELINE_JUDGEMENTS.glob("*.jsonl")):
            row = rows_for(f, task)
            if row:
                table.append((f.stem, row))

        if not table:
            print(f"\n{task}: no judgements found")
            continue

        table.sort(key=lambda e: -s_bar(e[1]))
        required = table[0][1]["required_words"]
        print(f"\n=== {task} — {required} words required ===")
        print(f"{'system':34s} {'S-bar':>6s} {'S_l':>6s} {'S_q':>5s} {'words':>7s}")
        for name, row in table:
            mark = "*" if name.startswith("storyos") else " "
            print(
                f"{mark}{name:33s} {s_bar(row):6.1f} {row['s_length']:6.1f} "
                f"{row['s_quality_raw']:5.2f} {row['response_words']:7d}"
            )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
