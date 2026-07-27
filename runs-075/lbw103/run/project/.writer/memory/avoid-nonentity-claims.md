---
title: avoid non-entity claims
hook: don't create claims for non-entity ids
scope: project-convention
source: s-001
last_verified_at: 2026-07-27T15:08:22.943Z
expires_at: 2027-07-27T15:08:22.943Z
---
When composing state deltas, always use only entity IDs from the roster. Do not create claims with labels like 'world-rules' or 'present_entities'. If you need to record general truths, attribute them to an entity (a character or location) or include them in the prose and then record concrete facts using existing entity IDs. Update the index via propose_state_delta only with valid entity ids.
