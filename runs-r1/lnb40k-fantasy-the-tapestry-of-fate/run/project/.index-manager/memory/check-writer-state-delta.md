---
title: Check for writer state_delta before commit
hook: verify writer state delta exists before committing
scope: project-convention
source: s-003
last_verified_at: 2026-07-27T17:29:43.816Z
expires_at: 2026-08-26T17:29:43.816Z
---
When committing a scene, check for the presence of .writer/state_deltas/<scene>.json. If it is missing, do not invent additional canonical facts without explicit instruction — record that the delta was absent and backfill only when the orchestrator asks. If a state_delta is staged later, audit it for conflicts before accepting.
