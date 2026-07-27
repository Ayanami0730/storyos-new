---
title: read-budget-note
hook: Remember read budget constraints for context-builder
scope: project-convention
source: s-001
last_verified_at: 2026-07-27T12:53:49.643Z
expires_at: 2027-07-27T12:53:49.643Z
---
Context-builder read budget is 16 reads per scene (bash, read, read_index combined). Plan searches accordingly. When reads exhaust, stop and record what was not checked using note_gap. This avoids over-reading and silent assumptions.
