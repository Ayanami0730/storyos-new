#!/usr/bin/env python3
"""Export a finished run into the layout LiveNovelBench's scorers expect.

The contract, from the livenovelbench lane:

    ~/storyos-data/outputs/storyos/novelbench/
    ├── <task_id>.txt          # plain prose, paragraphs separated by blank lines
    └── metadata.jsonl         # one line per cell

    {"system":"storyos","bench":"novelbench","task_id":"…","target_words":20000}

Two things this refuses to do, both of them failures the two repositories have
already produced between them:

  * **It will not export a task that is not in the tier it is being scored at.**
    `target_words` decides attainment, and the tier manifest decides which target a
    task was asked for. `tier-20k.json` changed under us mid-run — it now holds
    twelve ids instead of ten — and `task-fantasy-the-girl-with-a-thousand-faces`
    moved to the 80k tier, so a 20,000-word run of it is off-manifest. Scoring it as
    a 20k cell would report a task against a length nobody asked it for, which is
    the exact mistake the batch runner's schema comments exist to prevent.
  * **It will not write `metadata.jsonl` without `target_words`.** Omitting it makes
    the pipeline fall back to the per-book anchored target in `tasks.jsonl` — 57k to
    142k words — and attainment comes out wrong rather than absent.

    python3 smoke/export-lnb.py runs-070/lnb20k-fantasy-daughter-of-crows/run \
        --task-id task-fantasy-daughter-of-crows --tier 20k
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

BENCH = pathlib.Path.home() / "lane" / "livenovelbench" / "benchmarks" / "novelbench"
DEST = pathlib.Path.home() / "storyos-data" / "outputs" / "storyos" / "novelbench"


def load_tiers() -> dict[str, tuple[set[str], int]]:
    """Tier -> (task ids, target words), from the one file that holds all four.

    Previously read as `tier-<tier>.json`, and there is no `tier-40k.json`: that
    tier is two files, the ten pinned tuning ids plus a two-id top-up, kept apart
    so adding the top-up cannot change the config digest of the ten already
    generated. The effect was that every 40k export was refused with "no tier
    manifest", which reads like a missing file rather than a naming assumption.

    `tiers-v2.json` carries all four tiers with their `topup_ids` folded in and is
    what the task generator already reads, so the two agree by construction rather
    than by both being edited.
    """
    payload = json.loads((BENCH / "tiers-v2.json").read_text())
    out: dict[str, tuple[set[str], int]] = {}
    for tier, spec in payload["tiers"].items():
        ids = set(spec["ids"]) | set(spec.get("topup_ids", []))
        if len(ids) != 12:
            raise SystemExit(f"tier {tier} resolves to {len(ids)} ids, expected 12")
        out[tier] = (ids, int(spec["target_words"]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("run", help="a run directory containing story.md")
    ap.add_argument("--task-id", required=True)
    ap.add_argument("--tier", required=True, help="20k | 40k | 60k | 80k | 100k")
    ap.add_argument("--dest", default=str(DEST))
    # Three scene-length arms run the same twelve tasks, so they cannot share a
    # destination: the layout is keyed by `task_id` and the second export would
    # overwrite the first, silently scoring one arm's manuscript as the other's.
    ap.add_argument("--system", default="storyos", help="system name in metadata.jsonl")
    ap.add_argument("--force-off-manifest", action="store_true",
                    help="export a task the tier does not list; it is not a Table 1 cell")
    args = ap.parse_args()

    tiers = load_tiers()
    if args.tier not in tiers:
        print(
            f"tier {args.tier} is not in tiers-v2.json (have: {', '.join(sorted(tiers))})",
            file=sys.stderr,
        )
        return 2
    ids, target = tiers[args.tier]

    if args.task_id not in ids:
        where = [t for t, (other, _) in tiers.items() if args.task_id in other]
        msg = (
            f"{args.task_id} is not in the {args.tier} tier"
            + (f" — it is in {', '.join(where)}" if where else "")
            + ". Scoring it here would report it against a length it was never asked for."
        )
        if not args.force_off_manifest:
            print(f"refused: {msg}", file=sys.stderr)
            print("Pass --force-off-manifest to export it anyway as a robustness "
                  "datapoint, which is not a Table 1 cell.", file=sys.stderr)
            return 1
        print(f"warning: {msg}", file=sys.stderr)

    story = pathlib.Path(args.run) / "story.md"
    if not story.exists():
        print(f"no story.md under {args.run} — the run has not finished", file=sys.stderr)
        return 1
    text = story.read_text()
    words = len(text.split())

    dest = pathlib.Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    (dest / f"{args.task_id}.txt").write_text(text)

    # Merged by task_id rather than appended, so re-exporting a rerun replaces its
    # row instead of leaving two rows that disagree about the same cell.
    meta_path = dest / "metadata.jsonl"
    rows = {}
    if meta_path.exists():
        for line in meta_path.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                rows[row["task_id"]] = row
    rows[args.task_id] = {
        "system": args.system,
        "bench": "novelbench",
        "task_id": args.task_id,
        "target_words": target,
        # Provenance, so a cell can be traced back to the harness version that wrote
        # it. Not required by the contract and cheap to carry.
        "source_run": str(pathlib.Path(args.run).resolve()),
        "harness_version": harness_version(pathlib.Path(args.run)),
        "words": words,
    }
    meta_path.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows.values())
    )

    print(f"{args.task_id}: {words:,} words -> {dest}/{args.task_id}.txt")
    print(f"  target {target:,} ({100 * words / target:.0f}% attainment), "
          f"{len(rows)} row(s) in metadata.jsonl")
    return 0


def harness_version(run: pathlib.Path) -> str | None:
    try:
        return json.loads((run / "summary.json").read_text()).get("harness_version")
    except OSError:
        return None


if __name__ == "__main__":
    raise SystemExit(main())
