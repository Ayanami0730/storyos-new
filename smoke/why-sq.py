#!/usr/bin/env python3
"""What the LongBench-Write judge actually objects to, in its own words.

The judge's prompt asks for an `Analysis` before the six scores, and the frozen
scorer parses the scores and discards the analysis. That analysis is the only
direct statement of why a manuscript scored what it did, and without it the
quality deficit can only be guessed at — three plausible mechanisms for our
uniform -0.6 in `S_q` (scene count, over-delivery, formatting artefacts) were each
tested against the score data and each came out flat.

Paired on purpose. A criticism of our manuscript means little until you know
whether the same judge said it about the system that beat us on the same task, so
each task is judged twice, ours and a comparison system's, and the two analyses
are printed together.

This is a diagnostic and writes nowhere near the frozen scorer's outputs. It
re-uses `judge.txt` verbatim and the same model and endpoint, so what it reports is
what the scorer saw — but its results are never a score.

    why-sq.py lbw067 lbw112 lbw119            # ours vs agentwrite
    why-sq.py --against bare-long-context lbw103
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.request import Request, urlopen

LBW = Path(os.environ.get("LBW_ROOT", Path.home() / "storyos/experiments/longbench-write"))
REPO = Path(__file__).resolve().parent.parent
BASE_URL = "https://ai-prod-sg.wenxiaobai.com"
JUDGE_MODEL = "gpt-5.5"
MAX_COMPLETION_TOKENS = 4_096


def judge(prompt: str, key: str) -> str:
    body = json.dumps(
        {
            "model": JUDGE_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_completion_tokens": MAX_COMPLETION_TOKENS,
        }
    ).encode()
    last: Exception | None = None
    for attempt in range(3):
        try:
            req = Request(
                f"{BASE_URL}/v1/chat/completions",
                data=body,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(req, timeout=600) as resp:
                payload = json.loads(resp.read().decode())
            return payload["choices"][0]["message"]["content"]
        except Exception as error:  # noqa: BLE001
            last = error
            time.sleep(2.0**attempt)
    raise RuntimeError(f"judge transport failed: {last}")


def parse(text: str) -> dict:
    candidate = text.strip()
    fenced = re.search(r"```json\n(.*?)\n```", candidate, re.DOTALL)
    if fenced:
        candidate = fenced.group(1)
    start, end = candidate.find("{"), candidate.rfind("}")
    if start >= 0 and end > start:
        candidate = candidate[start : end + 1]
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return {"Analysis": text[:1500]}


def our_manuscript(task: str, batch: str) -> tuple[str, str] | None:
    cell = REPO / batch / task
    story = cell / "run" / "story.md"
    prompt = cell / "task.json"
    if not (story.is_file() and prompt.is_file()):
        return None
    return json.loads(prompt.read_text())["prompt"], story.read_text()


def their_manuscript(task: str, system: str) -> str | None:
    p = LBW / "outputs" / system / "longbench-write" / f"{task}.txt"
    return p.read_text(errors="replace") if p.is_file() else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("tasks", nargs="+")
    ap.add_argument("--batch", default="runs-lbw21")
    ap.add_argument("--against", default="agentwrite")
    ap.add_argument("--out", default="/tmp/why-sq.json")
    args = ap.parse_args()

    key = (Path.home() / ".config/ys/key").read_text().strip()
    template = (LBW / "judge.txt").read_text()

    jobs = []
    for task in args.tasks:
        ours = our_manuscript(task, args.batch)
        if ours is None:
            print(f"  skip {task}: no manuscript under {args.batch}", file=sys.stderr)
            continue
        instruction, text = ours
        jobs.append((task, "ours", instruction, text))
        theirs = their_manuscript(task, args.against)
        if theirs:
            jobs.append((task, args.against, instruction, theirs))

    results: dict[tuple[str, str], dict] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            pool.submit(
                judge,
                template.replace("$INST$", inst).replace("$RESPONSE$", body),
                key,
            ): (task, who)
            for task, who, inst, body in jobs
        }
        for fut in as_completed(futures):
            task, who = futures[fut]
            try:
                results[(task, who)] = parse(fut.result())
            except Exception as error:  # noqa: BLE001
                results[(task, who)] = {"Analysis": f"(judge failed: {error})"}

    dims = ("Relevance", "Accuracy", "Coherence", "Clarity",
            "Breadth and Depth", "Reading Experience")
    for task in args.tasks:
        if (task, "ours") not in results:
            continue
        print("=" * 100)
        print(f"### {task}")
        for who in ("ours", args.against):
            r = results.get((task, who))
            if not r:
                continue
            scores = " ".join(f"{d.split()[0][:5]}={r.get(d, '?')}" for d in dims)
            print(f"\n--- {who}   {scores}")
            print(f"    {r.get('Analysis', '(no analysis)')}")
        print()

    Path(args.out).write_text(
        json.dumps({f"{t}|{w}": v for (t, w), v in results.items()},
                   ensure_ascii=False, indent=2)
    )
    print(f"-> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
