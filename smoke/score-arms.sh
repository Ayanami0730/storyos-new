#!/usr/bin/env bash
# Score our own arms with the frozen scorers, and nothing else about the pipeline.
#
# Everything here is copied from `score_all_tiers.sh` — the same manifest builder,
# the same summariser model, the same judge model, `--runs 3`, the same worker
# counts. The only difference is the `--systems` list. A comparison is worth
# making only when the single thing that changed is the system under test, and the
# temptation on a deadline is to raise the judge's concurrency or drop `--runs 3`
# for speed, either of which would make our rows and the baselines' incomparable.
#
# The summariser is the one stage still on `gpt-5-mini`, which is the group our
# generation is also drawing on. It stays at 6 workers for that reason: taking
# summariser throughput out of the generation queue tonight would slow the thing
# on the critical path to speed up the thing that is not.
#
#   score-arms.sh 20k storyos-def storyos-ch24 storyos-ch36
#   score-arms.sh 60k storyos-ch24
set -u
cd /home/dumingxuan/lane/livenovelbench || exit 1

TIER="${1:?usage: score-arms.sh <tier> <system>...}"
shift
SYSTEMS="$*"
[ -n "$SYSTEMS" ] || { echo "no systems given" >&2; exit 1; }

PY=/home/dumingxuan/miniconda3/envs/pipeline/bin/python
DATA=/home/dumingxuan/storyos-data
export YS_KEY="$(cat /home/dumingxuan/.config/ys/key)"
export LNB_MODEL_ALIAS="gpt-5-mini=openai/gpt-5-mini"

SUMMARY_WORKERS=6
JUDGE_WORKERS=16
AUDIT_WORKERS=8

mkdir -p /tmp/lnb-queue
MANIFEST="/tmp/lnb-queue/eval-arms-${TIER}.jsonl"

"$PY" experiments/novelbench-run/build_eval_manifest.py \
  --tier "$TIER" --systems $SYSTEMS --out "$MANIFEST" || exit 1
echo "##### manifest $(wc -l < "$MANIFEST") row(s) $(date -Is) #####"

# The audit is the metric this architecture is built around, so it starts first
# and runs beside the summariser rather than after the judge.
"$PY" experiments/fact_metric/run_consistency.py \
  --manifest "$MANIFEST" --out "${DATA}/fact-metric/consistency-arms" \
  --workers "$AUDIT_WORKERS" > "/tmp/lnb-queue/audit-arms-${TIER}.log" 2>&1 &
AUDIT_PID=$!

"$PY" experiments/quality_judge/scripts/summarise_story.py \
  --manifest "$MANIFEST" --out "${DATA}/quality-judge/summaries-arms" \
  --model gpt-5-mini --workers "$SUMMARY_WORKERS"
echo "##### arms-${TIER} SUMMARIES exit=$? $(date -Is) #####"

"$PY" experiments/quality_judge/scripts/judge_story_aggregation.py \
  --summaries "${DATA}/quality-judge/summaries-arms" \
  --out "${DATA}/quality-judge/aggregation-arms" \
  --model gpt-5.6-sol --runs 3 --workers "$JUDGE_WORKERS"
echo "##### arms-${TIER} JUDGE exit=$? $(date -Is) #####"

wait "$AUDIT_PID"
echo "##### arms-${TIER} AUDIT exit=$? $(date -Is) #####"
