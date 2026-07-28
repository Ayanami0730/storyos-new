#!/usr/bin/env bash
# The chapter-length A/B: same four tasks, two scene sizes, on zhizengzeng.
#
# ## Why paired rather than repeated
#
# Two same-code samples of one task have come back 6.5 S-bar points apart, so
# three samples of one task cannot resolve anything smaller than that. Task
# difficulty is the dominant term and pairing removes it, so four tasks run both
# ways gives four differences to read.
#
# ## Why not the default gateway
#
# It spent this morning refusing us: a forty-minute `401 Invalid token` window
# that truncated three runs to attainment 0.05–0.06, then sustained `429 …
# swedencentral has exceeded rate limit` that killed four more during planning,
# at concurrency 2. The quota is shared with another lane on this machine.
#
# ## Why one account per arm
#
# Each account is its own quota, and the arms must not be able to differ because
# one of them ran while a quota was degraded. Splitting by arm rather than
# interleaving means a per-account outage shows up as one arm failing loudly,
# which is a result you can see, rather than as a few slow scenes on one side,
# which is a result you cannot.
#
# Concurrency 4 per account, against a measured knee of 8 parallel requests per
# key — a run is roughly one request in flight, so four leaves headroom for the
# retries that a shared endpoint still occasionally needs.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/bin/node22/bin:$PATH"
export STORYOS_SUPPLY=zzz

launch() { # key-file tasks-file log
  ZZZ_KEY="$(cat "$1")" setsid nohup node --experimental-strip-types src/cli/run-batch.ts \
    --tasks "$2" --runs runs-ab --concurrency 4 --stagger 10 --force \
    > "$3" 2>&1 < /dev/null &
  echo "launched $2 with $(basename "$1") -> $3"
}

stamp=$(date +%H%M)
launch ~/.config/zzz/key  runs-ab/tasks-control.jsonl "runs-ab/control-$stamp.log"
sleep 5
launch ~/.config/zzz/key2 runs-ab/tasks-chapter.jsonl "runs-ab/chapter-$stamp.log"
