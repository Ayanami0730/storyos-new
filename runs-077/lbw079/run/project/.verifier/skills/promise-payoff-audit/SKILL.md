---
name: promise-payoff-audit
description: How to judge whether an open promise is abandoned or merely open
uses: run_command
---

Read `continuity/plot-contracts.jsonl`. For each unpaid promise ask:

1. Is its due-by scene already written? Then it is late, not open.
2. Has anything referred to it since it was made? A thread nobody has touched for
   many scenes is drifting even if it is not yet due.
3. At scene level an unpaid promise is never an error — it is an open loop, and
   the story is not finished. Report it as a warning or not at all.
