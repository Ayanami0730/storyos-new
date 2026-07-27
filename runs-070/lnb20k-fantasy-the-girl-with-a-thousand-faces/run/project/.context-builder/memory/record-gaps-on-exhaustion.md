---
title: record-gaps-on-exhaustion
hook: record gaps when reads exhaust
scope: role-craft
source: s-001
last_verified_at: 2026-07-27T13:37:24.873Z
expires_at: 2027-07-27T13:37:24.873Z
---
When the read budget exhausts, write an explicit note_gap listing what was not checked and where, so the writer knows what to ask instead of inventing. Include files/paths searched.
