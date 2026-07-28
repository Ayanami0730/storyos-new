#!/usr/bin/env bash
# One line per live run: scenes committed, words, how long since the last
# transcript write, and the voice the plan declared.
#
# The voice column is there because a packet that carries the constraint while
# `novel/style/voice.md` still holds its seed text is the exact shape of the
# defect that produced seven of nine consistency errors.
cd "$(dirname "$0")/.."
for d in "$@"; do
  p="$d/run/project"
  n=$(find "$p/novel/chapters" -name '*.md' 2>/dev/null | wc -l)
  w=$(find "$p/novel/chapters" -name '*.md' -exec cat {} + 2>/dev/null | wc -w)
  v=$(grep -m1 '^Narration:' "$p/novel/style/voice.md" 2>/dev/null || echo '(not declared)')
  last=$(ls -t "$p"/runtime/transcripts/*/*.jsonl 2>/dev/null | head -1)
  if [ -n "$last" ]; then age="$(( $(date +%s) - $(stat -c %Y "$last") ))s"; else age="n/a"; fi
  printf '%-42s %3s scenes %7s words  %8s ago  | %s\n' "$(basename "$d")" "$n" "$w" "$age" "$v"
done
