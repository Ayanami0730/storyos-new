#!/usr/bin/env python3
"""Read a run's transcripts and answer the questions a score cannot.

Written because "read the trajectories and find what to fix" is a real instruction
and grepping five JSONL files by hand is not a procedure. Every number it prints is
one that has, at least once, contradicted what the prompts claim the system does:

  * how many times each role actually reached for the shell, against a brief that
    tells it to read the index (measured before: three reads in a nineteen-scene
    run, against the context-builder's forty-eight);
  * what the orchestrator put in its briefs, since a brief that supplies invented
    facts is the one way to misuse delegation;
  * whether a name a reader sees in the prose is anywhere in the material the
    writer was handed, which decides whether scene 12 can still spell it.

Usage: python3 smoke/probe-trajectory.py runs-070/lbw081/run [--name Marian]
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path


def load(role_dir: Path) -> list[dict]:
    records = []
    for f in sorted(role_dir.glob("*.jsonl")):
        for line in f.read_text(errors="replace").splitlines():
            if line.strip():
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return records


def text_of(value) -> str:
    """Flatten whatever shape a message body is in into searchable text."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(text_of(v) for v in value)
    if isinstance(value, dict):
        return "\n".join(text_of(v) for k, v in value.items() if k != "role")
    return str(value)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--name", action="append", default=[], help="a name from the prose to trace")
    args = ap.parse_args()

    run = Path(args.run)
    transcripts = run / "project" / "runtime" / "transcripts"
    if not transcripts.is_dir():
        print(f"no transcripts under {transcripts}")
        return 1

    print(f"# {run}")
    summary_path = run / "summary.json"
    if summary_path.exists():
        s = json.loads(summary_path.read_text())
        print(
            f"version {s.get('harness_version')}  words {s.get('words')}/{s.get('target_words')}  "
            f"scenes {s.get('scenes_committed')}/{s.get('scenes_planned')}  "
            f"findings {s.get('findings_total')}  by_axis {s.get('findings_by_axis')}"
        )
        print(f"models {s.get('models')}")

    per_role_tools: dict[str, Counter] = {}
    for role_dir in sorted(transcripts.iterdir()):
        if not role_dir.is_dir():
            continue
        records = load(role_dir)
        tools: Counter = Counter()
        turns = 0
        prompts = 0
        refusals = 0
        for r in records:
            role = r.get("role")
            if role == "assistant":
                turns += 1
                for c in r.get("content") or []:
                    if c.get("type") == "toolCall":
                        tools[c.get("name", "?")] += 1
            elif role == "user":
                prompts += 1
            elif role == "toolResult":
                body = text_of(r.get("content"))
                if body.lstrip().startswith(("refused", "rejected")) or "refused:" in body[:80]:
                    refusals += 1
        per_role_tools[role_dir.name] = tools
        print(
            f"\n## {role_dir.name}: {turns} assistant turn(s), {prompts} prompt(s) received, "
            f"{sum(tools.values())} tool call(s), {refusals} refused"
        )
        if tools:
            print("   " + ", ".join(f"{k}×{v}" for k, v in tools.most_common(14)))

    # Where a name a reader sees actually lives. If it is only ever in the writer's
    # own output and never in what the writer was given, the next scene can only get
    # it right by luck — and the recall window is one to three scenes deep.
    for name in args.name:
        print(f"\n## trace of {name!r}")
        for role_dir in sorted(transcripts.iterdir()):
            if not role_dir.is_dir():
                continue
            hits = sum(text_of(r).count(name) for r in load(role_dir))
            print(f"   {role_dir.name}: {hits} mention(s)")
        index = run / "project"
        in_index = 0
        for path in index.rglob("*"):
            if path.is_file() and path.suffix in {".yaml", ".jsonl", ".json", ".md", ".csv"}:
                if "runtime" in path.parts or "novel/chapters" in str(path):
                    continue
                try:
                    in_index += path.read_text(errors="replace").count(name)
                except OSError:
                    pass
        print(f"   the index outside the manuscript: {in_index} mention(s)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
