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
LBW="$HOME/work/longbench/experiments/longbench-write"
SYSTEM="storyos-v3"

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
python3 score_lbw.py \
  --systems "$SYSTEM" \
  --tasks "$TASK_ID" \
  --output-root "$OUT_ROOT" \
  --judgements "$OUT_ROOT/judgements" \
  --concurrency 1

python3 - "$OUT_ROOT/judgements/gpt-5.5/$SYSTEM.jsonl" "$TASK_ID" <<'PY'
import json, sys
path, task = sys.argv[1], sys.argv[2]
rows = [json.loads(l) for l in open(path) if l.strip()]
row = [r for r in rows if r["task_id"] == task][-1]
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
