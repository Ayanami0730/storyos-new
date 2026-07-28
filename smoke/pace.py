#!/usr/bin/env python3
"""Minutes per scene by route, measured from when scenes actually landed.

A run's total wall clock divided by its scene count answers a different question
than "how fast is this route right now": it averages over the planning phase, over
retries, and over however loaded the gateway was hours ago. The interval between
consecutive committed scene files is the per-scene cost as it is being paid, and it
is the number that decides whether moving work to another key would help.

Scene granularity is held constant within a comparison, because it is close to a
pure multiplier on how many scenes a book needs and would otherwise swamp the
route effect.
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BATCHES = ["runs-lbw21", "runs-60kv2", "runs-40kv2", "runs-lnb20k", "runs-lnb", "runs-lnbch"]

#: Which route a batch is on. Read from a finished summary where one exists;
#: otherwise from how the batch was launched, since a live cell has no summary.
LAUNCH_ROUTE = {
    "runs-lnb20k": "zzz (zhizengzeng key2)",
    "runs-lbw21": "ys2 (internal openai group)",
    "runs-60kv2": "ys2 (internal openai group)",
    "runs-40kv2": "ys2 (internal openai group)",
    "runs-lnb": "ys2 (internal openai group)",
    "runs-lnbch": "ys2 (internal openai group)",
}


def wps_of(cell: Path) -> str:
    s = cell / "summary-stdout.json"
    if s.is_file():
        try:
            v = json.loads(s.read_text()).get("words_per_scene")
            if v:
                return str(v)
        except json.JSONDecodeError:
            pass
    t = cell / "task.json"
    if t.is_file():
        try:
            flags = json.loads(t.read_text()).get("flags") or []
            if "--words-per-scene" in flags:
                return flags[flags.index("--words-per-scene") + 1]
        except (json.JSONDecodeError, IndexError, ValueError):
            pass
    return "1200 (default)"


def main() -> int:
    window_min = float(sys.argv[1]) if len(sys.argv) > 1 else 120.0
    import time

    now = time.time()
    rows: dict[tuple[str, str], list[float]] = {}
    for batch in BATCHES:
        bdir = ROOT / batch
        if not bdir.is_dir():
            continue
        for cell in sorted(p for p in bdir.iterdir() if p.is_dir()):
            chapters = cell / "run" / "project" / "novel" / "chapters"
            if not chapters.is_dir():
                continue
            stamps = sorted(p.stat().st_mtime for p in chapters.rglob("*.md"))
            if len(stamps) < 3:
                continue
            gaps = [
                (b - a) / 60
                for a, b in zip(stamps, stamps[1:])
                if (now - b) / 60 <= window_min and 0 < (b - a) / 60 < 180
            ]
            if not gaps:
                continue
            key = (LAUNCH_ROUTE.get(batch, batch), wps_of(cell))
            rows.setdefault(key, []).extend(gaps)

    if not rows:
        print(f"no scenes landed in the last {window_min:.0f} minutes")
        return 0

    print(f"scene-to-scene intervals over the last {window_min:.0f} minutes")
    print(f"  {'route':<30} {'words/scene':<16} {'n':>4} {'median':>8} {'p25-p75':>14}")
    for (route, wps), gaps in sorted(rows.items()):
        gaps.sort()
        q1 = gaps[len(gaps) // 4]
        q3 = gaps[(3 * len(gaps)) // 4]
        print(
            f"  {route:<30} {wps:<16} {len(gaps):>4} "
            f"{statistics.median(gaps):>7.1f}m {q1:>6.1f}-{q3:<6.1f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
