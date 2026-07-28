#!/usr/bin/env bash
# The chapter-length A/B: same four tasks, two scene sizes.
#
# Paired rather than repeated. Two same-code samples of one task have come back
# 6.5 S-bar points apart, so three samples of one task cannot resolve anything
# smaller than that — but task difficulty is the dominant term and pairing
# removes it, so four tasks run both ways gives four differences to look at.
#
# Both arms in one batch at concurrency 4, so they share gateway conditions
# rather than one arm running during a quiet hour and the other during a busy one.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export YS_KEY="${YS_KEY:-$(cat ~/.config/ys/key)}"
cat runs-ab/tasks-control.jsonl runs-ab/tasks-chapter.jsonl > runs-ab/tasks.jsonl
exec node --experimental-strip-types src/cli/run-batch.ts \
  --tasks runs-ab/tasks.jsonl --runs runs-ab --concurrency 4 --stagger 15 --force
