---
title: Backfill when writer state delta missing
hook: state delta absent; backfill index from supplied prose
scope: project-convention
source: s-006
last_verified_at: 2026-07-27T17:58:13.368Z
expires_at: 2027-07-27T17:58:13.368Z
---
If a writer state-delta file is absent when committing a scene, backfill index entries from the prose submitted with that scene and record provenance as that scene id. Notify the writer to produce the missing state-delta and the scene prose file so future edits carry proper provenance.
