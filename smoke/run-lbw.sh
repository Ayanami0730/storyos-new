#!/usr/bin/env bash
# Run one LongBench-Write task end to end: task -> premise -> story -> score.
#
# Written because the interesting robustness question is not "does 2,800 words
# work" but "does the same configuration work at 500 and at 5,000", and a
# per-length answer is only worth having if the only thing that differed between
# the runs was the task. Everything here is fixed except the task id: same
# profile, same sandbox, same allocation mode, same judge.
#
# The task record is read from the reproduction worktree, which is read-only to
# us — it holds a converged table eight other systems were scored into. Nothing
# below writes there; `score-lbw.sh` redirects both of the scorer's output paths
# into this repo.
#
#   smoke/run-lbw.sh lbw103            # dynamic allocation (the default)
#   smoke/run-lbw.sh lbw103 --max-repairs 2 --out-suffix uniform
set -euo pipefail

TASK_ID="${1:?usage: run-lbw.sh <task-id> [extra write-story flags]}"
shift || true

# Moved when the parallel lanes merged; see smoke/score-lbw.sh.
LBW="${LBW_ROOT:-$HOME/storyos/experiments/longbench-write}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/bin/node22/bin:$PATH"

SUFFIX=""
FLAGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-suffix) SUFFIX="-$2"; shift 2 ;;
    *) FLAGS+=("$1"); shift ;;
  esac
done

RUN_DIR="$REPO/runs/$TASK_ID$SUFFIX"
mkdir -p "$RUN_DIR"

# The task's own prompt and required length, verbatim from the benchmark file.
# Re-deriving either by hand is how a run ends up scored against a length it was
# never asked for.
python3 - "$LBW/tasks.jsonl" "$TASK_ID" "$RUN_DIR" <<'PY'
import json, sys, pathlib
tasks, task_id, out = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
row = next((json.loads(l) for l in open(tasks) if json.loads(l)["task_id"] == task_id), None)
if row is None:
    raise SystemExit(f"{task_id} is not in {tasks}")
(out / "task.json").write_text(json.dumps(row, indent=2, ensure_ascii=False) + "\n")
(out / "premise.txt").write_text(row["prompt"].strip() + "\n")
print(f"{task_id}: {row['length']} words, {row['language']}, {row['type']}")
PY

TARGET="$(python3 -c "import json,sys;print(json.load(open('$RUN_DIR/task.json'))['length'])")"

YS_KEY="$(cat ~/.config/ys/key)" \
node --experimental-strip-types "$REPO/src/cli/write-story.ts" \
  --premise-file "$RUN_DIR/premise.txt" \
  --target "$TARGET" \
  --out "$RUN_DIR/run" \
  --profile generous \
  --sandbox docker \
  "${FLAGS[@]}" \
  > "$RUN_DIR/summary-stdout.json" 2> "$RUN_DIR/run.log"

"$REPO/smoke/score-lbw.sh" "$RUN_DIR/run" "$TASK_ID" | tee "$RUN_DIR/score.txt"
