#!/usr/bin/env python3
"""How wide can a given route be opened before it stops paying?

Generalised from the zhizengzeng probe, because there is now more than one place
to buy gpt-5-mini and the interesting number is never "does it answer" — it is
the concurrency at which latency starts rising without throughput following.
Below that knee, adding workers adds work done; above it, they queue.

    probe-supply.py --base https://ai-prod-sg-internal.wenxiaobai.com/v1 \
                    --model openai/gpt-5-mini --key-file ~/.config/ys/key \
                    --concurrency 4 8 16 24
"""

from __future__ import annotations

import argparse
import json
import pathlib
import statistics
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

# gpt-5 models spend the budget on reasoning before they emit anything, so a
# small cap returns `finish_reason: length` with empty content — which reads as a
# broken route and is not one. Measured: 16 tokens produced exactly that.
DEFAULT_MAX_TOKENS = 600


def one(base: str, key: str, model: str, i: int, max_tokens: int) -> tuple[bool, float, int, str]:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": f"Write one plain sentence about the number {i}."}],
    }
    # The gateway's OpenAI-completions path takes `max_completion_tokens` for the
    # gpt-5 family and rejects `max_tokens`; other routes are the other way round.
    payload["max_completion_tokens" if "wenxiaobai" in base else "max_tokens"] = max_tokens
    req = urllib.request.Request(
        f"{base.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            body = json.load(r)
        dt = time.monotonic() - started
        if "error" in body:
            return False, dt, 0, str(body["error"])[:110]
        choice = body["choices"][0]
        text = (choice["message"].get("content") or "").strip()
        used = (body.get("usage") or {}).get("total_tokens", 0)
        if not text:
            return False, dt, used, f"empty, finish={choice.get('finish_reason')}"
        return True, dt, used, text[:56]
    except Exception as exc:  # noqa: BLE001 — reporting whatever happened is the point
        return False, time.monotonic() - started, 0, f"{type(exc).__name__}: {exc}"[:110]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--key-file", required=True)
    ap.add_argument("--concurrency", type=int, nargs="+", default=[1, 4, 8, 16])
    ap.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    a = ap.parse_args()

    key = pathlib.Path(a.key_file).expanduser().read_text().strip()
    print(f"{a.base}   model={a.model}   max_tokens={a.max_tokens}")
    print(f"{'conc':>5s} {'ok':>4s} {'fail':>5s} {'p50':>7s} {'p90':>7s} {'max':>7s} {'wall':>7s} {'req/s':>7s}")
    best = (0.0, 0)
    for c in a.concurrency:
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=c) as pool:
            futures = [pool.submit(one, a.base, key, a.model, i, a.max_tokens) for i in range(c)]
            results = [f.result() for f in as_completed(futures)]
        wall = time.monotonic() - started
        ok = [r for r in results if r[0]]
        bad = [r for r in results if not r[0]]
        lat = sorted(r[1] for r in ok) or [0.0]
        rate = len(ok) / max(wall, 0.001)
        if rate > best[0]:
            best = (rate, c)
        p90 = lat[min(len(lat) - 1, int(len(lat) * 0.9))] if lat else 0
        print(
            f"{c:5d} {len(ok):4d} {len(bad):5d} {statistics.median(lat):6.1f}s "
            f"{p90:6.1f}s {max(lat):6.1f}s {wall:6.1f}s {rate:7.2f}"
        )
        for _, _, _, why in bad[:2]:
            print(f"        failed: {why}")
        if bad and len(bad) > len(results) / 2:
            print("        more than half failed — stopping the sweep here")
            break
    print(f"\nbest throughput {best[0]:.2f} req/s at concurrency {best[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
