#!/usr/bin/env python3
"""The 2,400-word chapter arm on the LiveNovelBench 20k tier.

Why 2,400 rather than the 3,600 already tried. Wall clock is scenes times
per-scene time, so a larger unit is the only lever on a single story — but the
writer does not deliver whatever it is asked for. Measured:

    asked 1,200/scene (default)  ->  delivered ~1,075   attainment 0.91, 17 scenes, ~2.5h
    asked 3,600/scene            ->  delivered ~2,036   attainment 0.61,  6 scenes, ~50m

Delivery rises with the ask and saturates around 2,000, so 3,600 buys speed by
under-delivering, and attainment is a reported column. At 2,400 the plan is ~9
scenes and expected delivery ~1,900 each, which is roughly 0.86 attainment in
about 70 minutes — the point where speed stops costing the length column.

Four of the eight ids are also running in the default arm, so those four are a
paired comparison; the other four take the chapter side to n=8.

Reads the benchmark copy whose hash matches what `tiers-v2.json` declares and
what the scorer uses. The other copy on this machine differs in six of fifty
tasks, `task-romance-star-shipped` among them, in `required_elements` — the field
Expectation Fulfillment is graded on.
"""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

BENCH = Path.home() / "lane" / "livenovelbench" / "benchmarks" / "novelbench"
EXPECTED_SHA = "02fb0f2343d992f17b890424ebd5d4a38105da21d71a5472a1d316da51750db1"
WORDS_PER_SCENE = "2400"
TARGET = 20000

PAIRED = [
    "task-fantasy-daughter-of-crows",
    "task-horror-molka",
    "task-mystery-the-intrigue",
    "task-literary-john-of-john",
]
FRESH = [
    "task-historical-a-far-flung-life",
    "task-horror-the-sea-hides-its-dead",
    "task-literary-yesteryear",
    "task-romance-in-her-own-league",
]

OUT = Path(__file__).resolve().parent.parent / "runs-lnbch" / "tasks.jsonl"


def main() -> int:
    tasks_file = BENCH / "tasks.jsonl"
    sha = hashlib.sha256(tasks_file.read_bytes()).hexdigest()
    if sha != EXPECTED_SHA:
        print(f"{tasks_file} hashes {sha}, expected {EXPECTED_SHA}", file=sys.stderr)
        return 1

    # Reuse the renderer rather than restating it: the prompt has to carry the
    # premise, conflict, characters and every required element verbatim, and a
    # second copy of that logic is how a run gets graded on material it never saw.
    # Loaded by path because the module name has hyphens in it.
    import importlib.util

    gen_path = Path(__file__).resolve().parent / "make-lnb-tasks.py"
    spec = importlib.util.spec_from_file_location("make_lnb_tasks", gen_path)
    gen = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(gen)  # type: ignore[union-attr]
    render = gen.render_prompt
    short_id = gen.short_id

    tasks = {json.loads(l)["task_id"]: json.loads(l) for l in tasks_file.open()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with OUT.open("w") as fh:
        for task_id in PAIRED + FRESH:
            task = tasks[task_id]
            fh.write(
                json.dumps(
                    {
                        "task_id": short_id(task_id, "custom") + "-ch24",
                        "prompt": render(task, TARGET),
                        "target_words": TARGET,
                        "flags": ["--words-per-scene", WORDS_PER_SCENE],
                        "bench": "livenovelbench",
                        "bench_task_id": task_id,
                        "target_provenance": f"--target-words {TARGET} (2400/scene chapter arm)",
                        "source_tasks": str(tasks_file),
                        "source_tasks_sha256": sha,
                        "raw": task,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            written += 1
    print(f"{written} task(s) -> {OUT} at {TARGET:,} words, {WORDS_PER_SCENE}/scene")
    print(f"  from {tasks_file}\n  sha256 {sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
