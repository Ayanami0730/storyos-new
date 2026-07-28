#!/usr/bin/env bash
# Relaunch the two 40k LiveNovelBench cells.
#
# A script rather than an inline command because the inline version killed
# itself: `pkill -f tasks-40k.jsonl` matched the launching shell's own command
# line, which contained that string, so the shell died before it reached the
# launch and left no log to explain why.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export YS_KEY="${YS_KEY:-$(cat ~/.config/ys/key)}"
exec node --experimental-strip-types src/cli/run-batch.ts \
  --tasks runs-r1/tasks-40k.jsonl \
  --runs runs-r1 \
  --concurrency 2 \
  --stagger 20 \
  --force
