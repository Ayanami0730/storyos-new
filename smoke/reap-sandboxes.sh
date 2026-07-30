#!/usr/bin/env bash
# Kill sandbox containers whose harness process is gone.
#
# `DockerSandbox.stop()` kills the container on a clean exit, and a killed batch is
# not a clean exit — which is ordinary rather than exceptional, so the orphans
# accumulate: 35 on this host when this was written, the oldest up 30 hours, each
# holding a read-only mount of a run directory that may no longer exist. The cost is
# not memory (measured: 48KiB–436KiB each) but that `docker ps` stops being a list of
# what is running, which is the thing you consult when something looks stuck.
#
# Containers are labelled with the pid that started them, so this needs no guessing
# from uptime. Unlabelled containers predate the label and are only reported.
#
#   smoke/reap-sandboxes.sh            # report only
#   smoke/reap-sandboxes.sh --kill
set -uo pipefail

KILL=0
[ "${1:-}" = "--kill" ] && KILL=1

labelled=$(docker ps --filter 'label=storyos.sandbox=1' --format '{{.ID}}')
orphans=()
live=0
for id in $labelled; do
  pid=$(docker inspect "$id" --format '{{index .Config.Labels "storyos.pid"}}' 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    live=$((live + 1))
  else
    orphans+=("$id")
  fi
done

# Anything on the pinned image without our label was started before labelling.
unlabelled=$(docker ps --filter 'ancestor=alpine' --format '{{.ID}}' |
  grep -vxF -f <(printf '%s\n' $labelled /dev/null) 2>/dev/null || true)

echo "labelled sandboxes: $((live + ${#orphans[@]})) ($live live, ${#orphans[@]} orphaned)"
echo "unlabelled alpine containers: $(printf '%s\n' $unlabelled | grep -c . || true)"

if [ "${#orphans[@]}" -eq 0 ]; then
  echo "nothing to reap"
  exit 0
fi

if [ "$KILL" -eq 1 ]; then
  printf '%s\n' "${orphans[@]}" | xargs -r docker kill >/dev/null
  echo "killed ${#orphans[@]} orphan(s)"
else
  echo "would kill: ${orphans[*]}"
  echo "re-run with --kill"
fi
