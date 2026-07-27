#!/usr/bin/env python3
"""Build one iteration round: both benches in one task file.

The goal is SOTA on two benchmarks, so a round that exercises one of them is half
a round. Each iteration launches LongBench-Write tasks *and* LiveNovelBench tasks
together, both get scored, and the cases are read side by side — a fix that helps a
2,800-word story and breaks a 40,000-word one has to be visible in the same pass.

Two things this encodes rather than leaves to memory:

  * **LiveNovelBench tier membership.** Every baseline in Table 1 is scored at the
    40k target, so a 20k run of ours is not a comparable row however good it looks.
    The tier manifests also change: `tier-20k.json` went from ten ids to twelve
    while a run was in flight and moved one of the tasks we were running to the 80k
    tier. Tasks are therefore read from the manifest at build time and their target
    comes from `target_words_override`, never from a number typed here.
  * **The gateway ceiling.** Measured, above about four concurrent runs the gateway
    returns per-region and group-level 429s and the excess becomes backoff rather
    than throughput. A round is sized to that, not to the host, which stays near
    idle throughout.

    python3 smoke/round.py --lnb 2 --lbw lbw081 lbw079 --tier 40k --out runs-r1/tasks.jsonl
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

LNB = pathlib.Path.home() / "lane" / "livenovelbench" / "benchmarks" / "novelbench"
LBW = pathlib.Path.home() / "storyos" / "experiments" / "longbench-write"


def manifests_for(tier: str) -> list[pathlib.Path]:
    """
    The 40k tier is two files on purpose, and the reason is worth not undoing.

    `tiers-v2.json` explains it: `run_nbrun.config_summary` folds the manifest path
    and its task ids into the config digest, so appending the two top-up ids to the
    pinned subset would change that digest and mark all eighty committed 40k cells
    uncommitted. They are run separately and aggregated at report time.
    """
    if tier == "40k":
        return [LNB / "novelbench-tuning-subset.json", LNB / "tier-40k-topup.json"]
    return [LNB / f"tier-{tier}.json"]


def lnb_tasks(tier: str, count: int, skip: set[str]) -> list[dict]:
    ids: list[str] = []
    target: int | None = None
    for path in manifests_for(tier):
        if not path.exists():
            print(f"no manifest at {path}", file=sys.stderr)
            raise SystemExit(2)
        m = json.loads(path.read_text())
        if target is not None and m["target_words_override"] != target:
            print(f"{path} disagrees about the target for {tier}", file=sys.stderr)
            raise SystemExit(2)
        target = m["target_words_override"]
        ids += m["ids"]

    tasks = {json.loads(l)["task_id"]: json.loads(l) for l in open(LNB / "tasks.jsonl")}
    out = []
    for task_id in ids:
        if len(out) >= count:
            break
        if task_id in skip:
            continue
        t = tasks[task_id]
        out.append(
            {
                "task_id": f"lnb{tier}-{task_id.removeprefix('task-').replace('_', '')}",
                "prompt": render(t, target),
                "target_words": target,
                "bench": "livenovelbench",
                "bench_task_id": task_id,
                "tier": tier,
                "flags": [],
            }
        )
    return out


def render(task: dict, target: int) -> str:
    parts = [
        f"Write a complete {task['genre'].replace('_', ' ')} novel of about {target:,} words.",
        "",
        "Premise:",
        task["premise"].strip(),
        "",
        "Central conflict:",
        task["expected_conflict"].strip(),
    ]
    if task.get("characters"):
        parts += ["", "Characters:"] + [f"- {c.strip()}" for c in task["characters"]]
    if task.get("required_elements"):
        parts += ["", "The finished novel must contain all of the following:"]
        parts += [f"- {e.strip()}" for e in task["required_elements"]]
    parts += ["", "Write the novel itself — no outline, no commentary, no notes to the reader."]
    return "\n".join(parts)


def lbw_tasks(ids: list[str]) -> list[dict]:
    rows = {json.loads(l)["task_id"]: json.loads(l) for l in open(LBW / "tasks.jsonl")}
    out = []
    for task_id in ids:
        if task_id not in rows:
            print(f"{task_id} is not a LongBench-Write task", file=sys.stderr)
            raise SystemExit(1)
        r = rows[task_id]
        out.append(
            {
                "task_id": task_id,
                "prompt": r["prompt"],
                "target_words": r["length"],
                "bench": "longbench-write",
                "flags": [],
            }
        )
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lnb", type=int, default=2, help="how many LiveNovelBench tasks")
    ap.add_argument("--tier", default="40k", help="which tier to draw them from")
    ap.add_argument("--skip", nargs="*", default=[], help="bench task ids already run")
    ap.add_argument("--lbw", nargs="*", default=["lbw081", "lbw079"])
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    tasks = lnb_tasks(args.tier, args.lnb, set(args.skip)) + lbw_tasks(args.lbw)
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(t, ensure_ascii=False) + "\n" for t in tasks))

    print(f"{len(tasks)} task(s) -> {out}")
    for t in tasks:
        print(f"  {t['bench']:16s} {t['task_id']:44s} {t['target_words']:>6,} words")
    total = sum(t["target_words"] for t in tasks)
    print(
        f"\n{total:,} target words. At the measured ~1,200 tokens per delivered word that is "
        f"roughly {total * 1200 / 1e6:.0f}M tokens for the round."
    )
    print("Launch with concurrency 4 — the measured gateway ceiling:")
    print(
        f"  setsid env PATH=\"$HOME/bin/node22/bin:$PATH\" YS_KEY=\"$(cat ~/.config/ys/key)\" "
        f"nohup node --experimental-strip-types src/cli/run-batch.ts "
        f"--tasks {out} --runs {out.parent} --concurrency 4 --stagger 20 "
        f"> {out.parent}/batch.log 2>&1 &"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
