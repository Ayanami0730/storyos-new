#!/usr/bin/env python3
"""Our LongBench-Write row against every baseline's, paired over the same tasks.

Means over different task sets are not comparable, and this benchmark's tasks
differ enormously in difficulty: the same system scores 96 on a 2,000-word prompt
and 56 on a 20,000-word one. So every figure here is computed over the intersection
of tasks where both systems have a judgement, and the count is printed beside it.

Both halves of S-bar are reported separately, because they are not weighted the
same: S-bar = (20*S_q + S_l)/2, so one point of S_q is worth ten points of S-bar
and one point of S_l is worth half a point. A system can win on length and still
lose, which is exactly what happened to the chapter arm.

The median and win-loss count are printed with the mean because the mean is what a
single collapsed cell moves: on the chapter arm one manuscript at S_l = 0 accounted
for the entire deficit against agentwrite.
"""

from __future__ import annotations

import json
import os
import statistics
import sys
from pathlib import Path

LBW = Path(os.environ.get("LBW_ROOT", Path.home() / "storyos/experiments/longbench-write"))
BASELINES = LBW / "judgements/gpt-5.5"
REPO = Path(__file__).resolve().parent.parent


def last_row(path: Path, task: str) -> dict | None:
    if not path.is_file():
        return None
    hits = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("task_id") == task or row.get("task") == task:
            hits.append(row)
    return hits[-1] if hits else None


def sq_of(row: dict) -> float | None:
    """The judge's quality score on its own 0-5 axis, however the file names it."""
    for key in ("s_quality_raw", "S_q", "s_quality"):
        if isinstance(row.get(key), (int, float)):
            return float(row[key])
    return None


def sl_of(row: dict) -> float | None:
    for key in ("s_length", "S_l", "s_len"):
        if isinstance(row.get(key), (int, float)):
            return float(row[key])
    return None


def sbar(row: dict) -> float | None:
    """S-bar = (20*S_q + S_l)/2, the benchmark's own composite."""
    for key in ("S_bar", "s_bar", "sbar"):
        if isinstance(row.get(key), (int, float)):
            return float(row[key])
    sq, sl = sq_of(row), sl_of(row)
    if sq is None or sl is None:
        return None
    return (20.0 * sq + sl) / 2.0


def main() -> int:
    batch = sys.argv[1] if len(sys.argv) > 1 else "runs-lbw21"
    bdir = REPO / batch

    ours: dict[str, dict] = {}
    for cell in sorted(p for p in bdir.iterdir() if p.is_dir()):
        j = cell / "scoring" / "judgements" / "gpt-5.5" / "storyos-v3.jsonl"
        if not j.is_file():
            continue
        try:
            task = json.loads((cell / "task.json").read_text())["task_id"]
        except (OSError, KeyError, json.JSONDecodeError):
            task = cell.name
        row = last_row(j, task)
        if row:
            ours[task] = row

    if not ours:
        print(f"no judgements under {bdir}")
        return 1

    systems = sorted(p.stem for p in BASELINES.glob("*.jsonl"))
    print(f"{batch}: {len(ours)} scored task(s), frozen judge gpt-5.5")
    print()
    hdr = (
        f"  {'system':<28} {'n':>3} {'S-bar':>7} {'we lead':>8} "
        f"{'median':>9} {'our W-L':>8} {'S_q':>6} {'S_l':>6}"
    )
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))

    def summarise(label: str, rows: dict[str, dict], against: dict[str, dict] | None):
        tasks = sorted(rows)
        if against is not None:
            tasks = sorted(set(rows) & set(against))
        if not tasks:
            return
        mine = [sbar(rows[t]) for t in tasks]
        mine = [m for m in mine if m is not None]
        sq = [v for v in (sq_of(rows[t]) for t in tasks) if v is not None]
        sl = [v for v in (sl_of(rows[t]) for t in tasks) if v is not None]
        diff = wl = med = None
        if against is not None:
            pairs = [
                (sbar(against[t]), sbar(rows[t]))
                for t in tasks
                if sbar(against[t]) is not None and sbar(rows[t]) is not None
            ]
            # `pairs` is (ours, theirs), so this column is ours minus theirs and a
            # positive number always means we are ahead. The first version
            # subtracted the other way under a header reading "vs ours", which is
            # its own opposite — the kind of sign error a table carries silently.
            deltas = [ours_v - theirs for ours_v, theirs in pairs]
            diff = statistics.mean(deltas)
            med = statistics.median(deltas)
            wl = f"{sum(1 for d in deltas if d > 0)}-{sum(1 for d in deltas if d < 0)}"  # our wins-losses
        print(
            f"  {label:<28} {len(tasks):>3} {statistics.mean(mine):>7.1f} "
            f"{('' if diff is None else f'{diff:+.1f}'):>8} "
            f"{('' if med is None else f'{med:+.1f}'):>9} {(wl or ''):>7} "
            f"{(statistics.mean(sq) if sq else 0):>6.2f} {(statistics.mean(sl) if sl else 0):>6.1f}"
        )

    summarise("storyos-v3 (ours)", ours, None)
    for s in systems:
        rows = {}
        for task in ours:
            r = last_row(BASELINES / f"{s}.jsonl", task)
            if r:
                rows[task] = r
        summarise(s, rows, ours)

    # Where we lose most, since the fix list is built from these rather than from
    # the aggregate.
    print()
    print("  worst paired gaps against agentwrite:")
    aw = {t: last_row(BASELINES / "agentwrite.jsonl", t) for t in ours}
    deltas = []
    for t, r in aw.items():
        if r is None:
            continue
        a, b = sbar(ours[t]), sbar(r)
        if a is None or b is None:
            continue
        deltas.append((a - b, t, a, b, sq_of(ours[t]), sq_of(r)))
    for d, t, a, b, msq, tsq in sorted(deltas)[:5]:
        print(f"    {t:<9} ours {a:5.1f} (S_q {msq:.2f}) vs {b:5.1f} (S_q {tsq:.2f})   {d:+.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
