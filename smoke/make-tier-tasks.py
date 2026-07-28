#!/usr/bin/env python3
"""Task files for a whole LiveNovelBench tier, from the tier manifest itself.

Table 1 is twelve tasks per tier and the paper's scope is every tier at 60k and
below, so the ids must come from `tiers-v2.json` rather than from a list retyped
into a script — the 20k file was written by hand and there is no way to tell, from
reading it, whether it matched the manifest.

Two things are checked rather than assumed. The benchmark file's hash must equal
what the scorer reads: the other copy of `tasks.jsonl` on this machine differs in
six of fifty tasks, and one of the differences is `required_elements`, which is
the field Expectation Fulfillment is scored against. And ids already generated or
running are skipped unless `--force`, so a top-up cannot silently re-run a cell
that is three hours into a 60k manuscript.

    make-tier-tasks.py 60k --runs runs-60k --words-per-scene 2400
    make-tier-tasks.py 40k --runs runs-40k --skip-running
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path

BENCH = Path.home() / "lane" / "livenovelbench" / "benchmarks" / "novelbench"
EXPECTED_SHA = "02fb0f2343d992f17b890424ebd5d4a38105da21d71a5472a1d316da51750db1"
ROOT = Path(__file__).resolve().parent.parent


def load_generator():
    spec = importlib.util.spec_from_file_location(
        "make_lnb_tasks", Path(__file__).resolve().parent / "make-lnb-tasks.py"
    )
    gen = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(gen)  # type: ignore[union-attr]
    return gen


def already_covered() -> dict[str, str]:
    """bench_task_id -> where it is already generated, across every batch here.

    Read from the task files rather than from directory names: a cell directory is
    named by our short id, and the mapping back to the benchmark id is exactly the
    thing that must not be guessed.
    """
    seen: dict[str, str] = {}
    for tasks in sorted(ROOT.glob("runs-*/tasks*.jsonl")):
        for line in tasks.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            bench_id = row.get("bench_task_id")
            if bench_id:
                seen.setdefault(bench_id, tasks.parent.name)
    return seen


def running_cells() -> set[str]:
    out = subprocess.run(
        ["ps", "-u", "", "-o", "args="], capture_output=True, text=True
    ).stdout
    return {line for line in out.splitlines() if "cli/write-story" in line}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("tier", choices=["20k", "40k", "60k", "80k"])
    ap.add_argument("--runs", required=True, help="batch directory to write tasks.jsonl into")
    ap.add_argument("--words-per-scene", type=int, default=0, help="0 keeps the default")
    ap.add_argument(
        "--include-covered",
        action="store_true",
        help="regenerate ids another batch already holds (use when redoing a tier on a new version)",
    )
    args = ap.parse_args()

    tasks_file = BENCH / "tasks.jsonl"
    sha = hashlib.sha256(tasks_file.read_bytes()).hexdigest()
    if sha != EXPECTED_SHA:
        raise SystemExit(
            f"{tasks_file} hashes {sha}, expected {EXPECTED_SHA}. The scorer reads a "
            f"different file than this one, so a manuscript would be graded against "
            f"required_elements it never saw."
        )

    tiers = json.loads((BENCH / "tiers-v2.json").read_text())
    tier = tiers["tiers"][args.tier]
    ids: list[str] = list(tier["ids"])
    target = int(tier["target_words"])
    # The 40k tier carries two ids in a separate top-up manifest.
    for extra in tier.get("topup_ids", []):
        if extra not in ids:
            ids.append(extra)
    if len(ids) != 12:
        raise SystemExit(f"tier {args.tier} lists {len(ids)} ids, expected 12")

    covered = already_covered()
    gen = load_generator()
    tasks = {json.loads(l)["task_id"]: json.loads(l) for l in tasks_file.open()}

    wps = args.words_per_scene
    suffix = f"-ch{wps // 100}" if wps else ""
    chosen, skipped = [], []
    for task_id in ids:
        if not args.include_covered and task_id in covered:
            skipped.append((task_id, covered[task_id]))
            continue
        chosen.append(task_id)

    out = ROOT / args.runs / "tasks.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as fh:
        for task_id in chosen:
            task = tasks[task_id]
            fh.write(
                json.dumps(
                    {
                        "task_id": gen.short_id(task_id, "custom") + suffix,
                        "prompt": gen.render_prompt(task, target),
                        "target_words": target,
                        "flags": (["--words-per-scene", str(wps)] if wps else []),
                        "bench": "livenovelbench",
                        "bench_task_id": task_id,
                        "target_provenance": (
                            f"--target-words {target} ({args.tier} tier, "
                            f"{str(wps) + '/scene' if wps else 'default scenes'})"
                        ),
                        "source_tasks": str(tasks_file),
                        "source_tasks_sha256": sha,
                        "raw": task,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

    print(f"tier {args.tier}: target {target:,} words, {len(ids)} ids in the manifest")
    for task_id, where in skipped:
        print(f"  skip  {task_id}  (already in {where})")
    print(f"{len(chosen)} task(s) -> {out}"
          f"{f' at {wps} words/scene' if wps else ' at default scene length'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
