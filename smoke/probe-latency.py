#!/usr/bin/env python3
"""Where a scene's nine minutes actually go.

Splits a run's wall clock into time spent waiting on the model and time spent
executing tools, so "the API is slow" and "the sandbox is slow" stop being
guesses. Every transcript record carries `at`, so the gap between an assistant
message and the tool result that follows it is tool execution, and the gap
between a tool result and the next assistant message is a model round-trip.

    probe-latency.py runs-070/lnb20k-fantasy-daughter-of-crows
"""

from __future__ import annotations

import collections
import glob
import json
import pathlib
import statistics
import sys
from datetime import datetime


def parse(ts: str) -> float:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def event_time(rec: dict) -> float | None:
    """`timestamp` (epoch ms), not `at`.

    `at` is stamped when the transcript is flushed, so every record in a batch
    shares it and every gap computed from it is zero — which is what the first
    version of this probe reported for a 137-minute run.
    """
    ts = rec.get("timestamp")
    return ts / 1000 if isinstance(ts, (int, float)) else None


def main() -> int:
    run = pathlib.Path(sys.argv[1])
    tdir = run / "run/project/runtime/transcripts"
    model_gaps: dict[str, list[float]] = collections.defaultdict(list)
    tool_gaps: dict[str, list[float]] = collections.defaultdict(list)
    roundtrips: collections.Counter[str] = collections.Counter()
    toolcalls: collections.Counter[str] = collections.Counter()

    for role_dir in sorted(tdir.glob("*")):
        role = role_dir.name
        files = sorted(role_dir.glob("*.jsonl"))
        if not files:
            continue
        recs = []
        for line in files[-1].open():
            try:
                r = json.loads(line)
            except Exception:
                continue
            if event_time(r) is not None:
                recs.append(r)
        # An assistant message and the tool result it produced are appended
        # together and share a timestamp, so a round-trip is the gap between one
        # distinct timestamp and the next: one model call plus the tool it ran.
        for prev, cur in zip(recs, recs[1:]):
            a, b = event_time(prev), event_time(cur)
            if a is None or b is None:
                continue
            dt = b - a
            if dt <= 0 or dt > 1800:
                continue
            if cur.get("role") in ("assistant", "toolResult"):
                model_gaps[role].append(dt)
                roundtrips[role] += 1
            if cur.get("role") == "toolResult":
                toolcalls[role] += 1

    summary = json.load((run / "run/summary.json").open())
    wall = summary.get("elapsed_ms", 0) / 1000
    scenes = summary.get("scenes_committed") or 1
    print(f"{run.name}   wall {wall/60:.0f}m over {scenes} scene(s)")
    print(
        f"{'role':18s} {'trips':>6s} {'trips/scene':>12s} {'total':>8s} {'% wall':>7s} "
        f"{'p50':>6s} {'p90':>6s}"
    )
    total = 0.0
    for role in sorted(model_gaps, key=lambda r: -sum(model_gaps[r])):
        m = model_gaps[role]
        if role != "orchestrator":
            total += sum(m)
        print(
            f"{role:18s} {len(m):6d} {len(m)/scenes:12.1f} {sum(m)/60:7.0f}m "
            f"{sum(m)/max(1,wall)*100:6.0f}% "
            f"{statistics.median(m):5.1f}s "
            f"{statistics.quantiles(m, n=10)[-1] if len(m) > 9 else 0:5.1f}s"
        )
    print(
        f"\nthe four delegates account for {total/60:.0f}m of {wall/60:.0f}m wall "
        f"({total/max(1,wall)*100:.0f}%). The orchestrator's own row nests them and is "
        f"excluded from that sum."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
