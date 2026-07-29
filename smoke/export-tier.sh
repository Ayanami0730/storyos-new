#!/usr/bin/env bash
# Export the finished cells of one tier batch into a scoring directory.
#
# Generalised from `export-arms.sh`, which hardcoded the 20k tier and the three
# scene-length arms. The tier and the destination system name are arguments here
# because the 40k and 60k rows have to be exportable while their batches are still
# running: a partial row scored early is what decides whether to keep iterating or
# bank what exists, and waiting for the last cell to make that call wastes the hours
# in which the decision could still change anything.
#
# The benchmark task id comes from the cell's own `task.json`, not from its
# directory name. Scoring is keyed on task id, so a guessed mapping grades a
# manuscript against another task's required elements.
#
# Skips a cell with no `story.md` rather than failing, so this is re-runnable as
# cells land. Refuses to leave a directory holding two harness versions unflagged.
#
#   export-tier.sh runs-40kv2 40k storyos-40k
#   export-tier.sh runs-60kv2 60k storyos-60k
set -uo pipefail
cd "$(dirname "$0")/.."
eval "$(~/miniconda3/bin/conda shell.bash hook)" && conda activate pipeline

BATCH="${1:?usage: export-tier.sh <runs-dir> <tier> <system>}"
TIER="${2:?}"
SYSTEM="${3:?}"
OUT="$HOME/storyos-data/outputs/$SYSTEM/novelbench"

#: The tier's nominal length, so cells of another tier in the same batch are
#: skipped rather than relabelled. `runs-lnb` holds 20k and 40k cells together, and
#: the first version of this script exported all eight into the 40k directory —
#: which is precisely the hazard `build_eval_manifest.py` was written to prevent:
#: a 20k manuscript scored for attainment against 40,000 words.
TIER_WORDS=$(python -c "
import json, pathlib
p = pathlib.Path.home()/'lane/livenovelbench/benchmarks/novelbench/tiers-v2.json'
print(json.loads(p.read_text())['tiers']['$TIER']['target_words'])")

n=0
skipped=0
for d in "$BATCH"/*/; do
  cell=$(basename "$d")
  [ -f "$d/run/story.md" ] || continue
  [ -f "$d/task.json" ] || { echo "  skip $cell — no task.json"; continue; }
  read -r task tgt <<<"$(python -c "
import json
d = json.load(open('$d/task.json'))
print(d.get('bench_task_id') or '-', d.get('target_words') or 0)")"
  if [ "$task" = "-" ]; then
    echo "  skip $cell — task.json has no bench_task_id, and guessing it would score"
    echo "       this manuscript against another task's required elements"
    continue
  fi
  if [ "$tgt" != "$TIER_WORDS" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  # Count only what the exporter actually accepted: it refuses an off-manifest
  # task, and a counter that increments regardless reports a row that is not there.
  if python smoke/export-lnb.py "$d/run" --task-id "$task" --tier "$TIER" \
      --system "$SYSTEM" --dest "$OUT" 2>&1 | head -2; then
    n=$((n + 1))
  else
    echo "  refused $cell"
  fi
done
echo "$n cell(s) exported to $OUT ($skipped cell(s) skipped as another tier)"

# A directory about to be scored must not mix harness versions: a stale row that
# survived an export once dragged a reported density from 3.32 to 4.40.
python - "$BATCH" <<'PY'
import json, sys, glob, collections, os
batch = sys.argv[1]
vers = collections.Counter()
for p in glob.glob(os.path.join(batch, "*", "summary-stdout.json")):
    if not os.path.exists(os.path.join(os.path.dirname(p), "run", "story.md")):
        continue
    try:
        vers[json.load(open(p)).get("harness_version")] += 1
    except Exception:
        pass
line = ", ".join(f"{v}x{n}" for v, n in sorted(vers.items(), key=lambda kv: str(kv[0])))
print(f"harness versions in the exported set: {line}")
if len(vers) > 1:
    print("  ^ MIXED VERSIONS — record this beside any number taken from it")
PY
