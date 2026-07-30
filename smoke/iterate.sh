#!/usr/bin/env bash
# One iteration: generate a subset, score it, print the deltas against the last one.
#
# The loop this replaces was a full 21-cell LongBench-Write row plus twelve cells per
# LiveNovelBench tier — four to seven hours, the whole gateway, and an answer that
# arrives after the next two changes have already landed. The subsets are the tasks
# we are worst at (`smoke/make-iter-subsets.py` says why each was chosen), so a
# change that does not move them does not move the row.
#
# One route on purpose. `zzz` is 40% slower per scene than the internal `openai/`
# group at the same concurrency and its second key is the only one with credit; the
# public plain-`gpt-5-mini` group still 429s at concurrency 4. Splitting a subset
# across routes also puts a supply difference inside a comparison that is supposed
# to be about the code, so a subset run is `ys2` and nothing else.
#
#   smoke/iterate.sh lbw fast              # 8 cells, ~1 h
#   smoke/iterate.sh lbw full              # adds the 20k-word task, ~2.5 h
#   smoke/iterate.sh lnb fast              # 3 cells at 20k, ~4 h
#   smoke/iterate.sh lnb full 60k          # 3 cells at 60k, ~7 h
#   PAR=2 smoke/iterate.sh lbw fast        # gentler on the gateway
set -uo pipefail
cd "$(dirname "$0")/.."

BENCH="${1:?usage: iterate.sh <lbw|lnb> <fast|full> [tier]}"
SIZE="${2:-fast}"
TIER="${3:-20k}"
PAR="${PAR:-4}"

export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=ys2
export YS_KEY="$(cat ~/.config/ys/key)"

VERSION="$(node --experimental-strip-types -e 'import {VERSION} from "./src/version.ts"; process.stdout.write(VERSION)')"

case "$BENCH" in
  lbw) TASKS="subsets/lbw-${SIZE}.jsonl";     RUNS="runs-iter-lbw-${SIZE}-${VERSION}" ;;
  lnb) TASKS="subsets/lnb-${SIZE}-${TIER}.jsonl"; RUNS="runs-iter-lnb-${SIZE}-${TIER}-${VERSION}" ;;
  *)   echo "bench must be lbw or lnb" >&2; exit 1 ;;
esac

[ -f "$TASKS" ] || { echo "no subset at $TASKS — run smoke/make-iter-subsets.py" >&2; exit 1; }

echo "### $BENCH $SIZE on $VERSION — $(wc -l < "$TASKS") cell(s), $PAR at a time, route ys2"
echo "### runs -> $RUNS"
mkdir -p "$RUNS"

# `--force` deliberately absent: a re-run picks up where a kill left off, which is
# what you want when a subset is interrupted by the next idea.
node --experimental-strip-types src/cli/run-batch.ts \
  --tasks "$TASKS" --runs "$RUNS" --concurrency "$PAR" --stagger 8 \
  2>&1 | tee "$RUNS/batch.log"

echo "### generation done $(date -Is)"
"$HOME/miniconda3/envs/pipeline/bin/python" smoke/batch-integrity.py "$RUNS" \
  || echo "### integrity: see above before trusting any number"

if [ "$BENCH" = "lbw" ]; then
  # The judge model's own group lost its channel on 2026-07-29; the `openai/` prefix
  # is the same model on the group that answers. Only the wire name moves.
  export LBW_JUDGE_WIRE_MODEL="${LBW_JUDGE_WIRE_MODEL:-openai/gpt-5.5}"
  PAR=8 bash smoke/score-lbw-batch.sh "$RUNS"
  echo "### scored $(date -Is)"
else
  echo "### LiveNovelBench scoring is a separate pipeline; run:"
  echo "###   bash smoke/export-tier.sh $RUNS $TIER storyos-iter-$TIER"
  echo "###   JUDGE_WORKERS=16 bash smoke/score-arms.sh $TIER storyos-iter-$TIER"
fi
