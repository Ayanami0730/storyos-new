#!/usr/bin/env bash
# Score every finished cell of one LongBench-Write batch, several at a time.
#
# Generalised from `score-ch21.sh`, which hardcoded `runs-ch21` and stripped a
# `-ch` suffix to recover the task id. The default arm has no suffix, so the
# mapping from cell directory to task id is read from the cell's own `task.json`
# instead of derived from its name — deriving it is how a manuscript ends up
# scored against another task's required elements.
#
# The parallelism is here rather than inside `score-lbw.sh`, whose
# `--concurrency 1` is on the frozen scorer. Probed directly, `gpt-5.5` took 32
# parallel requests with zero failures, and each cell needs one judging call, so
# the gateway is not the constraint; twenty-one cells at one process each is about
# ninety seconds.
#
#   score-lbw-batch.sh runs-lbw21
#   PAR=10 score-lbw-batch.sh runs-lbw21
set -uo pipefail
cd "$(dirname "$0")/.."
BATCH="${1:?usage: score-lbw-batch.sh <runs-dir>}"
export YS_KEY="${YS_KEY:-$(cat ~/.config/ys/key)}"
PAR="${PAR:-7}"

cells=()
for d in "$BATCH"/*/; do
  cell=$(basename "$d")
  [ -f "$d/run/story.md" ] || continue
  cells+=("$cell")
done
echo "${#cells[@]} cell(s) to score in $BATCH, $PAR at a time"

printf '%s\n' "${cells[@]}" | BATCH="$BATCH" xargs -P "$PAR" -I{} bash -c '
  cell="{}"
  dir="$BATCH/$cell"
  out="$dir/score.txt"
  # The benchmark id from the artefact, not from the directory name.
  task=$(python3 -c "import json;print(json.load(open(\"$dir/task.json\"))[\"task_id\"])" 2>/dev/null)
  task="${task:-$cell}"
  if bash smoke/score-lbw.sh "$dir/run" "$task" > "$out" 2>&1; then
    printf "%-14s %s\n" "$cell" "$(grep -E "^  S-bar" "$out" | tail -1)"
  else
    printf "%-14s FAILED  %s\n" "$cell" "$(tail -2 "$out" | head -1)"
  fi
'
echo "### scoring done"
