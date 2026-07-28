#!/usr/bin/env bash
# The 60k tier, all twelve tasks, on 0.9.11.
#
# This tier had no manuscript at all: the one attempt on disk is a fatal 0.9.0 run.
# It is also the long pole, so it starts first — everything else in the queue is
# shorter than it and can finish inside its shadow.
#
# 2,400 words a scene rather than the default 1,200. Wall clock per scene is
# almost flat in scene length (median 12.0 min at 1,200, 12.9 at 2,400, 13.3 at
# 3,600 across 37 finished cells), so scene length is close to a pure throughput
# multiplier: 25 scenes at 2,400 is about 5.5 hours where 50 scenes at 1,200 is
# about 11, and 11 hours leaves no room for a single cell to need a retry before
# the deadline. The cost is attainment, 0.88 against 0.98 — and the reason that is
# affordable here rather than a quiet concession is measured: across 300 scored
# manuscripts spanning 4k to 108k words, contradiction density is flat in length
# within a system (corr(words, errors per 10k) = +0.01 for agentwrite, -0.02 for
# storywriter, +0.03 for recurrentgpt), so delivering 53k instead of 59k neither
# buys nor costs us the metric this architecture is judged on.
#
# Concurrency 12 against a measured knee of 32 for this route, with 12 already in
# flight from the other two batches.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=ys2
export YS_KEY="$(cat ~/.config/ys/key)"
exec node --experimental-strip-types src/cli/run-batch.ts \
  --tasks runs-60kv2/tasks.jsonl --runs runs-60kv2 \
  --concurrency 12 --stagger 15 --force
