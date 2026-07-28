#!/usr/bin/env bash
# The ten 40k-tier tasks with no manuscript, on 0.9.11.
#
# Default scene length, unlike the 60k batch beside it. At 40k that is about 33
# scenes and 7 hours, which fits; at 60k it would be 50 scenes and 11, which does
# not. It also keeps this tier at the same granularity as the 20k row, so the two
# rows differ in target and not in how the harness was configured.
#
# The two remaining ids of the twelve are in flight in `runs-lnb` on 0.9.6 and are
# not duplicated here — they are three quarters written and killing them to gain a
# version stamp would cost four hours each. They are a version mix in this tier and
# recorded as one; when they land, the same two tasks go again on 0.9.11 and the
# 0.9.6 pair becomes a fallback rather than a row.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=ys2
export YS_KEY="$(cat ~/.config/ys/key)"
exec node --experimental-strip-types src/cli/run-batch.ts \
  --tasks runs-40kv2/tasks.jsonl --runs runs-40kv2 \
  --concurrency 10 --stagger 15 --force
