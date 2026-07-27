---
title: avoid creating nonexistent entity ids
hook: do not attach claims to non-index entity ids
scope: project-convention
source: s-001
last_verified_at: 2026-07-27T12:54:59.011Z
---
When composing state deltas, never use entity ids that are not present in the index. If a needed entity does not exist, either ask the context-builder or create the entity deliberately and document why. Attaching claims to non-existent ids (for example, ad-hoc scene or project-level ids) creates dangling references the verifier will reject.
