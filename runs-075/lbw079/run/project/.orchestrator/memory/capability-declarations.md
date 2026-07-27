---
title: capability-declarations
hook: Declare or deny capabilities explicitly.
scope: project-convention
source: s-004
last_verified_at: 2026-07-27T15:28:45.266Z
---
When a scene mentions a system property that later matters (power, backup generator, a phone signal) either (a) declare the capability explicitly and show its limits, or (b) deny it explicitly. Leaving capability implication implicit creates a later fake defect that is costly to fix. In practice, add a single line early that affirms presence or absence (e.g., 'there's no generator' or 'the neighbors sometimes let us use their old generator') so later payoffs or uses do not require costly rewrites.
