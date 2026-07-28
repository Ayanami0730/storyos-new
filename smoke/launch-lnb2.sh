#!/usr/bin/env bash
# Four more 20k cells, on the second zhizengzeng account.
#
# The number this round exists to move is 4.93 consistency errors per 10,000
# words — eighth of nine systems, on the axis this architecture is built around —
# and seven of the nine errors behind it were narrative-person drift, which 0.8.8
# now checks deterministically. That measurement was resting on one task. Four
# cells here take it to eight, which is the difference between "the fix moved a
# number" and "one manuscript came out differently".
#
# Concurrency 4, against a measured knee of 8 parallel requests for a single
# zhizengzeng key. The other account on this provider already hit `余额不足`
# mid-round, so this one runs at half its ceiling and its balance is worth
# checking before each launch.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=zzz
export ZZZ_KEY="$(cat ~/.config/zzz/key2)"
exec node --experimental-strip-types src/cli/run-batch.ts \
  --tasks runs-lnb2/tasks.jsonl --runs runs-lnb2 --concurrency 4 --stagger 20 --force
