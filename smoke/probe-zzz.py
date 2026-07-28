#!/usr/bin/env python3
"""Is zhizengzeng usable as a gpt-5-mini supply, and how wide can we open it?

The primary gateway spent this morning refusing us: a forty-minute
`401 Invalid token` window that truncated three runs at attainment 0.05–0.06,
then sustained `429 … swedencentral has exceeded rate limit` that killed four
more during planning — at concurrency 2, not just 4. That quota is not ours to
set; a second lane on this machine draws on the same group.

So the question for an alternative is not "does it answer" but "how many at once
before latency or errors move", and — because there is a spend ceiling per
account — what a unit of work costs. Both keys are probed separately, since two
accounts are two quotas and the whole point is to know each one's ceiling.

    probe-zzz.py --concurrency 1 2 4 8
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import statistics
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = os.environ.get("ZZZ_BASE", "https://api.zhizengzeng.com/v1")
KEYS = {
    "key": pathlib.Path.home() / ".config/zzz/key",
    "key2": pathlib.Path.home() / ".config/zzz/key2",
}

# gpt-5 models spend the budget on reasoning first, so a small cap returns
# `finish_reason: length` with empty content — which looks like a broken route
# and is not one. The first probe of this endpoint hit exactly that at 16.
DEFAULT_MAX_TOKENS = 700


def one(key: str, i: int, model: str, max_tokens: int) -> tuple[bool, float, int, str]:
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "user", "content": f"Write one plain sentence about the number {i}."}
            ],
            "max_tokens": max_tokens,
        }
    ).encode()
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            payload = json.load(r)
        dt = time.monotonic() - started
        if "error" in payload:
            return False, dt, 0, str(payload["error"])[:110]
        choice = payload["choices"][0]
        text = (choice["message"].get("content") or "").strip()
        total = (payload.get("usage") or {}).get("total_tokens", 0)
        if not text:
            return False, dt, total, f"empty, finish={choice.get('finish_reason')}"
        return True, dt, total, text[:56]
    except Exception as exc:  # noqa: BLE001 — reporting whatever happened is the point
        return False, time.monotonic() - started, 0, f"{type(exc).__name__}: {exc}"[:110]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--concurrency", type=int, nargs="+", default=[1, 2, 4, 8])
    ap.add_argument("--model", default="gpt-5-mini")
    ap.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    ap.add_argument("--keys", nargs="+", default=list(KEYS))
    a = ap.parse_args()

    print(f"{BASE}   model={a.model}   max_tokens={a.max_tokens}")
    for name in a.keys:
        path = KEYS[name]
        if not path.exists():
            print(f"\n[{name}] missing at {path}")
            continue
        key = path.read_text().strip()
        print(f"\n[{name}]")
        print(f"{'conc':>5s} {'ok':>4s} {'fail':>5s} {'p50':>7s} {'max':>7s} {'wall':>7s} {'req/s':>6s} {'tok/req':>8s}")
        for c in a.concurrency:
            started = time.monotonic()
            with ThreadPoolExecutor(max_workers=c) as pool:
                futures = [pool.submit(one, key, i, a.model, a.max_tokens) for i in range(c)]
                results = [f.result() for f in as_completed(futures)]
            wall = time.monotonic() - started
            ok = [r for r in results if r[0]]
            bad = [r for r in results if not r[0]]
            lat = sorted(r[1] for r in ok) or [0.0]
            tok = statistics.mean([r[2] for r in ok]) if ok else 0
            print(
                f"{c:5d} {len(ok):4d} {len(bad):5d} {statistics.median(lat):6.1f}s "
                f"{max(lat):6.1f}s {wall:6.1f}s {len(ok) / max(wall, 0.001):6.2f} {tok:8.0f}"
            )
            for _, _, _, why in bad[:2]:
                print(f"        failed: {why}")
        print(f"        sample: {ok[0][3] if ok else '(none)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
