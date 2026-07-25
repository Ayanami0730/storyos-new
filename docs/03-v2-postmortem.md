# v2 postmortem — what to not repeat

v2 lives in the `storyos` repo (`src/engine/`, `src/storyos/`). It works, it
produces novels, and its numbers say the architecture is at its ceiling. Written
2026-07-25 from measured runs, not from impressions.

## The numbers

ConStory tuning-20, gpt-5-mini backbone, gpt-5.5 checker, CED lower is better:

| System | CED ↓ | words | completed |
|---|---:|---:|---:|
| raw-gpt-5.6-sol | 1.20 | 10,321 | 20/20 |
| raw-gpt-5.5 | 1.20 | 12,201 | 20/20 |
| raw-gemini-3.1-pro | 3.96 | 10,480 | 20/20 |
| **bare-long-context** | **4.10** | 11,060 | 20/20 |
| **storyos-index (v2)** | **4.69** | 9,326 | **14/19** |
| storywriter-style | 5.06 | 14,824 | 20/20 |
| agentwrite | 6.15 | 15,065 | 20/20 |
| agents-room-style | 6.61 | 14,098 | 20/20 |
| dome | not scored | 10,504 | 4/20 |

v2's own category breakdown: `timeline_plot_logic` 1.92, `factual_detail` 1.38,
`narrative_style` 0.92, `characterization` 0.23, `world_building` 0.23. By task
type: Continuation 6.17 worst, Expansion 3.59 best. Per-task CED ranges from 0.00
to 8.79, so variance is large and n=14 is small.

Two caveats that must travel with these numbers: the raw frontier models are a
different backbone, so 1.20 is not a controlled comparison; and v2's five failed
tasks are excluded from its mean, which biases it optimistically if the failures
were the harder items.

Gate process evidence across the same 19 tasks: **154 scene drafts committed,
279 rejected** (first-pass acceptance 35.6%), with findings distributed as
epistemic 363, semantic-fatal 198, audit 46, contract 17, schema 14, temporal 2.

## Root cause 1 — the gate inspects a sample, the metric reads everything

The audit extractor is hard-capped at **5 claims, 5 entity states, and 3
knowledge uses per scene**, enforced in both the prompt
(`src/storyos/prompts/audit_extract.md:19`) and the validator
(`src/storyos/audit.py:567-586`). A scene is ~1,500 words. So most of the prose's
factual content never enters extraction, never reaches the semantic track, and
never gets gated.

The consequence is precise: the gate provably protects *declared typed state*,
while CED measures *prose across the whole 9.3k-word manuscript*. 279 rejections
and a large repair bill bought state-layer correctness that the metric does not
read. Meanwhile a single long generation with no gate at all (bare, 11k words)
scores better, plausibly because it has no scene seams to be inconsistent across.

Either raise coverage (drop the caps, scale with scene length, pay the cost) or
add a prose-level pre-commit check — and measure the coverage→CED curve rather
than assuming.

## Root cause 2 — the architecture never matched the design

Verified by reading the code:

- **No resident agents.** Each scene is a one-shot call chain (writer once, audit
  once, semantic once); context is rebuilt from a repository snapshot every time.
  The orchestrator has no persistent context, and the writer cannot ask the
  context builder a follow-up question.
- **Context builder and index manager are not agents.** They are deterministic
  Python: the builder sorts index entries by a fixed priority and truncates to a
  word budget (`src/engine/context.py:20-176`); the index manager materialises
  files (`src/engine/index.py`). The design called for a builder that searches
  and greps the index for the current task.
- **No memory, no skills.** `agents/<role>/memory.md` is created empty at
  initialisation and never written again. There is no skills mechanism.
- **The real write gate is not where the figure says.** `CommitCoordinator` plus
  `StoryRepository.commit_scene()` perform writes; index-manager only owns the
  materialised projection.
- **Gate order is audit → deterministic validators → semantic → quality**, not
  the fast-first order the figure implies.
- **No tool schema at all.** Requests carry only `model`, `messages`,
  `max_completion_tokens`; "tools" are plain chat completions parsed by a local
  JSON parser. This was a choice, not a platform limit — native function calling
  works on our gateway (`FOUNDATION.md`).
- **The semantic threshold 0.8 changes only a severity label**, not control flow;
  both `error` and `fatal` block commit identically.
- **Canonical state went into SQLite tables**, which is what destroyed novelty 2.

## Root cause 3 — the metric-facing components were never tuned against the metric

Remote codex produced 12 further engine commits and 97 runs, all validated by
"does the gate pass / does the task complete" — and **never computed CED once**.
Local v2 development had the same blind spot until this postmortem. Optimising
completion rate is not optimising quality; the two came apart here.

## Things v2 got right and v3 should keep

- Scene as an atomic transaction with staged proposal, independent validation and
  atomic promotion. The semantics are sound even though the gate's coverage was
  not.
- Fail-closed accounting: per-task token budgets, call reservations, and refusing
  to resume an ambiguous in-flight call rather than risking a double charge.
- Rejected drafts archived with findings and traces, so the process is auditable.
- Deterministic validator families (schema, temporal, epistemic, contract) as a
  cheap first pass before any LLM judgement.
- Preregistration discipline: frozen tuning/report splits with zero intersection,
  deterministic task substitution when a task hits an upstream content filter,
  and a paired-bootstrap unlock gate before touching the report set.

## The one bug worth remembering

Two SIGTERMs killed the DOME runner mid-call; its fail-closed design then marked
19 checkpoints terminal (`AmbiguousInFlightCall`, "replay is forbidden") and
refused to resume, which is correct but leaves no escape hatch. The recovery was
to archive the poisoned checkpoints with evidence and restart clean — and to move
every multi-hour job into tmux so a terminal's lifecycle can never kill it again.
v3 needs a documented ambiguous-in-flight resolution protocol from day one.
