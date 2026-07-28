#!/usr/bin/env bash
# The 20k tier, all twelve tasks, on 0.9.12 — the version test and the row at once.
#
# The tier is already covered, and that is the problem: four cells on 0.9.6, seven
# on 0.9.9, one never generated. None of them carry the orthography fix, and
# `style_shifts` is **47 of the 134 kept consistency errors** across the fifteen
# manuscripts scored so far — 35%, the largest subtype by a factor of three. So the
# open question and the incomplete row have the same answer: run the tier again on
# one version.
#
# Same twelve tasks, same default scene length, same route as the 40k and 60k
# batches, so against the 0.9.6/0.9.9 cells the single variable is the harness. If
# density falls from 4.98 toward the 3.1 that agentwrite, agents-room and
# bare-long-context all sit at, the fix is worth the paragraph it gets; if it does
# not, that is worth knowing before anything is claimed for it.
#
# Deliberately not the 2,400 arm. On quality the three arms are indistinguishable
# (4.004 / 3.984 / 3.957 against within-arm standard deviations of 0.10-0.22) and
# the default arm is the one every baseline is comparable with.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=ys2
export YS_KEY="$(cat ~/.config/ys/key)"
exec node --experimental-strip-types src/cli/run-batch.ts \
  --tasks runs-20kv2/tasks.jsonl --runs runs-20kv2 \
  --concurrency 12 --stagger 12 --force
