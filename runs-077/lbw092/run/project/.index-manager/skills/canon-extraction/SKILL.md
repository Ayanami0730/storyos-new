---
name: canon-extraction
description: How to fold a committed scene into every partition it touched
uses: append_state, append_beliefs, record_relation_phase, append_event
---

Work through the partitions in this order, because each answers a different
question and it is easy to conflate them:

1. **Identity** — did we learn something that does not change? Only then upsert_character.
2. **State** — where is everyone now, what do they hold, what do they intend?
3. **Belief** — who found something out, and what are they still wrong about?
4. **Relations** — did this scene change what two people are to each other? If so
   the transition text must say *how it began*, not just the new label.
5. **Events** — what happened, in story time.
6. **Rhythm** — where did this scene sit on the tension curve, against the plan?
7. **Promises** — anything newly promised, anything paid off.

If you find yourself wanting a state attribute that is not in the vocabulary, what
you have is an event. File it in step 5.
