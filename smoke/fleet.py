#!/usr/bin/env python3
"""One table for the whole fleet: which cell, which harness version, which route,
how far, how fast, and how much longer.

Written because the three questions that actually gate the deadline — what is
generating, what is scorable, and when does the last cell land — were being
answered from three different places (tmux scrollback, status.sh, summary files)
and the three disagreed. A cell's route matters as much as its version: a number
produced on a route with a different reasoning default is not automatically
comparable, so the route is printed next to the score-bearing columns rather
than looked up later.

Progress for a live cell comes from the chapter files on disk, not from the
summary, because the summary is only written when the run finishes.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CJK = re.compile(r"[\u4e00-\u9fff]")
LATIN = re.compile(r"\b[a-zA-Z]+\b")

BATCHES = [
    "runs-lbw21",
    "runs-20kv2",
    "runs-40kv2",
    "runs-60kv2",
    "runs-lnb20k",
    "runs-lnb",
    "runs-lnbch",
    "runs-ch21",
]


def bench_words(text: str) -> int:
    """The benchmark's own count: CJK codepoints plus Latin word tokens."""
    return len(CJK.findall(text)) + len(LATIN.findall(text))


def live_pids() -> dict[tuple[str, str], float]:
    """(batch, cell) -> elapsed seconds, for runs whose process is still up."""
    out = subprocess.run(
        ["ps", "-u", os.environ.get("USER", ""), "-o", "etimes=,args="],
        capture_output=True,
        text=True,
    ).stdout
    live: dict[tuple[str, str], float] = {}
    for line in out.splitlines():
        if "cli/write-story" not in line:
            continue
        m = re.search(r"storyos-v3/(runs-[a-z0-9]+)/([^/]+)/run", line)
        if not m:
            continue
        etimes = float(line.split()[0])
        live[(m.group(1), m.group(2))] = etimes
    return live


def cell_rows(batch: str, live: dict[tuple[str, str], float]) -> list[dict]:
    rows = []
    bdir = ROOT / batch
    if not bdir.is_dir():
        return rows
    for cell in sorted(p for p in bdir.iterdir() if p.is_dir()):
        proj = cell / "run" / "project"
        if not proj.is_dir():
            continue
        chapters = proj / "novel" / "chapters"
        text = ""
        scenes = 0
        if chapters.is_dir():
            for md in sorted(chapters.rglob("*.md")):
                scenes += 1
                text += md.read_text(errors="replace")
        words = bench_words(text)

        beats = proj / "novel" / "outline" / "beats.yaml"
        planned = 0
        if beats.is_file():
            planned = sum(
                1 for line in beats.read_text(errors="replace").splitlines()
                if line.startswith("  - id:")
            )

        summary = cell / "summary-stdout.json"
        ver = route = None
        target = wps = None
        attain = elapsed = None
        fatal = None
        backfill = None
        if summary.is_file():
            try:
                s = json.loads(summary.read_text())
                ver = s.get("harness_version")
                route = (s.get("supply") or {}).get("id")
                target = s.get("target_words")
                wps = s.get("words_per_scene")
                attain = s.get("attainment")
                elapsed = (s.get("elapsed_ms") or 0) / 1000
                fatal = s.get("fatal")
                backfill = s.get("backfill_failures")
            except json.JSONDecodeError:
                pass

        running = (batch, cell.name) in live
        age = live.get((batch, cell.name))
        # For a live cell the summary is from a previous attempt (or absent), so
        # version/route come from the run log instead.
        if running:
            log = cell / "run.log"
            if log.is_file():
                head = log.read_text(errors="replace")[:4000]
                m = re.search(r"harness (?:version )?v?(0\.\d+\.\d+)", head)
                if m:
                    ver = m.group(1)

        rows.append(
            dict(
                batch=batch,
                cell=cell.name,
                ver=ver,
                route=route,
                scenes=scenes,
                planned=planned,
                words=words,
                target=target,
                wps=wps,
                attain=attain,
                elapsed=elapsed,
                age=age,
                running=running,
                fatal=fatal,
                backfill=backfill,
            )
        )
    return rows


def fmt_min(sec) -> str:
    if not sec:
        return "-"
    return f"{sec/60:.0f}m"


def main() -> None:
    live = live_pids()
    all_rows: list[dict] = []
    for b in BATCHES:
        all_rows += cell_rows(b, live)

    print(f"== fleet at {time.strftime('%H:%M:%S')} local ==")
    print(f"live write-story processes: {len(live)}")
    print()
    hdr = (
        f"{'batch':<12} {'cell':<44} {'ver':<7} {'route':<20} "
        f"{'sc':>6} {'words':>7} {'tgt':>6} {'att':>5} {'wall':>6} {'state':<8}"
    )
    print(hdr)
    print("-" * len(hdr))
    for r in all_rows:
        if r["running"]:
            state = "RUN"
            wall = fmt_min(r["age"])
        elif r["fatal"]:
            state = "FATAL"
            wall = fmt_min(r["elapsed"])
        elif r["scenes"] and r["planned"] and r["scenes"] >= r["planned"]:
            state = "done"
            wall = fmt_min(r["elapsed"])
        else:
            state = "stopped"
            wall = fmt_min(r["elapsed"])
        att = "-" if r["attain"] is None else f"{r['attain']:.2f}"
        print(
            f"{r['batch']:<12} {r['cell']:<44} {str(r['ver'] or '-'):<7} "
            f"{str(r['route'] or '-'):<20} "
            f"{r['scenes']:>3}/{r['planned']:<2} {r['words']:>7} "
            f"{str(r['target'] or '-'):>6} "
            f"{att:>5} {wall:>6} {state:<8}"
        )

    # Per-scene minutes by route: the only speed number that survives comparison
    # across arms, since the arms deliberately differ in how many scenes a book
    # is cut into.
    print()
    print("== minutes per committed scene, by route x words-per-scene ==")
    buckets: dict[tuple[str, object], list[float]] = {}
    for r in all_rows:
        if r["running"] or not r["elapsed"] or not r["scenes"]:
            continue
        if r["fatal"]:
            continue
        buckets.setdefault((r["route"] or "-", r["wps"]), []).append(
            r["elapsed"] / 60 / r["scenes"]
        )
    for (route, wps), vals in sorted(buckets.items(), key=lambda kv: str(kv[0])):
        vals.sort()
        mid = vals[len(vals) // 2]
        print(
            f"  {route:<22} wps={str(wps):<6} n={len(vals):<3} "
            f"median {mid:5.1f} min/scene   range {vals[0]:.1f}-{vals[-1]:.1f}"
        )

    # Live cells: extrapolate from the pace they have actually shown.
    print()
    print("== eta for live cells (from their own observed pace) ==")
    etas = []
    for r in all_rows:
        if not r["running"] or not r["scenes"] or not r["age"]:
            continue
        per = r["age"] / r["scenes"]
        left = max(0, (r["planned"] or r["scenes"]) - r["scenes"])
        eta = per * left / 60
        etas.append((eta, r, per / 60))
    for eta, r, per in sorted(etas):
        print(
            f"  {r['batch']:<12} {r['cell']:<44} "
            f"{r['scenes']:>2}/{r['planned']:<2} "
            f"{per:5.1f} min/scene  eta ~{eta:5.0f} min"
        )
    if etas:
        print(f"  --> last cell lands in about {max(e for e, _, _ in etas)/60:.1f} h")


if __name__ == "__main__":
    main()
