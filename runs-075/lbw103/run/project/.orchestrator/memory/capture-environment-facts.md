---
title: capture-environment-facts
hook: Record and pay off small environmental facts or mark them irrelevant.
scope: project-convention
source: s-004
last_verified_at: 2026-07-27T16:03:04.671Z
expires_at: 2027-07-27T16:03:04.671Z
---
Lesson: When a scene establishes an environmental fact (power out, pump dead, etc.) the context-builder must either mark it as a continuing constraint or the writer must pay it off later. Otherwise the fact becomes a dangling capability that looks like a dropped thread on whole-story pass. Procedure: 1) Context-builder always emits a one-line state-delta for environment facts (power, open/closed, functioning items) at scene commit. 2) Writers either reference that state-delta in follow-up scenes or explicitly note it as 'no longer relevant' in the next committed scene. 3) If a scene is aborted, record which established facts the aborted scene would have paid off so the plan can route them elsewhere. Also: prepare phrasing templates (less-graphic) to avoid content-filter failures and a fallback micro-scene stub the writer can fill if a full scene fails.
