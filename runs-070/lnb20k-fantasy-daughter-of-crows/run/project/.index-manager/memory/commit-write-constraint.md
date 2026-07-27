---
title: commit-write-constraint
hook: how commits must be done
scope: role-craft
source: s-001
last_verified_at: 2026-07-27T13:14:53.196Z
---
Index-manager must ensure prose is stored at the requested path before final commit and cannot write files directly via bash in this environment. If novel prose file is missing, flag it as needing writing by the orchestrator or writer. Record this as a process note.
