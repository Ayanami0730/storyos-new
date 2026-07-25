# What StoryOS claims

Three contributions. The first two are the intellectual core; the third is an
artefact contribution. The v2 framing ("we add a validation gate before commit")
is retired — it is an engineering hygiene claim, it has no aesthetic, and our own
measurements do not support it as a quality mechanism (`docs/03-v2-postmortem.md`).

## Novelty 1 — Long-form harnesses fail because context does not flow between components

### The empirical setup

Measured on FreshNovelBench subset-10, 40k-word targets, gpt-5-mini backbone
except where the model is the system:

| System | mean words | target attainment | note |
|---|---:|---:|---|
| storywriter-style | 69,140 | 172.8% | chunked harness |
| agentwrite | 67,041 | 167.6% | chunked harness |
| agents-room-style | 62,834 | 157.1% | chunked harness |
| bare-long-context | 40,485 | 101.2% | multi-call continuation |
| raw-gpt-5.6-sol | 8,690 | **21.7%** | single frontier model |
| raw-gpt-5.5 | 8,389 | **21.0%** | single frontier model |
| raw-gemini-3.1-pro | 4,395 | **11.0%** | single frontier model |

And on ConStory tuning-20 (8–10k targets), where CED is consistency errors per
10k words and lower is better:

| System | CED ↓ | mean words |
|---|---:|---:|
| raw-gpt-5.6-sol | 1.20 | 10,321 |
| raw-gpt-5.5 | 1.20 | 12,201 |
| raw-gemini-3.1-pro | 3.96 | 10,480 |
| bare-long-context | 4.10 | 11,060 |
| storywriter-style | 5.06 | 14,824 |
| agentwrite | 6.15 | 15,065 |
| agents-room-style | 6.61 | 14,098 |

Read together, these two tables are a **length–consistency Pareto front**. Raw
frontier models are the most consistent thing we measured and cannot reach novel
length at all. Every system that reaches novel length is a decomposition harness,
and every decomposition harness is markedly less consistent. Nobody currently
gets both.

### The claimed cause

Not context *capacity* — a 1M-token window holds a 40k-word novel comfortably.
The cause is that in existing harnesses **each component only receives whatever
its upstream stage hardcoded into its prompt**, and no component can query the
full state on demand. So some stage always lacks context it needed:

- the writer of chapter *N* sees a lossy summary of chapters 1..*N*−1, not the
  prose, so it cannot check a detail it half-remembers;
- the critic/verifier, when one exists, sees the draft but not the character
  state or the open promises it would need to judge consistency;
- facts established during writing cannot flow back into the outline or the
  character sheets, because there is no write path from prose back to plan;
- components hold private copies of overlapping state that silently diverge.

Per-system evidence with file and line citations is in
`../../research/2026-07/25-baseline-context-flow-audit.md`. That audit is the
backbone of this claim and must be complete before the claim is published: the
argument is only as strong as its weakest system, and a reviewer who has read
one of these papers will check.

### The claimed remedy

One unified index that every agent can query on demand, so context reaches
whichever component needs it rather than only whichever component the pipeline
author anticipated. Under that design, long-form writing should hold quality
instead of degrading with length.

**Status: unproven.** v2 does not demonstrate it (CED 4.69 vs bare 4.10). The
claim stands or falls on v3 measurements.

## Novelty 2 — For story state, a free-form filesystem index beats graphs and tables

The human's original framing, which v2 lost:

> A directory is the character-relationship index. Compared with a graph, a
> graph can only record one relation between two people, but what happens
> between two people in a story is *temporal*: they may pass through many
> relations — strangers, master and student, lovers, enemies, then lovers again,
> then friends. A graph struggles to represent that; a free-form index can.

Condensed for the paper: **relations between story entities are dense and
change over time, so narrative state needs a representation where an entity pair
can carry an ordered sequence of overlapping, revisable relations with
provenance.** Rigid triples and fixed-schema tables flatten exactly the
structure that matters. Related work has converged on graphs and typed tables
(FactTrack, EvolvingWorld, NWM, MAGNET, and DOME's
`<subject, action, object, chapter>` quadruples), which is where the
counter-example bites: that quadruple cannot express "was her mentor during
chapters 3–11, became her enemy in 12, and is her lover again by 20" without
either losing the ordering or exploding into rows that no longer read as one
relationship.

A filesystem index also buys three practical properties a database does not:
agents query it with native `grep`/`read` and no bespoke API; humans can audit
and diff it; provenance is a first-class artefact rather than a column.

Cost, stated honestly: atomic commits must span files and the derived index, so
the commit path needs staging plus fsync plus rename plus index rebuild, and
crash recovery rebuilds the index from files.

## Novelty 3 — FreshNovelBench

Fifty frozen novel-length tasks built from novels published **after** the
registered model cutoff, so no source text can sit in an evaluated model's
training data. Construction: a human-audited pool of 60 post-cutoff novels →
deterministic freeze to 50 (standalone first, latest date, balanced across 7
genres) → a two-probe contamination gate (title/author recall, blind premise
recognition) that routes leaked books to deterministic replacement from a probed
reserve → task synthesis into premise, expected conflict, required elements and
characters with 40k/60k/80k-word targets → final freeze with human spot-checks.

Naming note: "NovelBench" is already taken twice (an LLM creativity arena and a
text-to-image benchmark from the RAVEL paper), hence FreshNovelBench. Code paths
and Mongo collections still say `novelbench`; only the paper name changed.

## What is deliberately no longer claimed

The "gated write path / atomic promotion / Narrative CI" machinery is
*infrastructure*, not a contribution. It stays because the transaction semantics
are genuinely useful, and its process evidence (154 commits vs 279 rejections,
epistemic violations intercepted 363 times) is worth one honest paragraph — but
it does not go in the abstract, and it is not what the figures argue.
