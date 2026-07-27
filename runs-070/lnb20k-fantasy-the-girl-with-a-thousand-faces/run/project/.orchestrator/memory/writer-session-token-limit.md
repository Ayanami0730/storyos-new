---
title: writer-session-token-limit
hook: Reset writer session or trim context when builder packets grow too large
scope: role-craft
source: s-017
last_verified_at: 2026-07-27T16:05:19.128Z
expires_at: 2027-07-27T16:05:19.128Z
---
Problem: writer calls failed repeatedly due to exceeding provider token/context limits caused by large accumulated session history and builder packets. Cause: the writer session carried a long context and the builder produced large packets; repeated retries repeated the same large input.
Fixes to apply next run:
1) Reset or flush the writer model/session between long scenes (especially late in the book) before calling writer.  
2) Trim context packets: include only immediately necessary provenance (scene packet, key entity facts, explicit gaps), avoid full transcripts of prior drafts.  
3) If a packet is large, chunk the scene: provide a minimal prompt plus an attached smaller context file the writer reads in steps.  
4) If a scene must be abandoned and retried, prefer session reset rather than repeated retries with same packet.
5) Record this as an operational step in orchestration checklist for endgame scenes.
Why it matters: prevents wasting repair rounds and avoids abandoned scenes mid-run.
