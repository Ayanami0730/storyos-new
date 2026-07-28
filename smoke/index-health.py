#!/usr/bin/env python3
"""Did the index-manager actually write the behavioural partitions?

`index.references` in every summary counts what landed in the index. The
partitions that carry the paper's claim are the ones only the index-manager
writes: state entries, belief entries, relations and events. A run with 148
canon facts and **zero** state entries built an index of identities only, and
the writer's P1 tier — state and beliefs of everyone present — had nothing to
carry, on every scene after the first.

Printed against `harness_version` so a regression can be dated.
"""

import json
import sys
from pathlib import Path

KEYS = ("state_entries", "belief_entries", "relations", "events", "promises")


def load(run: Path) -> dict | None:
    for name in ("summary.json", "summary-stdout.json"):
        f = run / name
        if f.exists():
            try:
                return json.loads(f.read_text())
            except json.JSONDecodeError:
                return None
    return None


def main(dirs) -> None:
    rows = []
    for d in dirs:
        p = Path(d)
        if not p.is_dir():
            continue
        for run in sorted(p.iterdir()):
            if not run.is_dir():
                continue
            s = load(run)
            if not s:
                continue
            refs = ((s.get("index") or {}).get("references") or {})
            log = run / "run.log"
            backfill_failures = 0
            if log.exists():
                backfill_failures = log.read_text(errors="replace").count("backfill failed")
            rows.append(
                {
                    "cell": run.name,
                    "batch": p.name,
                    "ver": s.get("harness_version", "?"),
                    "scenes": s.get("scenes_committed", 0),
                    "canon": s.get("canon_facts", 0),
                    "refs": {k: refs.get(k, 0) for k in KEYS},
                    "backfill_failed": backfill_failures,
                }
            )

    rows.sort(key=lambda r: (r["ver"], r["batch"], r["cell"]))
    hdr = (
        f"{'cell':<40} {'batch':<11} {'ver':<6} {'sc':>3} {'canon':>6} "
        + " ".join(f"{k.split('_')[0]:>7}" for k in KEYS)
        + f" {'bkfl_fail':>9}"
    )
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print(
            f"{r['cell']:<40} {r['batch']:<11} {r['ver']:<6} {r['scenes']:>3} {r['canon']:>6} "
            + " ".join(f"{r['refs'][k]:>7}" for k in KEYS)
            + f" {r['backfill_failed']:>9}"
        )

    print()
    by_ver: dict[str, list] = {}
    for r in rows:
        by_ver.setdefault(r["ver"], []).append(r)
    for ver in sorted(by_ver):
        sel = [r for r in by_ver[ver] if r["scenes"] > 0]
        if not sel:
            continue
        dead = [r for r in sel if r["refs"]["state_entries"] == 0]
        print(
            f"  {ver}: n={len(sel):<3} "
            f"runs with zero state entries: {len(dead)}/{len(sel)}   "
            f"backfill failures total {sum(r['backfill_failed'] for r in sel)}"
        )


if __name__ == "__main__":
    main(sys.argv[1:] or ["runs-ch21", "runs-lnb", "runs-lnb2", "runs-ab"])
