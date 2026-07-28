#!/usr/bin/env python3
"""The eight 20k-tier tasks the default arm has not run, for the second account.

Table 1 is twelve tasks per tier. The default scene length has one finished cell
and three in flight, so eight are missing and the row cannot be reported. These
go on the zhizengzeng key2 account so they do not compete with the in-flight
batches on the internal gateway.

Default scene length deliberately: the 2,400 and 3,600 arms are the experiment,
and the row that has to exist first is the one every baseline is comparable
with.

Reads the benchmark copy whose hash matches what the scorer uses, and records it
per task — the other copy on this machine differs in six of fifty tasks.
"""

import hashlib
import importlib.util
import json
from pathlib import Path

BENCH = Path.home() / "lane" / "livenovelbench" / "benchmarks" / "novelbench"
EXPECTED_SHA = "02fb0f2343d992f17b890424ebd5d4a38105da21d71a5472a1d316da51750db1"
TARGET = 20000
OUT = Path(__file__).resolve().parent.parent / "runs-lnb20k" / "tasks.jsonl"

#: Every 20k id the default arm is not already running or finished.
MISSING = [
    "task-fantasy-steel-gods",
    "task-historical-a-far-flung-life",
    "task-horror-japanese-gothic",
    "task-horror-the-sea-hides-its-dead",
    "task-literary-yesteryear",
    "task-romance-in-her-own-league",
    "task-romance-star-shipped",
    "task-science_fiction-hell-s-heart",
]


def main() -> int:
    tasks_file = BENCH / "tasks.jsonl"
    sha = hashlib.sha256(tasks_file.read_bytes()).hexdigest()
    assert sha == EXPECTED_SHA, f"{tasks_file} hashes {sha}, expected {EXPECTED_SHA}"

    spec = importlib.util.spec_from_file_location(
        "make_lnb_tasks", Path(__file__).resolve().parent / "make-lnb-tasks.py"
    )
    gen = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(gen)  # type: ignore[union-attr]

    tasks = {json.loads(l)["task_id"]: json.loads(l) for l in tasks_file.open()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as fh:
        for task_id in MISSING:
            task = tasks[task_id]
            fh.write(
                json.dumps(
                    {
                        "task_id": gen.short_id(task_id, "custom"),
                        "prompt": gen.render_prompt(task, TARGET),
                        "target_words": TARGET,
                        "flags": [],
                        "bench": "livenovelbench",
                        "bench_task_id": task_id,
                        "target_provenance": f"--target-words {TARGET} (20k tier, default scenes)",
                        "source_tasks": str(tasks_file),
                        "source_tasks_sha256": sha,
                        "raw": task,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    print(f"{len(MISSING)} task(s) -> {OUT} at {TARGET:,} words, default scene length")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
