#!/usr/bin/env bash
# The 0.9.6 round: everything measured on 0.9.1–0.9.4 has to be redone.
#
# `fold_scene` was granted by the factory and missing from the persona allowlist,
# so the index-manager was refused at construction on every scene of every run
# for four versions. Across 26 runs it produced **zero state entries, zero
# beliefs, zero relations and zero events** — an index of identities only — while
# reporting `done`. Nothing measured in that window says anything about this
# architecture, the chapter-length A/B included, so this round starts clean.
#
# Two batches, and the split is by what each answers:
#
#   runs-lnb   the two axes we are behind on. Four default-length 20k cells take
#              the consistency measurement from n=1 to n=4 — it is errors per
#              10,000 words, and one manuscript cannot distinguish a fix from a
#              different draft. Two chapter-arm cells pair against two of them.
#              Two 40k cells are the first tier-comparable row.
#   runs-ch21  the 21 LongBench-Write literature tasks, chapter arm. Lower
#              priority: we already lead every gpt-5-mini system on that bench.
#
# Concurrency 8 + 8 against a measured knee of 32 parallel requests on this
# route. A run is roughly one request in flight, so 16 is half the ceiling and
# the other lane keeps the rest; 48 is where the first 429 appeared and 96 loses
# a third of its requests, so the cost of overshooting is errors rather than
# queueing.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=ys2
export YS_KEY="${YS_KEY:-$(cat ~/.config/ys/key)}"

tmux kill-session -t storyos 2>/dev/null || true
tmux new-session -d -s storyos -c "$PWD"

tmux new-window -d -t storyos -n lnb -c "$PWD" \
  "STORYOS_SUPPLY=ys2 YS_KEY='$YS_KEY' node --experimental-strip-types \
     src/cli/run-batch.ts --tasks runs-lnb/tasks-all.jsonl --runs runs-lnb \
     --concurrency 8 --stagger 12 --force 2>&1 | tee runs-lnb/batch-096.log"

tmux new-window -d -t storyos -n ch21 -c "$PWD" \
  "STORYOS_SUPPLY=ys2 YS_KEY='$YS_KEY' node --experimental-strip-types \
     src/cli/run-batch.ts --tasks runs-ch21/tasks.jsonl --runs runs-ch21 \
     --concurrency 8 --stagger 12 --force 2>&1 | tee runs-ch21/batch-096.log"

echo "launched: tmux attach -t storyos"
tmux list-windows -t storyos
