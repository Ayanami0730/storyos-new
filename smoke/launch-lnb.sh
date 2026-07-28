#!/usr/bin/env bash
# The LiveNovelBench round. This is the bench we are behind on.
#
# On LongBench-Write we already lead every system sharing our backbone — paired
# over five tasks, 88.1 against agentwrite 83.5, raw gpt-5-mini 81.7 and
# bare-long-context 79.7. On LiveNovelBench at 20k we are seventh of nine on
# quality (3.913 against agentwrite's 4.346) and **eighth of nine on consistency
# errors, 4.93 per 10k words against agentwrite's 0.61** — the axis this entire
# architecture exists to win.
#
# Four cells, all on one key, because the second account went to the
# LiveNovelBench baseline lane (see HANDOFF-zhizengzeng.md):
#
#   lnb20k-crows      default scene size. The only cell directly comparable with
#                     the 4.93 baseline, so it is the one that says whether the
#                     person fix moved the number seven of those nine errors
#                     came from.
#   lnb20k-crows-ch   same task, 3,600-word scenes. Whether the LongBench
#                     chapter result carries to the tier we are behind on.
#   two 40k cells     the tier every baseline is scored at, so the first
#                     genuinely comparable row.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=zzz
export ZZZ_KEY="$(cat ~/.config/zzz/key)"
exec node --experimental-strip-types src/cli/run-batch.ts \
  --tasks runs-lnb/tasks.jsonl --runs runs-lnb --concurrency 4 --stagger 20 --force
