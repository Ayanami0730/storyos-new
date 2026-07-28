#!/usr/bin/env bash
# Export every finished LiveNovelBench cell, one directory per scene-length arm.
#
# The three arms run the same twelve tasks, and the scoring layout is keyed by
# `task_id`, so they must not share a destination — the second export would
# overwrite the first and one arm's manuscript would be scored as the other's.
#
#   storyos-def    default 1200 words/scene   (17 scenes at 20k)
#   storyos-ch24   2400 words/scene           (8-9 scenes)
#   storyos-ch36   3600 words/scene           (6 scenes)
#
# The default arm gets its own directory rather than the legacy `storyos` one,
# which already held rows this batch did not write: a `task-fantasy-daughter-of-
# crows` cell exported days ago from `runs-070` at **harness_version 0.7.2**. The
# export merges by task_id, so that row survived and was scored as a current
# cell — it carried 7 of its 10 errors as `perspective_confusions`, the defect
# 0.8.8 exists to remove, and it dragged the default arm's reported density from
# 3.32 to 4.40. Hence the harness-version check at the end: a directory about to
# be scored must not mix versions.
#
# Skips a run with no story.md rather than failing the batch: cells are still
# finishing and this is meant to be re-runnable as they land.
set -uo pipefail
cd "$(dirname "$0")/.."
eval "$(~/miniconda3/bin/conda shell.bash hook)" && conda activate pipeline

OUT="$HOME/storyos-data/outputs"

export_one() {
  local run="$1" task="$2" system="$3"
  [ -f "$run/story.md" ] || return 0
  python smoke/export-lnb.py "$run" --task-id "$task" --tier 20k \
    --system "$system" --dest "$OUT/$system/novelbench" 2>&1 | head -2
}

# Default arm: full scene count.
for d in runs-lnb/lnbcustom-*/ ; do
  cell=$(basename "$d")
  case "$cell" in *-ch|*-ch24) continue;; esac
  task="task-${cell#lnbcustom-}"
  export_one "$d/run" "$task" storyos-def
done
for d in runs-lnb/lnb20k-*/ ; do
  cell=$(basename "$d")
  case "$cell" in *-ch|*-ch24) continue;; esac
  export_one "$d/run" "task-fantasy-daughter-of-crows" storyos-def
done

# 3600 arm.
for d in runs-lnb/*-ch/ ; do
  cell=$(basename "$d")
  case "$cell" in
    lnb20k-crows-ch) task="task-fantasy-daughter-of-crows";;
    *) task="task-${cell#lnbcustom-}"; task="${task%-ch}";;
  esac
  export_one "$d/run" "$task" storyos-ch36
done

# 2400 arm.
for d in runs-lnbch/*-ch24/ ; do
  cell=$(basename "$d")
  task="task-${cell#lnbcustom-}"; task="${task%-ch24}"
  export_one "$d/run" "$task" storyos-ch24
done

echo
for s in storyos-def storyos-ch24 storyos-ch36; do
  n=$(ls "$OUT/$s/novelbench"/*.txt 2>/dev/null | wc -l)
  # One version per directory, checked rather than assumed: a stale row from an
  # earlier export is invisible in the .txt listing and reads as a normal cell.
  v=$(python - "$OUT/$s/novelbench/metadata.jsonl" <<'PY'
import json, sys
from collections import Counter
try:
    rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
except OSError:
    print("no metadata"); raise SystemExit
c = Counter(r.get("harness_version") for r in rows)
print(", ".join(f"{k or '?'}x{n}" for k, n in c.most_common()) + (
    "   <-- MIXED VERSIONS, do not score this directory" if len(c) > 1 else ""))
PY
)
  echo "$s: $n cell(s), $v"
done
