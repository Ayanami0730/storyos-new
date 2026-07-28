#!/usr/bin/env bash
# Relaunch the LongBench-Write default arm on 0.9.11.
#
# The previous attempt at this batch ran on 0.9.10, where a spelling check
# constructed a finding with a severity its subtype forbids; the throw landed
# after the scene had moved to VALIDATING, a state `verify()` refuses to
# re-enter, so the scene could never be verified or committed. Two of the five
# cells that finished delivered one scene of four, and the batch's own rerun hit
# it again because the trigger is the manuscript's spelling rather than chance.
#
# `lbw092` is the verification as well as a data point: same task, same route,
# same concurrency, only the version differs. It established British English on
# its first scene and then deadlocked on every later one. If it commits 4 of 4
# the fix holds in a live run, which is the only place it matters.
#
# A script rather than an inline command because the inline heredoc chains have
# failed here before, and because a batch parent must be startable and killable
# by name.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=ys2
export YS_KEY="$(cat ~/.config/ys/key)"
exec node --experimental-strip-types src/cli/run-batch.ts \
  --tasks runs-lbw21/tasks.jsonl --runs runs-lbw21 \
  --concurrency 10 --stagger 8 --force
