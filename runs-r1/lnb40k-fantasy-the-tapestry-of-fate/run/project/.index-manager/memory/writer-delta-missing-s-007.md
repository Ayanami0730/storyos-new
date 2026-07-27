---
title: Writer delta missing handling
hook: backfill explicit writer claims when state_delta omitted
scope: project-convention
source: s-007
last_verified_at: 2026-07-27T18:07:29.335Z
expires_at: 2027-07-27T18:07:29.335Z
---
If a writer omits .writer/state_deltas for a scene, backfill only the explicit claims they supplied, record those claims with scene provenance, and log the omission procedurally. Do not invent additional facts.
