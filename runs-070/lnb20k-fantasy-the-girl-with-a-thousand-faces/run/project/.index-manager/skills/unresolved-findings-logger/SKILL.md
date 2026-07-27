---
name: unresolved-findings-logger
description: How to format and write unresolved continuity findings to continuity/unresolved/<scene>.json during a commit that must proceed despite blocking continuity mismatches.
uses: functions.read, functions.register_promise, functions.read_index
---

1. Collect all registered 'continuity-unresolved-<scene>:finding-#' promises created during the review of the scene. 2. For each finding, extract: - id: the promise id - field: canonical field (entity/attribute) - prose_quote: exact scene quote that triggered the finding - contradicts: the prior fact (reference the scene id and quote) - reason: short explanation why unresolved - options: list of possible resolutions - registered_by: agent id and timestamp 3. Write a JSON array to continuity/unresolved/<scene>.json containing these entries and a short header {scene: <scene>, committed_with_unresolved: true, note: <short human summary>} 4. Return the path and the list of entries for review and inclusion in commit metadata.
