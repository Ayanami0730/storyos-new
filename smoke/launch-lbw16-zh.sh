#!/usr/bin/env bash
# LongBench-Write Chinese tasks on 0.9.16 (full agents-zh/ role prompts).
#
# 0.9.15 only prepended a short Chinese directive to the English contract.
# 0.9.16 loads SHARED.md + five AGENT.md from agents-zh/, checked so every tool
# name / path / identifier survives. Eleven Chinese tasks; English cells stay on
# the in-flight runs-lbw21 (0.9.15) batch for a clean A/B on the language arm.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=ys2
export YS_KEY="$(cat ~/.config/ys/key)"
exec node --experimental-strip-types src/cli/run-batch.ts \
  --tasks runs-lbw16/tasks-zh.jsonl --runs runs-lbw16 \
  --concurrency 4 --stagger 12 --force
