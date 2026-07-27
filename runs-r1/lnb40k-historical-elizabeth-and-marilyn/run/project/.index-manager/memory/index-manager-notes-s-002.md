---
title: record builder choices in index, not memory
hook: put builder choices into the index
scope: project-convention
source: s-002
last_verified_at: 2026-07-27T17:19:13.716Z
expires_at: 2027-07-27T17:19:13.716Z
---
When a context-builder flags gaps and supplies concrete choices to fill them, record those choices in the index (state entries with provenance) rather than in index-manager memory. Memory is for procedural lessons, not story facts. This keeps story facts auditable and avoids banned story facts in memory.
