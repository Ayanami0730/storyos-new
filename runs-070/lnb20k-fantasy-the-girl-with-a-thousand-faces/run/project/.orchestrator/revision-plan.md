# Revision plan
Committed scenes: 15. Did not complete: 2.
Promises made: 1. Still unpaid: 0.
Capabilities established: 1.
No revision tasks, and no promise left unpaid.
## Scenes that never landed

- s-016: abandoned by the orchestrator: The writer tool repeatedly failed to produce a draft for s-016 due to a token/context-length error (requests exceeded the provider's configured message token limit) across multiple attempts. Repair rounds remain but the failure is systemic (context size/session history causing rejections) and cannot be resolved within this scene transaction. Abandoning the scene so the problem can be addressed (reduce packet/context size, reset writer session, or re-run with a fresh writer process) rather than consuming further retries that will fail.
- s-017: abandoned by the orchestrator: Writer repeatedly failed to accept the packet due to token/context-length errors. Attempts exhausted for this transaction. Abandoning scene to avoid burning repair rounds; requires session reset or packet trimming before retry.