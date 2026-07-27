---
title: Batch reads practice for context-builder
hook: Batch reads: ask for all files at once
scope: role-craft
source: s-006
last_verified_at: 2026-07-27T17:53:25.782Z
expires_at: 2027-07-27T17:53:25.782Z
---
Decide which index files you need before using read_index; pass them in one call. This minimizes round-trips, transcript growth, and time. Based on recent builds where multiple single-file reads caused long loops.
