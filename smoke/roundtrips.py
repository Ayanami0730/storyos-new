#!/usr/bin/env python3
"""Round-trips per scene by role, against the pre-0.9.0 baseline.

0.9.0 (the contract's cost model) and 0.9.1 (`fold_scene`) both target one
number: how many sequential model round-trips a scene costs. 94% of wall clock
is inside worker model calls, and 87% of the calls came from the two roles that
write no prose. The baseline to beat, measured on a 20,000-word run at v0.8.x:

    703 delegated round-trips, context-builder 20.4 per scene,
    index-manager 15.6 per scene, 137 minutes wall clock.

`roll_up` counts calls per role, which is the authoritative instrumentation —
`roll_up.ms` double-counts (an orchestrator turn contains what it delegates) so
wall clock comes from `elapsed_ms`.
"""

import json
import sys
from pathlib import Path

ROLES = ("context-builder", "index-manager", "writer", "verifier", "orchestrator")


def load(path: Path) -> dict | None:
    for name in ("summary.json", "summary-stdout.json"):
        f = path / name
        if f.exists():
            try:
                return json.loads(f.read_text())
            except json.JSONDecodeError:
                return None
    return None


def main(dirs: list[str]) -> None:
    rows = []
    for d in dirs:
        for run in sorted(Path(d).iterdir()):
            if not run.is_dir():
                continue
            s = load(run)
            if not s or s.get("scenes_committed", 0) == 0:
                continue
            scenes = s["scenes_committed"]
            calls = {r: 0 for r in ROLES}
            for key, v in (s.get("roll_up") or {}).items():
                role = key.split(":")[0]
                if role in calls:
                    calls[role] += v.get("calls", 0)
            worker = sum(calls[r] for r in ROLES if r != "orchestrator")
            rows.append(
                {
                    "cell": run.name,
                    "batch": Path(d).name,
                    "ver": s.get("harness_version", "?"),
                    "wps": s.get("words_per_scene"),
                    "target": s.get("target_words"),
                    "words": s.get("words"),
                    "att": s.get("attainment"),
                    "scenes": scenes,
                    "planned": s.get("scenes_planned"),
                    "min": round(s["elapsed_ms"] / 60000, 1),
                    "cost": (s.get("cost_estimate") or {}).get("total_usd"),
                    "per_scene": {r: round(calls[r] / scenes, 1) for r in ROLES},
                    "worker_per_scene": round(worker / scenes, 1),
                    "total_calls": sum(calls.values()),
                }
            )

    hdr = (
        f"{'cell':<40} {'ver':<6} {'wps':>5} {'sc':>6} {'att':>5} {'min':>6} "
        f"{'$':>6} {'bld':>5} {'idx':>5} {'wrt':>5} {'vfy':>5} {'wrk/sc':>7} {'calls':>6}"
    )
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        ps = r["per_scene"]
        cost = f"{r['cost']:.2f}" if isinstance(r["cost"], (int, float)) else "?"
        att = f"{r['att']:.2f}" if isinstance(r["att"], (int, float)) else "?"
        print(
            f"{r['cell']:<40} {r['ver']:<6} {str(r['wps']):>5} "
            f"{r['scenes']}/{r['planned']:<4} {att:>5} {r['min']:>6} {cost:>6} "
            f"{ps['context-builder']:>5} {ps['index-manager']:>5} {ps['writer']:>5} "
            f"{ps['verifier']:>5} {r['worker_per_scene']:>7} {r['total_calls']:>6}"
        )

    if not rows:
        return
    print()
    print("baseline v0.8.x 20k: builder 20.4/scene, index-manager 15.6/scene, 703 calls, 137 min")
    for label, keep in (
        ("all", lambda r: True),
        ("default scene length", lambda r: not r["wps"]),
        ("chapter arm (wps set)", lambda r: bool(r["wps"])),
    ):
        sel = [r for r in rows if keep(r)]
        if not sel:
            continue
        n = len(sel)
        print(
            f"  {label:<22} n={n:<3} "
            f"builder {sum(r['per_scene']['context-builder'] for r in sel) / n:5.1f}  "
            f"index-mgr {sum(r['per_scene']['index-manager'] for r in sel) / n:5.1f}  "
            f"worker/scene {sum(r['worker_per_scene'] for r in sel) / n:5.1f}  "
            f"attainment {sum(r['att'] for r in sel if r['att'] is not None) / n:5.2f}"
        )


if __name__ == "__main__":
    main(sys.argv[1:] or ["runs-ch21", "runs-lnb", "runs-lnb2"])
