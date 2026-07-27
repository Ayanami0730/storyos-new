---
title: write-only commit tools required
hook: only the index-manager can perform atomic commit; use typed tools for state changes
scope: role-craft
source: s-001
last_verified_at: 2026-07-27T13:46:50.241Z
expires_at: 2027-07-27T13:46:50.241Z
---
Only the project's index-manager may perform atomic commits of scene prose into the canonical novel path. Do not attempt filesystem copies directly; use the provided typed tools to record state and then invoke the commit tool when available.
