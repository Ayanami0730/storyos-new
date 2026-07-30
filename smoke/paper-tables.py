#!/usr/bin/env python3
"""The paper's two result tables, one pair per backbone, filled from disk.

`main.tex` carries two tables and both hold `--` in our row. This prints them from
the scored artefacts instead of by hand, split by backbone, because a row's
backbone is the one thing a reader cannot recover from the number: "StoryOS beats
AgentWrite" and "gpt-5.6-terra beats gpt-5-mini" are the same figure until the two
sit in separate tables.

A cell that has not been measured prints as `--` rather than being omitted, so the
tables double as the list of what is left to run. Every cell carries the number of
tasks behind it, because our iteration subset is two tasks per tier chosen as the
ones we score worst on, and a mean over those is not comparable with a mean over
the tier's twelve without saying so.

    smoke/paper-tables.py            # all four
    smoke/paper-tables.py lnb        # LiveNovelBench only
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

DATA = Path.home() / "storyos-data"
QUAL = DATA / "quality-judge"
FACT = DATA / "fact-metric"
V3 = Path.home() / "storyos-v3"
LBW_BASE = Path.home() / "storyos/experiments/longbench-write/judgements/gpt-5.5"
LBW_TERRA_BASE = DATA / "outputs-lbw-terra/judgements/gpt-5.5"

TIERS = ("20k", "40k", "60k", "80k")

#: (display, system id) per section, per backbone. `None` means the row exists in
#: the paper but has no artefact under this backbone yet.
LNB_ROWS = {
    "gpt-5-mini": [
        ("One shot", [
            ("GPT-5.6-sol", "raw-gpt-5.6-sol"),
            ("GPT-5.5", "raw-gpt-5.5"),
            ("Gemini-3.1-pro", "raw-gemini-3.1-pro-preview"),
            ("GPT-5-mini (backbone)", "raw-gpt-5-mini"),
        ]),
        ("Bare long context", [("GPT-5-mini", "bare-long-context")]),
        ("Agent harness", [
            ("AgentWrite", "agentwrite"),
            ("Agents' Room", "agents-room-style"),
            ("RecurrentGPT", "recurrentgpt-style"),
            ("StoryWriter", "storywriter-style"),
            ("StoryOS (ours)", "storyos-{tier}"),
        ]),
    ],
    "gpt-5.6-terra": [
        ("One shot", [
            ("GPT-5.6-terra (backbone)", "raw-gpt-5.6-terra"),
        ]),
        ("Bare long context", [("GPT-5.6-terra", "bare-long-context-terra")]),
        ("Agent harness", [
            ("AgentWrite", "agentwrite-terra"),
            ("Agents' Room", "agents-room-style-terra"),
            ("RecurrentGPT", "recurrentgpt-style-terra"),
            ("StoryWriter", "storywriter-style-terra"),
            ("StoryOS (ours)", "storyos-{tier}-terra"),
        ]),
    ],
}

ALL_LBW_BANDS = ("0-500", "500-2k", "2k-4k", "4k-10k", "10k-20k")
#: The 21-task row covers nothing below 2,000 words, so the first two bands are
#: structurally empty for it and a column of `--` says only that the column exists.
#: Dropped from both backbones rather than from one, because two tables of the same
#: quantity with different columns invite reading a band difference as a system
#: difference. `--all-bands` restores them; the terra subset does have cells there.
LBW_BANDS = tuple(b for b in ALL_LBW_BANDS if b not in {"0-500", "500-2k"})
LBW_ROWS = {
    "gpt-5-mini": [
        ("One shot", [
            ("GPT-5.6-sol", "raw-gpt-5.6-sol"),
            ("GPT-5.5", "raw-gpt-5.5"),
            ("Gemini-3.1-pro", "raw-gemini-3.1-pro-preview"),
            ("GPT-5-mini (backbone)", "raw-gpt-5-mini"),
        ]),
        ("Bare long context", [("GPT-5-mini", "bare-long-context")]),
        ("Agent harness", [
            ("AgentWrite", "agentwrite"),
            ("Agents' Room", "agents-room-style"),
            ("StoryWriter", "storywriter-style"),
            ("StoryOS (ours)", "__ours_mini__"),
        ]),
    ],
    "gpt-5.6-terra": [
        ("One shot", [("GPT-5.6-terra (backbone)", "raw-gpt-5.6-terra")]),
        ("Bare long context", [("GPT-5.6-terra", "bare-long-context")]),
        ("Agent harness", [
            ("AgentWrite", "agentwrite"),
            ("Agents' Room", "agents-room-style"),
            ("StoryWriter", "storywriter-style"),
            ("StoryOS (ours)", "__ours_terra__"),
        ]),
    ],
}


# ---------------------------------------------------------------- loading


def records(path: Path):
    """`.jsonl` is one record a line; the audit writes one pretty-printed `.json`
    per manuscript, which line-by-line parsing reads as zero records."""
    if not path.is_file():
        return
    text = path.read_text()
    if path.suffix == ".json":
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            return
        yield from (obj if isinstance(obj, list) else [obj])
        return
    for line in text.splitlines():
        line = line.strip()
        if line:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                pass


def sys_task(row) -> tuple[str, str] | None:
    if not isinstance(row, dict):
        return None
    if isinstance(row.get("system"), str) and isinstance(row.get("task_id"), str):
        return row["system"], row["task_id"]
    for f in ("story_id", "id", "story", "key", "name"):
        v = row.get(f)
        if isinstance(v, str) and "__" in v:
            a, b = v.split("__", 1)
            return a, b
    return None


def quality(row) -> float | None:
    if not isinstance(row, dict):
        return None
    for k in ("writing_quality_docs08", "writing_quality"):
        v = row.get(k)
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, dict):
            for k2 in ("composite", "mean", "score"):
                if isinstance(v.get(k2), (int, float)):
                    return float(v[k2])
    return None


def errors(row) -> float | None:
    if not isinstance(row, dict):
        return None
    for k in ("consistency_errors_per_10k", "errors_per_10k"):
        if isinstance(row.get(k), (int, float)):
            return float(row[k])
    return None


def lnb_tier_raw(tier: str):
    q: dict[str, dict[str, float]] = {}
    e: dict[str, dict[str, float]] = {}
    for suffix in (tier, f"ours-{tier}"):
        for row in records(QUAL / f"aggregation-{suffix}/stories-gpt-5.6-sol.jsonl"):
            k = sys_task(row)
            v = quality(row)
            if k and v is not None:
                q.setdefault(k[0], {})[k[1]] = v
        d = FACT / f"consistency-{suffix}"
        if d.is_dir():
            for p in sorted(d.glob("stories/*.json")):
                for row in records(p):
                    k = sys_task(row)
                    v = errors(row)
                    if k and v is not None:
                        e.setdefault(k[0], {})[k[1]] = v
    return q, e


def lbw_rows(path: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for row in records(path):
        if isinstance(row, dict) and "scores" in row:
            out[row["task_id"]] = row
    return out


def lbw_ours(batch: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not batch.is_dir():
        return out
    for cell in sorted(p for p in batch.iterdir() if p.is_dir()):
        j = cell / "scoring/judgements/gpt-5.5/storyos-v3.jsonl"
        out.update(lbw_rows(j))
    return out


def lbw_band_of(task_id: str) -> str | None:
    lbw = Path.home() / "storyos/experiments/longbench-write"
    global _LEN
    try:
        _LEN
    except NameError:
        _LEN = {}
        for row in records(lbw / "tasks.jsonl"):
            if isinstance(row, dict):
                _LEN[row["task_id"]] = row.get("length") or 0
    n = _LEN.get(task_id, 0)
    if n < 500:
        return "0-500"
    if n < 2000:
        return "500-2k"
    if n < 4000:
        return "2k-4k"
    if n < 10000:
        return "4k-10k"
    return "10k-20k"


# ---------------------------------------------------------------- printing


def cell(vals: list[float], nd: int = 2) -> str:
    if not vals:
        return "--"
    return f"{statistics.mean(vals):.{nd}f}"


def n_of(vals: list[float]) -> str:
    return f"{len(vals)}" if vals else "-"


def lnb_paired(tier: str, backbone: str):
    """Restrict a tier to the tasks every shown row has, and say how many that is.

    Averaging whatever each row happens to hold is not a comparison: at 40k our
    gpt-5-mini row covers eight tasks and each baseline twelve, and this benchmark's
    tasks differ enough that the four we are missing can move a column on their own.
    """
    qs, es = lnb_tier_raw(tier)
    ids = [sid.format(tier=tier) if "{tier}" in sid else sid
           for _, rows in LNB_ROWS[backbone] for _, sid in rows]
    present = [i for i in ids if qs.get(i)]
    common = set.intersection(*(set(qs[i]) for i in present)) if present else set()
    q = {i: [v for t, v in qs.get(i, {}).items() if t in common] for i in ids}
    e = {i: [v for t, v in es.get(i, {}).items() if t in common] for i in ids}
    full = {i: len(qs.get(i, {})) for i in ids}
    return q, e, common, full


def print_lnb(backbone: str) -> None:
    per_tier = {t: lnb_paired(t, backbone) for t in TIERS}
    print(f"\n{'='*104}")
    print(f"LiveNovelBench — backbone {backbone}   (Qual. 越高越好, Err./10k 越低越好, n = 题数)")
    print("=" * 104)
    hdr = f"{'System':<26}" + "".join(f"{t+' target':>19}" for t in TIERS)
    print(hdr)
    print(f"{'':<26}" + "".join(f"{'Qual.':>7}{'Err.':>7}{'n':>5}" for _ in TIERS))
    print("-" * 104)
    for section, rows in LNB_ROWS[backbone]:
        print(f"  -- {section} --")
        for display, sid in rows:
            line = f"{display:<26}"
            for t in TIERS:
                q, e, common, full = per_tier[t]
                key = sid.format(tier=t) if "{tier}" in sid else sid
                qv, ev = q.get(key, []), e.get(key, [])
                mark = "*" if full.get(key, 0) > len(qv) > 0 else ""
                line += f"{cell(qv):>7}{cell(ev):>7}{n_of(qv)+mark:>5}"
            print(line)
    print("-" * 104)
    cov = " | ".join(f"{t}: {len(per_tier[t][2])} 题" for t in TIERS)
    print(f"每档取所有行的题目交集 — {cov}")
    print("n 后的 * 表示该系统自己跑了更多题，但为配对而只算了交集内的")


def print_lbw(backbone: str) -> None:
    if backbone == "gpt-5-mini":
        base_dir, ours = LBW_BASE, lbw_ours(V3.parent / "storyos-v18/runs-lbw18")
        note = "ours = 0.9.18, 21 题；baseline 21 题"
    else:
        base_dir = LBW_TERRA_BASE
        ours = lbw_ours(V3 / "runs-iter-lbw-fast-0.9.20-gpt-5.6-terra")
        note = "ours = 0.9.20, 8 题迭代 subset；baseline 同 8 题"
    # Paired on the tasks our row actually covers. The baselines were scored over
    # the whole 120-task benchmark; putting their 120-task mean beside our 21 is a
    # comparison between two different populations, and this benchmark's tasks
    # differ enormously in difficulty — the same system scores 96 on a 2,000-word
    # prompt and 56 on a 20,000-word one. The count in `n` is then also the honest
    # statement of how much of the benchmark our row still owes.
    # Overall is recomputed over the bands actually shown, so the composite cannot
    # be carried by tasks that no column accounts for.
    scope = {t for t in ours if lbw_band_of(t) in LBW_BANDS}
    dropped = len(ours) - len(scope)
    print(f"\n{'='*104}")
    print(f"LongBench-Write — backbone {backbone}   (S_q 0-5 越高越好, S_l 0-100 越高越好)")
    print(f"{note}")
    print(f"所有行均限制到我们跑过的 {len(scope)} 题（benchmark 全量 120 题）"
          + (f"；另有 {dropped} 题落在已隐藏的 <2k 档" if dropped else ""))
    print("=" * 104)
    print(f"{'System':<26}{'S-bar':>7}{'S_q':>6}{'S_l':>6}{'n':>4}"
          + "".join(f"{b:>15}" for b in LBW_BANDS))
    print(f"{'':<26}{'':>7}{'':>6}{'':>6}{'':>4}"
          + "".join(f"{'S_q':>7}{'S_l':>8}" for _ in LBW_BANDS))
    print("-" * 104)
    for section, rows in LBW_ROWS[backbone]:
        print(f"  -- {section} --")
        for display, sid in rows:
            if sid.startswith("__ours"):
                rows_by_task = {t: r for t, r in ours.items() if t in scope}
            else:
                rows_by_task = {
                    t: r for t, r in lbw_rows(base_dir / f"{sid}.jsonl").items()
                    if t in scope
                }
            if not rows_by_task:
                print(f"{display:<26}{'--':>7}{'--':>6}{'--':>6}{'-':>4}"
                      + "".join(f"{'--':>7}{'--':>8}" for _ in LBW_BANDS))
                continue
            sq = [r["s_quality_raw"] for r in rows_by_task.values()]
            sl = [r["s_length"] for r in rows_by_task.values()]
            sbar = [(20 * a + b) / 2 for a, b in zip(sq, sl)]
            line = (f"{display:<26}{cell(sbar,1):>7}{cell(sq):>6}"
                    f"{cell(sl,1):>6}{len(sq):>4}")
            for band in LBW_BANDS:
                bq = [r["s_quality_raw"] for t, r in rows_by_task.items()
                      if lbw_band_of(t) == band]
                bl = [r["s_length"] for t, r in rows_by_task.items()
                      if lbw_band_of(t) == band]
                line += f"{cell(bq):>7}{cell(bl,1):>8}"
            print(line)
    print("-" * 104)


args = [a for a in sys.argv[1:] if a != "--all-bands"]
if "--all-bands" in sys.argv:
    LBW_BANDS = ALL_LBW_BANDS
which = args[0] if args else "all"
if which in ("all", "lnb"):
    for bb in ("gpt-5-mini", "gpt-5.6-terra"):
        print_lnb(bb)
if which in ("all", "lbw"):
    for bb in ("gpt-5-mini", "gpt-5.6-terra"):
        print_lbw(bb)
