#!/usr/bin/env bash
# The same-backbone baseline half of the four-tier terra experiment.
#
# Our harness rows on terra mean nothing on their own: "StoryOS beats agentwrite"
# and "terra beats gpt-5-mini" are the same number until the baselines run on the
# same model. These four systems on the same eight tasks are what separates them.
#
# A tier at a time because `run_nbrun.py` takes one manifest and one target length
# per invocation, and the 40k tier's two tasks live in the pinned tuning subset
# rather than in a `tier-40k.json` — there is no such file, by design, so that
# appending the two top-up ids cannot move the digest of eighty committed cells.
#
# Route: the runner's default public gateway, while the harness is on the internal
# one. Probed 2026-07-30 at 4/8/16 concurrent on both: zero failures, p50 1.9-2.0s,
# and the internal route showed no degradation with three harness cells in flight,
# so these two are separate buckets and this costs the harness nothing.
set -uo pipefail
cd "$HOME/lane/livenovelbench" || exit 1

PY=/home/dumingxuan/miniconda3/envs/pipeline/bin/python
export YS_KEY="${YS_KEY:-$(cat ~/.config/ys/key)}"
OUT="$HOME/storyos-data/outputs-lnb-terra"
CONC="${CONC:-12}"
SYSTEMS=(bare-long-context agentwrite agents-room-style raw-gpt-5.6-terra)

run_tier() {
  local tier="$1" manifest="$2"; shift 2
  echo "##### tier $tier — ${#SYSTEMS[@]} systems x $# task(s) — $(date -Is) #####"
  "$PY" experiments/novelbench-run/run_nbrun.py \
    --manifest "$manifest" \
    --backbone gpt-5.6-terra \
    --output-root "$OUT" \
    --systems "${SYSTEMS[@]}" \
    --tasks "$@" \
    --concurrency "$CONC" \
    --label "terra-$tier"
  echo "##### tier $tier exit=$? $(date -Is) #####"
}

# Longest first: the 80k cells are the ones the experiment turns on, and a failure
# there should surface before three cheaper tiers have been spent.
run_tier 80k benchmarks/novelbench/tier-80k.json \
  task-romance-our-perfect-storm task-fantasy-the-girl-with-a-thousand-faces
run_tier 60k benchmarks/novelbench/tier-60k.json \
  task-romance-the-night-we-met task-mystery-a-violent-masterpiece
run_tier 40k benchmarks/novelbench/novelbench-tuning-subset.json \
  task-fantasy-the-tapestry-of-fate task-historical-elizabeth-and-marilyn
run_tier 20k benchmarks/novelbench/tier-20k.json \
  task-romance-star-shipped task-horror-molka

echo "##### all tiers done $(date -Is) #####"
