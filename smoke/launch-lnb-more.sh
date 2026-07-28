#!/usr/bin/env bash
# Second LiveNovelBench batch, filling the key to its measured ceiling.
#
# Three more 20k cells at the default scene size, because the consistency number
# this round exists to move — 4.93 errors per 10k words, eighth of nine systems —
# currently rests on a single task. Nine errors in one 18,000-word manuscript is
# not a measurement you can attribute a fix to.
#
# Plus a second paired chapter-arm cell, so "does the LongBench chapter result
# carry to LiveNovelBench" has two tasks rather than one.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=zzz
export ZZZ_KEY="$(cat ~/.config/zzz/key)"
exec node --experimental-strip-types src/cli/run-batch.ts \
  --tasks runs-lnb/tasks-more.jsonl --runs runs-lnb --concurrency 4 --stagger 25 --force
