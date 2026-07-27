---
title: unresolved-finding-template
hook: how to record unresolved findings for scenes
scope: role-craft
source: s-002
last_verified_at: 2026-07-27T13:26:15.499Z
---
When a scene omits an object's primary text (e.g., a Contract's full wording) or whether a signature was a mark vs. full name, record an unresolved finding at continuity/unresolved/<scene>.json with keys: missing_contract_text (bool), signature_whether_mark_or_written (null/"mark"/"signature"), note (explain omission). For dorm scenes, use: 'detailed_punishment_methods' (null/true), 'dormitory_map' (null/true), note explaining omissions.
