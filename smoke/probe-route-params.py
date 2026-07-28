#!/usr/bin/env python3
"""Do the three supply routes behave like the same model?

Nothing in the harness sets `reasoning_effort`, `temperature` or `top_p` — it
sets `reasoning: true` and lets the deployment choose. So each route applies its
own defaults, and if those differ, a number produced on one route is not
comparable with a baseline produced on another. Every baseline in both tables
came through the original `yuanshi` route.

Two observables the transcripts already carry, per assistant message:

    reasoning tokens per output token   how hard the deployment is thinking
    output tokens per reply             whether a different cap is in force

Grouped by the `provider` field the transcript records, which is the route.
Reads only assistant messages and only the usage block, so this stays cheap on a
shared filesystem.
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

PROVIDERS = {
    "yuanshi-sg": "yuanshi (reference route, every baseline)",
    "yuanshi-sg-openai": "ys2 (internal, openai/ group)",
    "zhizengzeng": "zzz (zhizengzeng)",
}


def main(dirs: list[str]) -> None:
    agg: dict[tuple[str, str], dict[str, float]] = defaultdict(
        lambda: {"replies": 0, "out": 0, "reason": 0, "input": 0, "cache": 0}
    )
    for d in dirs:
        root = Path(d)
        if not root.is_dir():
            continue
        for t in root.glob("*/run/project/runtime/transcripts/*/*.jsonl"):
            role = t.parent.name
            with t.open(errors="replace") as fh:
                for line in fh:
                    if '"usage"' not in line:
                        continue
                    try:
                        m = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if m.get("role") != "assistant":
                        continue
                    u = m.get("usage") or {}
                    prov = m.get("provider") or "?"
                    a = agg[(prov, role)]
                    a["replies"] += 1
                    a["out"] += u.get("output", 0) or 0
                    a["reason"] += u.get("reasoning", 0) or 0
                    a["input"] += u.get("input", 0) or 0
                    a["cache"] += u.get("cacheRead", 0) or 0

    by_provider: dict[str, dict[str, float]] = defaultdict(
        lambda: {"replies": 0, "out": 0, "reason": 0, "input": 0, "cache": 0}
    )
    for (prov, _role), a in agg.items():
        for k, v in a.items():
            by_provider[prov][k] += v

    print(f"{'route':<38} {'replies':>8} {'out/reply':>10} {'reason/reply':>13} {'reason/out':>11}")
    print("-" * 84)
    for prov, a in sorted(by_provider.items()):
        if not a["replies"]:
            continue
        label = PROVIDERS.get(prov, prov)
        print(
            f"{label:<38} {int(a['replies']):>8} {a['out'] / a['replies']:>10.0f} "
            f"{a['reason'] / a['replies']:>13.0f} "
            f"{(a['reason'] / a['out'] if a['out'] else 0):>11.2f}"
        )

    print()
    print("per role, because the writer is the only one asked for long output:")
    print(f"  {'route':<34} {'role':<17} {'replies':>8} {'out/reply':>10} {'reason/out':>11}")
    for (prov, role), a in sorted(agg.items()):
        if a["replies"] < 5:
            continue
        print(
            f"  {PROVIDERS.get(prov, prov)[:33]:<34} {role:<17} {int(a['replies']):>8} "
            f"{a['out'] / a['replies']:>10.0f} "
            f"{(a['reason'] / a['out'] if a['out'] else 0):>11.2f}"
        )


if __name__ == "__main__":
    main(sys.argv[1:] or ["runs-lnb", "runs-ab", "runs-r1"])
