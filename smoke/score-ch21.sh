#!/usr/bin/env bash
# Score every finished LongBench-Write chapter-arm cell, several at a time.
#
# `score-lbw.sh` scores one cell and runs the judge at `--concurrency 1`, because
# it was written for a single run. Twenty-one cells at that rate is an hour of
# waiting on a gateway that is not the constraint: probed directly, `gpt-5.6-sol`
# took 32 parallel requests with zero failures and a flat p50 of 1.4-2.0s, and
# throughput peaked at 24. So the parallelism goes here, one process per cell,
# and each cell keeps its own `scoring/` directory — the wrapper derives that
# path from the run directory, so two cells cannot write into one judgement file.
#
# Deliberately not raising `--concurrency` inside the wrapper: that flag is on
# the frozen scorer, and a comparison is only worth making if the only thing that
# changed is the system under test.
set -uo pipefail
cd "$(dirname "$0")/.."
export YS_KEY="${YS_KEY:-$(cat ~/.config/ys/key)}"
PAR="${PAR:-7}"

cells=()
for d in runs-ch21/*/; do
  cell=$(basename "$d")
  [ -f "$d/run/story.md" ] || continue
  cells+=("$cell")
done
echo "${#cells[@]} cell(s) to score, $PAR at a time"

printf '%s\n' "${cells[@]}" | xargs -P "$PAR" -I{} bash -c '
  cell="{}"
  out="runs-ch21/$cell/score.txt"
  if bash smoke/score-lbw.sh "runs-ch21/$cell/run" "${cell%-ch}" > "$out" 2>&1; then
    printf "%-14s %s\n" "$cell" "$(grep -E "^  S-bar" "$out" | tail -1)"
  else
    printf "%-14s FAILED  %s\n" "$cell" "$(tail -2 "$out" | head -1)"
  fi
'
