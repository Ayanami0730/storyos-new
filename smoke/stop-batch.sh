#!/usr/bin/env bash
# Stop one batch by its runs directory, leaving the others alone.
#
# A script, and matching on the run directory rather than on `cli/write-story`,
# because the inline form of this kept killing the shell that issued it: the
# command line contains the pattern it greps for. That happened three times
# before it became a file.
#
#   stop-batch.sh runs-ch21
set -uo pipefail
dir="${1:?usage: stop-batch.sh <runs-dir>}"
self=$$
for pid in $(ps -u "$USER" -o pid=,args= | grep "/${dir}/" | grep -v ' grep ' | awk '{print $1}'); do
  [ "$pid" = "$self" ] && continue
  kill -TERM "$pid" 2>/dev/null && echo "TERM $pid"
done
sleep 8
# Both sides of a pipeline start together, so `ps` sees the `grep` that is about
# to read it, and that grep's own command line contains the pattern. Filtering it
# out is the difference between "one left" and "none left" — which cost a round
# of confused cleanup.
left=$(ps -u "$USER" -o args= | grep "/${dir}/" | grep -v ' grep ' | grep -c 'cli/write-story' || true)
echo "remaining in $dir: $left"
