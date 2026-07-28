#!/usr/bin/env bash
# One mixed round: both benches, both tiers, from one command.
#
# Concurrency is capped at the gateway rather than at the machine. Five
# concurrent runs turned into backoff instead of throughput; four is the measured
# ceiling, and the machine is nowhere near loaded at that point because these are
# network-bound.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export YS_KEY="${YS_KEY:-$(cat ~/.config/ys/key)}"

launch() { # tasks runs concurrency log
  setsid nohup node --experimental-strip-types src/cli/run-batch.ts \
    --tasks "$1" --runs "$2" --concurrency "$3" --stagger 20 --force \
    > "$4" 2>&1 < /dev/null &
  echo "launched $2 -> $4"
}

launch runs-r1/tasks-40k.jsonl runs-r1 2 "runs-r1/batch-$(date +%H%M).log"
sleep 5
launch runs-20k/tasks.jsonl runs-20k 1 "runs-20k/batch-$(date +%H%M).log"
sleep 5
launch runs-60k/tasks.jsonl runs-60k 1 "runs-60k/batch-$(date +%H%M).log"
