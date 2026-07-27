#!/usr/bin/env python3
"""Render LiveNovelBench tasks into the batch runner's input format.

Why a conversion step exists at all, given that a conversion step is exactly what
this project once got burned by: LongBench-Write's own `tasks.jsonl` can be fed to
`run-batch` unchanged, because a LongBench-Write record already *is* a user
request plus a length. A LiveNovelBench record is not. It is structured metadata —
`premise`, `expected_conflict`, `required_elements`, `characters`, `genre` — and
the scoring reads the required elements and the premise, so a run given only the
premise would be graded on material it was never shown.

Two rules this follows, both of them scars:

  * `target_words` is taken from the tier manifest's `target_words_override` when a
    tier is named, and never inferred. A task scored against a length it was not
    asked for is a real failure this repository has produced.
  * Nothing is paraphrased. The premise, the conflict, every required element and
    every character line goes through verbatim, and `raw` keeps the whole original
    record so `task.json` in the run directory can be checked against the frozen
    file.

Usage:
    python3 smoke/make-lnb-tasks.py --tier 20k --limit 2 --out /tmp/lnb-20k.jsonl
    python3 smoke/make-lnb-tasks.py --ids task-horror-headlights --out /tmp/one.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BENCH = Path.home() / "storyos" / "benchmarks" / "novelbench"


def render_prompt(task: dict, target_words: int) -> str:
    """The task as a request a writer could act on, with nothing added."""
    parts: list[str] = [
        f"Write a complete {task['genre'].replace('_', ' ')} novel of about "
        f"{target_words:,} words.",
        "",
        "Premise:",
        task["premise"].strip(),
        "",
        "Central conflict:",
        task["expected_conflict"].strip(),
    ]

    if task.get("characters"):
        parts += ["", "Characters:"]
        parts += [f"- {c.strip()}" for c in task["characters"]]

    if task.get("required_elements"):
        parts += [
            "",
            "The finished novel must contain all of the following:",
        ]
        parts += [f"- {e.strip()}" for e in task["required_elements"]]

    parts += [
        "",
        "Write the novel itself — no outline, no commentary, no notes to the reader.",
    ]
    return "\n".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", help="tier manifest to read ids and target from, e.g. 20k")
    ap.add_argument("--ids", nargs="*", default=[], help="explicit task ids instead of a tier")
    ap.add_argument("--target-words", type=int, help="override; only with --ids")
    ap.add_argument("--limit", type=int, default=0, help="take the first N ids")
    ap.add_argument("--flags", nargs="*", default=[], help="extra write-story flags per task")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    tasks = {json.loads(line)["task_id"]: json.loads(line) for line in open(BENCH / "tasks.jsonl")}

    if args.tier:
        manifest = json.loads((BENCH / f"tier-{args.tier}.json").read_text())
        ids = manifest["ids"]
        target = manifest["target_words_override"]
        provenance = f"tier-{args.tier}.json (target_words_override={target})"
    elif args.ids:
        ids = args.ids
        if not args.target_words:
            print("--ids requires --target-words: a length must never be inferred", file=sys.stderr)
            return 2
        target = args.target_words
        provenance = f"--target-words {target} on the command line"
    else:
        print("give --tier or --ids", file=sys.stderr)
        return 2

    if args.limit:
        ids = ids[: args.limit]

    written = 0
    with open(args.out, "w") as fh:
        for task_id in ids:
            task = tasks.get(task_id)
            if task is None:
                print(f"{task_id} is not in tasks.jsonl", file=sys.stderr)
                return 1
            record = {
                # The run directory name. Shortened because the batch runner uses it
                # as a directory and `task-science_fiction-seek-the-traitor-s-son`
                # would make every path in the trace unreadable.
                "task_id": short_id(task_id, args.tier or "custom"),
                "prompt": render_prompt(task, target),
                "target_words": target,
                "flags": args.flags,
                "bench": "livenovelbench",
                "bench_task_id": task_id,
                "target_provenance": provenance,
                "raw": task,
            }
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            written += 1

    print(f"{written} task(s) -> {args.out} at {target:,} words each ({provenance})")
    return 0


def short_id(task_id: str, tier: str) -> str:
    """`task-horror-headlights` at the 20k tier -> `lnb20k-horror-headlights`."""
    stem = task_id.removeprefix("task-").replace("_", "")
    return f"lnb{tier}-{stem}"


if __name__ == "__main__":
    raise SystemExit(main())
