---
name: promise-payoff-audit
description: Procedure to ensure promises registered are matched by scene content before payoff
uses: read_index, register_promise, pay_off_promise
---

1. Read the scene prose being committed with read_index. 2. Verify the promise id appears in the writer's declared promises for the scene. 3. Check the quoted text matches a verbatim substring of the scene prose. 4. If all checks pass, call pay_off_promise with the contract id and the quote. 5. If any check fails, return an error listing the mismatch.
