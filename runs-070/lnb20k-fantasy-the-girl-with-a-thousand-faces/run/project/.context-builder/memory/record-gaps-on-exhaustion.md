---
title: context-builder-procedural-note
hook: record gaps explicitly when reads exhaust
scope: role-craft
source: s-001
last_verified_at: 2026-07-27T12:54:50.639Z
---
When read budget limits are hit, record explicit gaps (what was searched and what is missing) in note_gap so the writer chooses the missing facts rather than inventing them. Do not record story facts in memory. This saves repair rounds in later scenes.
