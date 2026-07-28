#!/usr/bin/env bash
# The LiveNovelBench round, on the `openai/` upstream group.
#
# ## Why this bench
#
# On LongBench-Write we already lead every system sharing our backbone — paired
# over five tasks, 88.1 against agentwrite 83.5, raw gpt-5-mini 81.7 and
# bare-long-context 79.7. On LiveNovelBench at 20k we are seventh of nine on
# quality (3.913 against agentwrite's 4.346) and **eighth of nine on consistency
# errors, 4.93 per 10k words against agentwrite's 0.61** — the axis this whole
# architecture exists to win.
#
# ## Why this route
#
# `STORYOS_SUPPLY=ys2` is the same gateway and the same key on the `openai/`
# group, which is not saturated: probed at 4/8/16/32 parallel requests it took
# every one with zero failures and a flat p50 of 3.0–3.7s, and only began
# refusing at 48. The old group was killing runs at concurrency 2, and the
# zhizengzeng fallback ran its account to `余额不足` mid-round.
#
# ## Why concurrency 16
#
# 32 is the measured ceiling for the whole account and the other lane needs half
# of it, so 16 is our share. A run holds roughly one request in flight, so this
# is about sixteen in flight — comfortably inside the clean band, and it leaves
# the retry headroom that a shared endpoint still wants.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=ys2
export YS_KEY="${YS_KEY:-$(cat ~/.config/ys/key)}"
cat runs-lnb/tasks.jsonl runs-lnb/tasks-more.jsonl > runs-lnb/tasks-all.jsonl
exec node --experimental-strip-types src/cli/run-batch.ts \
  --tasks runs-lnb/tasks-all.jsonl --runs runs-lnb --concurrency 8 --stagger 12 --force
