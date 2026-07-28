#!/usr/bin/env bash
# One screen: what is running, how far it got, and whether the gateway is pushing
# back. Kept as a script because every inline version of this either matched its
# own command line in `pgrep`/`rg` or counted the shell that ran it.
cd "$(dirname "$0")/.."

BATCHES=(runs-lnb runs-lnb2 runs-lnbch runs-ch21)

echo "== running =="
ps -u "$USER" -o pid=,etime=,args= \
  | grep 'cli/write-story' \
  | grep -v ' grep ' \
  | sed -E 's#.*storyos-v3/(runs-[a-z0-9]+)/([^/]+)/run.*#\1 \2#' \
  | sort -k1,2 \
  | awk '{printf "  %-10s %-46s\n", $1, $2}'
# Both sides of a pipeline start together, so `ps` can see the `grep` that is
# about to read it — which is why the naive count read one too many.
n=$(ps -u "$USER" -o args= | grep 'cli/write-story' | grep -vc ' grep ' || true)
echo "  total: $n"

echo
echo "== progress =="
for p in "${BATCHES[@]}"; do
  [ -d "$p" ] || continue
  for d in "$p"/*/; do
    proj="$d/run/project"
    [ -d "$proj" ] || continue
    sc=$(find "$proj/novel/chapters" -name '*.md' 2>/dev/null | wc -l)
    # The benchmark's own count: CJK codepoints plus Latin word tokens. `wc -w`
    # reads a finished 1,850-character Chinese scene as twenty words, which is
    # the bug this tool was used to diagnose and then reproduced in its own output.
    w=$(find "$proj/novel/chapters" -name '*.md' -exec cat {} + 2>/dev/null \
      | python3 -c 'import sys,re; t=sys.stdin.read(); print(len(re.findall(r"[\u4e00-\u9fff]",t))+len(re.findall(r"\b[a-zA-Z]+\b",t)))')
    plan=$(grep -c '^  - id:' "$proj/novel/outline/beats.yaml" 2>/dev/null || echo 0)
    [ "$sc" = "0" ] && [ "$w" = "0" ] && [ "$plan" = "0" ] && continue
    printf '  %-46s %3s/%-3s scenes %7s words\n' "$(basename "$d")" "$sc" "$plan" "$w"
  done
done

echo
echo "== gateway pushback (429 / saturated / quota) =="
for p in "${BATCHES[@]}"; do
  [ -d "$p" ] || continue
  n=$(grep -rhoE '429|上游负载已饱和|quota_not_enough|rate limit' "$p" --include='*.log' 2>/dev/null | wc -l)
  printf '  %-10s %s\n' "$p" "$n"
done

echo
echo "== machine =="
printf '  loadavg %s\n' "$(cut -d' ' -f1-3 /proc/loadavg)"
ps -u "$USER" -o pcpu= | awk '{s+=$1} END {printf "  my cpu  %.1f%% = %.2f cores of %s\n", s, s/100, "'"$(nproc)"'"}'
