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
BATCHES = ["runs-lbw21", "runs-60kv2", "runs-40kv2", "runs-20kv2", "runs-lnb20k", "runs-lnb"]
#: Versions currently producing manuscripts. A list rather than one string because
#: a batch that outlives a tag pick up the newer code on its next spawned cell:
#: `runs-lbw21` produced seventeen cells on 0.9.11 and four on 0.9.12 without
#: anything being restarted, and a deadlock check keyed on one of them would have
#: stopped watching the other.
LIVE_VERSIONS = {"0.9.11", "0.9.12", "0.9.13"}
POLL_SECONDS = 120
#: Refusals per minute worth interrupting for. Measured baseline: 34 cells on the
#: internal route produced about 340 refusals over four hours (~1.4/min) with
#: per-scene pace unchanged at 11.2 min against 9.2-11.8 before, so that rate is
#: absorbed. Ten a minute is not.
PUSHBACK_PER_MIN_ALERT = 10.0
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
    """Runs that hit the VALIDATING deadlock *on a version now in use*.

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
            if d.get("harness_version") not in LIVE_VERSIONS:
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


PUSHBACK = re.compile(r"429|上游负载已饱和|quota_not_enough")


def pushback_count() -> int:
    """Gateway refusals across the live batches, cumulative."""
    n = 0
    for batch in BATCHES:
        for log in (ROOT / batch).glob("*.log"):
            try:
                n += len(PUSHBACK.findall(log.read_text(errors="replace")))
            except OSError:
                continue
    return n


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
    last429 = -1

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
                say(f"ALERT the VALIDATING deadlock is back on a live version: {cell}")

        for cell in checker_crashes():
            if cell not in announced_crash:
                announced_crash.add(cell)
                say(f"ALERT deterministic layer crashed (scene survived): {cell}")

        # Gateway pushback, by rate rather than by total. A cumulative count crosses
        # any fixed threshold eventually just by the run being long, which is how the
        # first version of this alert fired on a fleet whose per-scene pace was
        # unchanged — 340 refusals fully absorbed by request-level retries. What
        # matters is acceleration: refusals arriving faster than the fleet is
        # committing scenes means concurrency has turned into backoff.
        now429 = pushback_count()
        rate = (now429 - last429) / (POLL_SECONDS / 60.0)
        if last429 >= 0 and rate > PUSHBACK_PER_MIN_ALERT:
            say(
                f"ALERT gateway pushback at {rate:.0f}/min ({now429} total) — "
                f"check smoke/pace.py before adding load"
            )
        last429 = now429

        if all(b in drained for b in BATCHES):
            say("ALL BATCHES DRAINED")
            return 0
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
