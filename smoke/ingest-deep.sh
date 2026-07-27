#!/usr/bin/env bash
# Deep-ingest one or more runs into the viewer, sequentially.
#
# Sequential on purpose. Each ingest already runs its translation at concurrency
# 120, so two ingests at once would double that against one gateway and buy 429s;
# and a failure part-way through is much easier to read when one thing was running.
#
#   smoke/ingest-deep.sh lbw081 lbw092 lbw103
#
# Each argument is a directory under runs/. A run whose scoring directory is absent
# is still ingested, just without a score row.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LBW="$HOME/work/longbench/experiments/longbench-write"
export PATH="$HOME/bin/node22/bin:$PATH"
export YS_KEY="${YS_KEY:-$(cat ~/.config/ys/key)}"

for run in "$@"; do
  dir="$REPO/runs/$run"
  task_id="${run%%-*}"
  if [[ ! -d "$dir/run" ]]; then
    echo "### $run — no run/ directory, skipping" >&2
    continue
  fi
  echo "### $run" >&2
  args=(--run "$dir/run" --deep --concurrency 120)
  [[ -f "$dir/task.json" ]] && args+=(--task "$dir/task.json")
  judgement="$dir/scoring/judgements/gpt-5.5/storyos-v3.jsonl"
  [[ -f "$judgement" ]] && args+=(--judgement "$judgement" --baselines "$LBW/judgements/gpt-5.5")

  # Not `set -e`: one run failing to ingest should not abandon the rest, and the
  # failure is visible in this log either way.
  node --experimental-strip-types "$REPO/src/cli/build-trace.ts" "${args[@]}" 2>&1 |
    grep -E "deep:|score:|translated in|wrote|index now|failed" >&2
done
echo "### all done" >&2
