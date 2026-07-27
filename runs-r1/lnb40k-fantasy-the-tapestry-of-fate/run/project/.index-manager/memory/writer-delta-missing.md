---
title: Backfill when writer omits state_delta
hook: backfill on missing writer state_delta
scope: project-convention
source: s-007
last_verified_at: 2026-07-27T18:05:46.662Z
expires_at: 2027-07-27T18:05:46.662Z
---
If a writer omits the .writer/state_deltas file for a scene, backfill only the explicit claims they supplied, record those claims with the scene provenance, and log the omission procedurally. Do not invent additional facts. This is a project-convention note.
