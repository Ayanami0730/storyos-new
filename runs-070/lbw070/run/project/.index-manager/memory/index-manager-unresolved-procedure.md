---
title: index-manager-unresolved-procedure
hook: How to record unresolved verifier findings when instructed to commit
scope: role-craft
source: s-002
last_verified_at: 2026-07-27T13:20:43.320Z
expires_at: 2027-07-27T13:20:43.320Z
---
When the orchestrator instructs committing despite unresolved verifier findings, record the unresolved finding into continuity/unresolved/<scene>.json with the verifier's audit path. Do not alter canonical facts to 'resolve' contradictions; instead record them and cite the transcript/audit path. Use append_event to place an event noting the unresolved finding and keep the scene's state changes minimal and faithful to prose. This procedure is about bookkeeping, not story facts.
