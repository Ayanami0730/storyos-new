---
title: include-artifacts-and-unresolved-gaps
hook: always include builder/writer/verifier artifacts and record unresolved gaps
scope: project-convention
source: s-004
last_verified_at: 2026-07-27T14:11:19.884Z
expires_at: 2027-07-27T14:11:19.884Z
---
When committing a scene that the orchestrator instructs to include additional artifacts, ensure the commit metadata lists the builder, writer, and verifier artifacts. Also, when the builder packet flagged gaps left unresolved, add files into continuity/unresolved with the scene id and the listed gaps.
