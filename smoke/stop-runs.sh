#!/usr/bin/env bash
# Stop every run and batch supervisor, gracefully.
#
# A script rather than an inline command because the inline version kept killing
# the shell that issued it: `pgrep -f cli/write-story` matches the calling
# shell's own command line, which contains that string. It happened three times.
set -uo pipefail
self=$$
stop() {
  for pid in $(pgrep -u "$USER" -f "$1" 2>/dev/null); do
    [ "$pid" = "$self" ] && continue
    kill -TERM "$pid" 2>/dev/null && echo "TERM $pid"
  done
}
stop 'cli/write-story'
sleep 8
stop 'cli/run-batch'
sleep 4
left=$(pgrep -u "$USER" -f 'cli/write-story' 2>/dev/null | grep -v "^$self$" | wc -l)
echo "remaining writers: $left"
