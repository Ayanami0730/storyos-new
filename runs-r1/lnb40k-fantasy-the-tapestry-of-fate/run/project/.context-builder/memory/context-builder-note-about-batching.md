---
title: batch reads to reduce round-trips
hook: batch reads: ask for all index files you need at once
scope: project-convention
source: s-002
last_verified_at: 2026-07-27T17:11:00.526Z
---
Tried to be conservative but still made multiple read_index calls; remember to collect all desired paths in one read_index next time. When in doubt, list the scene file, location, characters present, and any directly referenced objects in a single call.
