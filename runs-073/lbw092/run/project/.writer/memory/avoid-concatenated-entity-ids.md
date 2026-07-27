---
title: avoid concatenated entity ids
hook: Do not join entity ids in a single string in deltas
scope: project-convention
source: s-001
last_verified_at: 2026-07-27T14:57:04.204Z
expires_at: 2027-07-27T14:57:04.204Z
---
Lesson: When recording relations or claims, never concatenate multiple entity ids into one string (e.g., 'char-a,char-b'). Instead, create separate claims per entity or use a documented relation file. This avoids nomenclature_confusions during verification.
