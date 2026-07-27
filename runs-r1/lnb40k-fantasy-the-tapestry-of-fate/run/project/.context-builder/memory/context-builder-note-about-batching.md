---
title: batch-reads-are-cheap
hook: Batch reads: ask for everything you need in one call
scope: project-convention
source: s-007
last_verified_at: 2026-07-27T18:00:42.092Z
expires_at: 2027-07-27T18:00:42.092Z
---
Remind self and others to batch read_index calls: collect all files needed (entities, objects, locations, relations) in one read_index invocation to reduce round trips and token retransmission. Based on current build: requested 12 files at once and then used parallel tool calls to add items.
