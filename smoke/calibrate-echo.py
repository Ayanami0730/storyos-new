#!/usr/bin/env python3
"""How often would the restatement check fire on manuscripts we already have?

A new blocking check is only worth adding if it is rare enough to be a signal. Runs
the detector over every committed scene of finished runs, comparing each scene with
itself and with the one before it, and prints firings per scene plus samples to read.

    smoke/calibrate-echo.py runs-60kv2 runs-20kv2
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NODE = Path.home() / "bin" / "node22" / "bin" / "node"

DRIVER = r"""
import { findEchoes } from "./src/verification/echo.ts";
import { readFileSync } from "node:fs";
const jobs = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = [];
for (const job of jobs) {
  const echoes = findEchoes(job.prose, job.preceding ? { preceding: job.preceding } : {});
  out.push({ id: job.id, n: echoes.length, echoes: echoes.slice(0, 2) });
}
process.stdout.write(JSON.stringify(out));
"""


def scenes_of(run: Path) -> list[tuple[str, str]]:
    chapters = run / "run" / "project" / "novel" / "chapters"
    if not chapters.is_dir():
        return []
    scenes = sorted(chapters.glob("ch-*/scenes/s-*.md"), key=lambda p: p.stem)
    return [(f"{run.name}/{p.stem}", p.read_text(errors="replace")) for p in scenes]


def main() -> int:
    roots = [REPO / a for a in sys.argv[1:]] or [REPO / "runs-60kv2"]
    jobs = []
    for root in roots:
        if not root.is_dir():
            continue
        for run in sorted(root.iterdir()):
            scenes = scenes_of(run)
            for i, (sid, prose) in enumerate(scenes):
                job = {"id": sid, "prose": prose}
                if i > 0:
                    job["preceding"] = scenes[i - 1][1]
                jobs.append(job)
    if not jobs:
        print("no committed manuscripts found")
        return 1

    payload = REPO / ".echo-calibration.json"
    payload.write_text(json.dumps(jobs))
    driver = REPO / ".echo-driver.ts"
    driver.write_text(DRIVER)
    try:
        raw = subprocess.run(
            [str(NODE), "--experimental-strip-types", str(driver), str(payload)],
            cwd=REPO,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    finally:
        payload.unlink(missing_ok=True)
        driver.unlink(missing_ok=True)

    rows = json.loads(raw)
    fired = [r for r in rows if r["n"] > 0]
    total = sum(r["n"] for r in rows)
    print(f"{len(rows)} scenes, {len(fired)} would raise a finding "
          f"({len(fired) / len(rows):.0%}), {total} findings total, "
          f"{total / len(rows):.2f} per scene (capped at 2 in the harness)")
    print()
    for r in sorted(fired, key=lambda r: -r["n"])[:8]:
        e = r["echoes"][0]
        print(f"-- {r['id']}  n={r['n']}  run={e['runWords']}w  from={e['from']}  "
              f"distance={e['distanceWords']}w")
        print(f"   later:   {e['quote'][:150]}")
        print(f"   earlier: {e['earlier'][:150]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
