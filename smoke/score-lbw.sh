#!/usr/bin/env bash
# Score one StoryOS run with the frozen LongBench-Write judge.
#
# The reproduction worktree at ~/work/longbench is read-only to us: it holds a
# converged table that eight systems were scored into, and a stray write there
# would put our row in somebody else's committed result. So the scorer is
# invoked with both of its output paths redirected into this repo — the
# generations root it reads from, and the judgements directory it appends to.
#
# What is *not* redirected is the judge: same `gpt-5.5`, same verbatim
# `judge.txt`, same S_l formula, same official word count. A comparison is only
# worth making if the only thing that changed is the system under test.
#
#   smoke/score-lbw.sh runs/lbw081/run lbw081
set -euo pipefail

RUN_DIR="${1:?usage: score-lbw.sh <run-dir> <task-id>}"
TASK_ID="${2:?usage: score-lbw.sh <run-dir> <task-id>}"
# The evaluation repo moved when the parallel lanes merged: it used to be the
# `~/work/longbench` worktree, and the LongBench-Write assets now live on `main`
# in `~/storyos`. Overridable, and checked below rather than failing later with a
# confusing Python traceback.
LBW="${LBW_ROOT:-$HOME/storyos/experiments/longbench-write}"
if [[ ! -f "$LBW/score_lbw.py" ]]; then
  echo "no scorer at $LBW/score_lbw.py — set LBW_ROOT to the longbench-write directory" >&2
  exit 1
fi
SYSTEM="storyos-v3"

# The scorer's own interpreter, not whatever `python3` resolves to. The system
# python here is 3.6, which cannot parse `from __future__ import annotations` —
# so a caller that has not activated the conda env gets a SyntaxError written
# into its score file and a batch that reports "scoring done" with no scores in
# it. Two finished LongBench-Write batches sat unscored overnight that way.
SCORER_PY="${LBW_PYTHON:-$HOME/miniconda3/envs/pipeline/bin/python}"
if [[ ! -x "$SCORER_PY" ]]; then
  echo "no interpreter at $SCORER_PY — set LBW_PYTHON to a python >= 3.9" >&2
  exit 1
fi

if [[ ! -f "$RUN_DIR/story.md" ]]; then
  echo "no story.md in $RUN_DIR — the run did not produce a manuscript" >&2
  exit 1
fi

OUT_ROOT="$(cd "$(dirname "$RUN_DIR")" && pwd)/scoring"
mkdir -p "$OUT_ROOT/$SYSTEM/longbench-write"
# The scorer reads <root>/<system>/longbench-write/<task>.txt and nothing else.
cp "$RUN_DIR/story.md" "$OUT_ROOT/$SYSTEM/longbench-write/$TASK_ID.txt"

cd "$LBW"
# score_lbw.py puts only its own directory on sys.path, but lbw_systems.py imports
# src.baselines, so the repo root has to come through PYTHONPATH. This is what
# the worktree's own score_full.sh does.
REPO_ROOT="$(cd ../.. && pwd)"
export PYTHONPATH="$REPO_ROOT${PYTHONPATH:+:$PYTHONPATH}"
# The judge is a model call, so it needs the key too. Exported here rather than
# inherited, because the caller may have passed it only to the generation step —
# which is exactly how a finished run ended up with an empty score file.
export YS_KEY="${YS_KEY:-$(cat ~/.config/ys/key)}"
"$SCORER_PY" score_lbw.py \
  --systems "$SYSTEM" \
  --tasks "$TASK_ID" \
  --output-root "$OUT_ROOT" \
  --judgements "$OUT_ROOT/judgements" \
  --concurrency 1

"$SCORER_PY" - "$OUT_ROOT/judgements/gpt-5.5/$SYSTEM.jsonl" "$TASK_ID" "$OUT_ROOT/$SYSTEM/longbench-write/$TASK_ID.txt" <<'PY'
import hashlib, json, sys
path, task, text_file = sys.argv[1], sys.argv[2], sys.argv[3]
rows = [json.loads(l) for l in open(path) if l.strip()]

# Match the judgement to the text by digest, not by being last in the file.
#
# The scorer appends, and it re-judges a cell whose text changed, so the file can
# hold rows for texts that are not the one on disk. Taking the last row is how a
# score got reported for a 540-word story when the manuscript was 602 words: two
# processes had been writing into one run directory, and the wrapper had no way to
# notice. A scoring harness that can print a number for a text you do not have is
# worse than one that refuses.
digest = hashlib.sha256(open(text_file, "rb").read()).hexdigest()
mine = [r for r in rows if r["task_id"] == task and r.get("text_sha256") == digest]
if not mine:
    seen = [
        f"{r.get('response_words')}w/{(r.get('text_sha256') or '?')[:8]}"
        for r in rows
        if r["task_id"] == task
    ]
    print(
        f"no judgement matches the text that was just scored ({digest[:8]}). "
        f"Rows present for {task}: {seen or 'none'}. Refusing to report a score for a "
        f"different text — check whether two runs shared this directory."
    )
    raise SystemExit(1)
row = mine[-1]
if "scores" not in row:
    print("judge failed:", row.get("error")); raise SystemExit(1)
sq = row["s_quality_raw"]; sl = row["s_length"]
print()
print(f"  words      {row['response_words']} / {row['required_words']} required")
print(f"  S_l        {sl:.1f}")
print(f"  S_q        {sq:.2f}  (x20 = {sq*20:.1f})")
print(f"  S-bar      {(20*sq + sl)/2:.1f}")
for k, v in sorted(row["scores"].items()):
    print(f"    {k:20s} {v}")
PY
