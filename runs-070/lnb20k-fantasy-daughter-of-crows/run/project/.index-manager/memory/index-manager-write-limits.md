---
title: index-manager-write-limits
hook: what the index-manager can write and what it must ask for
scope: role-craft
source: s-001
last_verified_at: 2026-07-27T13:15:54.235Z
---
Index-manager can use provided typed tools to write into index partitions (characters, relations, events). It cannot create arbitrary files in novel/ until orchestrator/writer stores the prose. If prose path is requested for commit but file is missing, flag as unresolved and request writer/orchestrator to add file.
