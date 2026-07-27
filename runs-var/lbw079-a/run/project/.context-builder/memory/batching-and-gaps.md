---
title: batch reads; record missing required literals
hook: batch reads and record missing required literals
scope: project-convention
source: s-001
last_verified_at: 2026-07-27T18:07:26.880Z
---
Batched read_index for all relevant entity files in one call; avoid multiple greps unless necessary. Fail if an orchestrator-required literal string is not found and record as note_gap.
