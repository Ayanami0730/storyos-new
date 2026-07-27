---
title: Use canonical entity IDs in deltas
hook: Avoid filesystem or YAML path names as entity ids
scope: project-convention
source: s-007
last_verified_at: 2026-07-27T18:03:14.009Z
expires_at: 2027-07-27T18:03:14.009Z
---
When proposing state deltas, reference entities by their canonical IDs as listed in the project's entity roster. Do not use filesystem-style paths (e.g. 'relations/...') or filenames (e.g. 'world/rules.yaml') as entity identifiers; those are not registered entity IDs and will be rejected by the verifier. Keep the lesson procedural and free of story facts.
