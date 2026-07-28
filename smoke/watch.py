#!/usr/bin/env python3
"""A monitor that reports events, and only ones that happened after it started.

The first version of this read each batch log from the top and replayed hours of
history as if it were news, and it flagged the VALIDATING deadlock as having
returned on 0.9.11 when the two summaries carrying it were 0.9.10 leftovers on
disk. A monitor that cries wolf is worse than none: the next real alert gets read
as noise. So both mistakes are fixed structurally rather than by filtering — the
log is followed from the byte offset it had at startup, so history cannot be
re-emitted, and the deadlock check reads the version out of the summary rather
than trusting the file's presence.

    watch.py                 # follow until every batch has drained
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
BATCHES = ["runs-lbw21", "runs-60kv2", "runs-40kv2", "runs-lnb20k", "runs-lnb"]
LIVE_VERSION = "0.9.11"
EVENT = re.compile(r" (done|FAILED) in ")


def active_log(batch: str) -> Path | None:
    """The log the running batch is writing, which is not always `batch.log`.

    `runs-lnb` has seven logs from seven rounds; reading the wrong one is how the
    first monitor reported a failure from thirteen hours earlier.
    """
    logs = sorted((ROOT / batch).glob("*.log"), key=lambda p: p.stat().st_mtime)
    return logs[-1] if logs else None


def parent_alive(batch: str) -> bool:
    out = subprocess.run(
        ["ps", "-u", os.environ.get("USER", ""), "-o", "args="],
        capture_output=True, text=True,
    ).stdout
    return f"--runs {batch}" in out


def cells_running(batch: str) -> int:
    out = subprocess.run(
        ["ps", "-u", os.environ.get("USER", ""), "-o", "args="],
        capture_output=True, text=True,
    ).stdout
    return sum(
        1 for line in out.splitlines()
        if "cli/write-story" in line and f"/{batch}/" in line
    )


def deadlocked_on_live_version() -> list[str]:
    """Runs that hit the VALIDATING deadlock *on the version now in use*.

    The version test is the whole point. Two summaries on disk carry the deadlock
    from 0.9.10, and their mere existence is not evidence about 0.9.11.
    """
    hits = []
    for batch in BATCHES:
        for p in (ROOT / batch).glob("*/summary-stdout.json"):
            try:
                d = json.loads(p.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            if d.get("harness_version") != LIVE_VERSION:
                continue
            blob = json.dumps(d.get("failures", []), ensure_ascii=False)
            if "no fresh draft" in blob or "ended in VALIDATING" in blob:
                hits.append(f"{batch}/{p.parent.name}")
    return hits


def checker_crashes() -> list[str]:
    """Runs where the deterministic layer threw — now survivable, still a defect."""
    out = []
    for batch in BATCHES:
        for p in (ROOT / batch).glob("*/summary-stdout.json"):
            try:
                d = json.loads(p.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            n = d.get("deterministic_failures") or 0
            if n:
                out.append(f"{batch}/{p.parent.name}:{n}")
    return out


def say(text: str) -> None:
    print(f"EVENT {time.strftime('%H:%M:%S')} {text}", flush=True)


def main() -> int:
    offsets: dict[str, int] = {}
    for b in BATCHES:
        log = active_log(b)
        offsets[b] = log.stat().st_size if log else 0
        say(f"{b} following {log.name if log else '(no log)'} "
            f"from byte {offsets[b]}, {cells_running(b)} cell(s) running")

    drained: set[str] = set()
    announced_deadlock: set[str] = set()
    announced_crash: set[str] = set()

    while True:
        for b in BATCHES:
            log = active_log(b)
            if log is None:
                continue
            size = log.stat().st_size
            if size > offsets.get(b, 0):
                with log.open("r", errors="replace") as fh:
                    fh.seek(offsets[b])
                    fresh = fh.read()
                offsets[b] = size
                for line in fresh.splitlines():
                    if EVENT.search(line):
                        say(f"{b} {line.strip()}")
            elif size < offsets.get(b, 0):
                # A new round rotated the log; follow the new one from its start.
                offsets[b] = 0

            if b not in drained and not parent_alive(b) and cells_running(b) == 0:
                drained.add(b)
                say(f"{b} BATCH DRAINED")

        for cell in deadlocked_on_live_version():
            if cell not in announced_deadlock:
                announced_deadlock.add(cell)
                say(f"ALERT the VALIDATING deadlock is back on {LIVE_VERSION}: {cell}")

        for cell in checker_crashes():
            if cell not in announced_crash:
                announced_crash.add(cell)
                say(f"ALERT deterministic layer crashed (scene survived): {cell}")

        if all(b in drained for b in BATCHES):
            say("ALL BATCHES DRAINED")
            return 0
        time.sleep(120)


if __name__ == "__main__":
    raise SystemExit(main())
