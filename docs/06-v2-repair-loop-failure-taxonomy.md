# What 25 iterations of the v2 repair loop taught us

Salvaged 2026-07-25 from the sgp-dev codex session (`storyos` branch `codex-run`,
`702bcde..dc66b77`, ~26 hours, ~30 commits) before that session was retired. The
code is for the architecture v3 replaces, so none of it is being merged. The
*failure taxonomy* is the asset: each entry is a precisely characterised way a
typed-state gated repair loop breaks, reproduced on real runs with journal
hashes. Primary source: `storyos/docs/11-iteration-log.md` (remote), which stays
in the `storyos` repo.

## The meta-lesson

Every one of those iterations was validated by **"does the gate pass / does the
task complete"**. Not once was CED computed. Twenty-six hours of engineering
optimised gate-passage, which is not the quantity the paper is judged on, and
the local measurement (CED 4.672 vs bare 4.069) says gate-passage and quality had
already decoupled.

Two design rules for v3 follow directly:

1. **Every engine iteration must be scored on the evaluation metric before it is
   called an improvement.** A change that makes runs complete but does not move
   CED is a reliability fix, and must be labelled as one.
2. **A validation loop whose failure modes require 25 sequential micro-fixes is
   the wrong shape.** The fixes never converged: each one exposed the next
   boundary. That is evidence about the architecture, not about effort.

## Taxonomy

### A. The engine rewriting the agent's proposal — the dominant failure family

v2 has deterministic "preservation helpers" that merge the writer's raw patch
with material carried from the previous rejected attempt. They caused the two
most expensive dead-ends observed:

- **Prose rollback loop.** `_preserve_exact_repair_text` restored previously
  rejected prose whenever an unrelated carried fact-ref requirement was already
  satisfied. In `tuning-v2-disk-recovered-r1`, all nine drafts of scene 8 had
  **the same prose digest**: the quality reviewer flagged a name typo, the
  writer corrected it, the helper reverted the correction, forever.
- **Fact and grant resurrection.** `_preserve_unaffected_knowledge_grants`
  restored a grant for a fact the writer had deliberately removed, and
  referential closure then restored the fact itself. Drafts 4–7 and 9 of one
  scene all failed on the same temporal overlap for this reason.

**v3 rule:** the engine never partially rewrites an agent proposal. It accepts
it, rejects it with findings, or asks for a new one. Any merging is the writer's
job, done in the writer's own turn, visible in the transcript.

### B. Non-deterministic re-extraction

Identical prose re-audited produced a different claim set (`cli-8k-20260724-a`).
Fixed by caching the audit bound to `(exact text, sorted present_characters)`.
But that cache key then became its own failure mode (C).

**v3 rule:** any LLM extraction that participates in a gate must be cached with
an explicit key, and the key must be stable against irrelevant metadata.

### C. Metadata drift invalidating the cache

With prose unchanged, the writer's `present_characters` list grew 4 → 5 → 6
names across candidates. Each change invalidated the audit cache, produced fresh
audit references, and generated new findings — a loop with no fixed point until
the engine was taught to allow exactly one presence correction and then freeze it.

**v3 rule:** derive presence from the prose deterministically, or treat it as
part of the draft (changing it means a new draft), never as free-floating
metadata that silently re-keys a cache.

### D. Aggregation boundaries in repair feedback

Repeated pattern: findings were reported per-claim, the writer acted per-claim,
and the repository's integrity constraints are per-entity.

- Five separate claims all naming active fact 53 → writer wrote
  `supersedes_fact_id: 53` five times → single-successor constraint rejected all
  of it. Needed grouping by conflicting fact id.
- Same-patch temporal conflicts on one `(subject, predicate)` slot were reported
  pairwise → writer merged some and kept others → overlap survived. Needed
  grouping by slot.

**v3 rule:** feedback is aggregated to the granularity at which the fix must be
made, which is the entity, not the individual finding.

### E. Findings masking other findings

A non-structural outline-parent reference error short-circuited the epistemic,
temporal, contract and semantic validators, so the repair fixed the trivial
error while two epistemic errors stayed hidden until the next round
(`cli-8k-20260724-b`).

**v3 rule:** only genuinely malformed input may short-circuit later checks.
Everything else runs and reports together, so one repair round sees the whole
problem.

### F. Exact-identity string fragility

Repair requirements keyed on exact identity strings broke on character-level
quote drift: the writer retained the fact and its grant but re-typed the
identity with a different quote character, producing an audit collision. Late
prose revision then ran out of repair budget.

**v3 rule:** identity is a content digest over normalised text, never a raw
string the model has to reproduce byte-for-byte.

### G. In-flight calls and fail-closed accounting

An interrupted process leaves reserved call rows; the strict recorder then
refuses every subsequent call, and there is no protocol to settle them. On the
DOME side the same situation is modelled as `AmbiguousInFlightCall`, but the
StoryOS recorder has no equivalent terminal state or safe replay path. Two
manual archive-and-restart interventions were needed.

**v3 rule:** define an explicit ambiguous-in-flight terminal state with a
documented settle/replay procedure before any long run.

### H. Environmental
Root filesystem hit 100% mid-batch and three cells died with `OSError`,
invalidating a paired round. The response — a preflight requiring ≥3 GB free and
an abort below 1 GB — is worth keeping.

## What is worth reusing

- **The preregistration discipline.** Fresh run identities per iteration, no
  splicing of partial rounds, a byte-identical source-lock reconstruction, and
  frozen-config digests on every run. This is the part of the remote work that
  was genuinely rigorous and v3 should inherit it wholesale.
- **The 3M token / 20k writer-cap configuration**, which is what made 14/19
  completions possible locally.
- **The deterministic 1020 → 1764 task substitution** for the content-filter
  deadlock, with its authorisation trail.
- **`~/storyos-data/scores/`** on sgp-dev: seven scored baseline systems, which
  match the local numbers.

## What is not worth reusing

The engine diffs themselves. They are patches to `orchestrator.py`,
`verifier.py` and `audit.py` in an architecture where canonical state lives in
SQLite tables and the engine rewrites the writer's patch — the two decisions v3
explicitly reverses (`02-architecture.md` §3, and rule A above).
