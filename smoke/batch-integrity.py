#!/usr/bin/env python3
"""Refuse to score a batch that is not one experiment.

Every defect that reached a batch this week was invisible to the 558 unit tests
because it lived somewhere the tests do not look: the seam between a pure function
and the state machine, an input nobody imagined, or the procedure around a run.
Three of them are checkable from the artefacts a finished batch leaves behind, so
they are checked here rather than noticed later.

  * **Mixed versions.** Node reads the sources at process start, so editing the
    harness while a batch is in flight silently splits it: cells that started
    before the edit ran the old code, cells after it the new. A batch whose cells
    report two `harness_version`s is two experiments reported as one.
  * **Incomplete cells.** A cell that delivered 3 of 4 planned scenes still writes
    a `summary.json` and still scores, at a length the task never asked for.
  * **Silent degradation.** `deterministic_failures` and `scenes_unverified` count
    scenes that committed without the gate that was supposed to check them. Both
    are meant to be zero, and both were non-zero for a whole batch once.

    smoke/batch-integrity.py runs-zh17 runs-60kv2
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path


def cells(root: Path) -> list[tuple[str, dict]]:
    out = []
    for d in sorted(root.iterdir()):
        summary = d / "run" / "summary.json"
        if summary.is_file():
            try:
                out.append((d.name, json.loads(summary.read_text())))
            except json.JSONDecodeError:
                out.append((d.name, {}))
    return out


def check(root: Path) -> int:
    found = cells(root)
    if not found:
        print(f"{root.name}: no finished cells yet")
        return 0

    problems: list[str] = []
    versions = Counter(s.get("harness_version", "?") for _, s in found)
    if len(versions) > 1:
        problems.append(
            f"{len(versions)} harness versions in one batch: "
            + ", ".join(f"{v} x{n}" for v, n in versions.most_common())
        )

    short, unverified, degraded, fatal = [], [], [], []
    for name, s in found:
        planned = s.get("scenes_planned") or 0
        committed = s.get("scenes_committed") or 0
        if planned and committed < planned:
            short.append(f"{name} {committed}/{planned}")
        if s.get("scenes_unverified"):
            unverified.append(f"{name} x{s['scenes_unverified']}")
        if s.get("deterministic_failures"):
            degraded.append(f"{name} x{s['deterministic_failures']}")
        if s.get("fatal"):
            fatal.append(f"{name}: {str(s['fatal'])[:60]}")

    if short:
        problems.append(f"{len(short)} incomplete cell(s): {', '.join(short[:6])}")
    if unverified:
        problems.append(f"scenes committed without a verifier: {', '.join(unverified[:6])}")
    if degraded:
        problems.append(f"deterministic layer threw: {', '.join(degraded[:6])}")
    if fatal:
        problems.append(f"fatal: {'; '.join(fatal[:4])}")

    attain = [
        (s.get("words") or 0) / (s.get("target_words") or 1) for _, s in found
    ]
    print(
        f"{root.name}: {len(found)} finished cell(s), version(s) "
        f"{'/'.join(versions)}, attainment "
        f"{min(attain):.2f}–{max(attain):.2f}, "
        f"{'ok' if not problems else f'{len(problems)} problem(s)'}"
    )
    for p in problems:
        print(f"    - {p}")
    return len(problems)


def main() -> int:
    roots = [Path(a) for a in sys.argv[1:]]
    if not roots:
        print(__doc__)
        return 2
    failures = sum(check(r) for r in roots if r.is_dir())
    print()
    if failures:
        print(f"{failures} problem(s). A batch in this state is not one experiment;")
        print("fix or re-run the affected cells before any of it reaches a table.")
        return 1
    print("every finished cell ran the same harness, to its planned length, gated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
