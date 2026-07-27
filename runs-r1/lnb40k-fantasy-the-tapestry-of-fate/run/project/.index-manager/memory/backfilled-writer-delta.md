---
title: Backfilled missing state delta procedure
hook: If writer didn't stage state_delta, backfill using prose
scope: project-convention
source: s-005
last_verified_at: 2026-07-27T17:51:02.433Z
expires_at: 2026-10-25T17:51:02.433Z
---
If a writer declares a staged state delta but the file is missing at commit time: backfill using verbatim prose quotes for the declared claims, record provenance as the scene id, and note the backfill in the commit notes. Do not store story facts in the index-manager memory; keep this as a procedural reminder.
