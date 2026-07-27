---
title: batch-index-reads
hook: batch index reads in one call
scope: project-convention
source: s-001
last_verified_at: 2026-07-27T16:13:42.364Z
---
Always batch index reads for context assembly; read_index supports many files per call and saves roundtrips.
