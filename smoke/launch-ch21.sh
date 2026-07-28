#!/usr/bin/env bash
# Chapter arm across every LongBench-Write literature task of 2,000 words or more.
#
# Twenty-one tasks, and they are not one experiment. `--words-per-scene 3600`
# collapses a 2,000–5,000-word task to a single scene, which bypasses the harness
# entirely rather than enlarging its unit — so those thirteen cells measure "is
# the harness worth its cost at this length", a question already answered no by
# our S_q never beating raw gpt-5-mini on this bench.
#
# The eight cells at 6,000 words and above are the actual chapter experiment,
# because both arms keep the scene loop: 5 scenes against 2 at 6k, 8 against 3 at
# 10k, and 17 against 6 at 20k — that last one being the same regime as the
# LiveNovelBench 20k tier, which is where an answer would be worth having.
#
# Baselines for all 120 tasks are already in the frozen judgements, so the
# absolute score comparison needs no control arm; the paired comparison uses the
# control runs we already have plus whatever the round produces.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=ys2
export YS_KEY="${YS_KEY:-$(cat ~/.config/ys/key)}"
exec node --experimental-strip-types src/cli/run-batch.ts \
  --tasks runs-ch21/tasks.jsonl --runs runs-ch21 --concurrency 4 --stagger 15 --force
