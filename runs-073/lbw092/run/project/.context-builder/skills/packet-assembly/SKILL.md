---
name: packet-assembly
description: What to search for when building a scene's context, and in what order
uses: run_command, read_relation_history
---

Priority order, not similarity order. Nothing in P0 or P1 may be displaced by
something that merely looks relevant.

1. P0 — the scene card, the world rules, the reveal limits, the base revision.
2. P1 — for every present entity: identity, current state, beliefs as of this scene.
   Use `read_relation_history` for pairs who are both present; the phase
   transitions are what a label cannot carry.
3. P2 — the previous scene verbatim, plus any promise due here.
4. P3 — remote recall: grep for the entity ids in earlier scenes.
5. P4 — background, if there is room.

If a hard-required id does not resolve, fail the build and say which. Letting the
writer infer a constraint is how a scene gets rejected three attempts later.
