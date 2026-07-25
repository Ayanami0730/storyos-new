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
| raw-gpt-5.6-sol | 1.200 | 10,321 |
| raw-gpt-5.5 | 1.202 | 12,201 |
| raw-gemini-3.1-pro | 3.964 | 10,480 |
| bare-long-context | 4.100 | 11,060 |
| storywriter-style | 5.055 | 14,824 |
| agentwrite | 6.155 | 15,065 |
| agents-room-style | 6.610 | 14,098 |

Read together, these two tables suggest a **length–consistency Pareto front**:
raw frontier models are the most consistent thing we measured and cannot reach
novel length at all, while everything that reaches novel length is a
decomposition harness with markedly worse consistency.

**This reading is provisional.** The harness CED rows are inflated by
unfaithfulness in our own adapters (see `04-results.md` §0), so the size of the
consistency gap — and possibly its direction — will change once the adapters are
restored and re-run. The length column is unaffected: nobody weakened the raw
models, and their 11–22% attainment is a clean result.

### The claimed cause — corrected 2026-07-25 after a code audit

The first formulation of this claim was **falsified by our own audit** and must
not be used. We had written that "each component only receives whatever its
upstream stage hardcoded into its prompt, and no component can query the full
state on demand". Three systems are direct counter-examples:

- **AgentWrite** passes the accumulated full text into every writing step
  (`LongWriter@447539b:agentwrite/write.py:56-84`).
- **Agents' Room** defines every agent as reading the *complete* shared
  scratchpad, then appending to it (paper §3, Algorithm 1).
- **WriteHERE** hands each call `memory.article` (all prose so far),
  `node.get_all_layer_plan()` (the global plan) and the dependency closure
  (`recursive/agent/agents/regular.py:98-114`).

But the counter-examples do **not** rescue those systems, because what they pass
around is not the full context — it is context that has already been compressed
so that it *can* be passed around. A shared scratchpad is bounded by design: to
stay inside every agent's prompt it must be aggressively condensed, and the
details lost in that condensation are exactly the ones consistency depends on.
The same is true of a rolling `memory.md`, a 500-word summary, or a top-k
retrieval result. Every one of these is a mechanism for *making context small
enough to hand over*, and every hand-over is lossy.

So the claim, stated correctly:

> Existing long-form writing systems fail in one of two ways: either a component
> simply cannot obtain the context it needs, or — in order to keep context
> passable between components — the system compresses at every step, so that
> **every component receives lossy context**. Rolling summaries, shared
> scratchpads, top-k memories and dependency-scoped views are all instances of
> the same compromise. StoryOS removes the compromise: a unified filesystem
> index with no capacity ceiling, from which every agent can retrieve **lossless**
> context on demand, at the granularity its current task requires.

> 中文表述：现有系统要么某些组件拿不到它需要的上下文，要么为了让上下文能在组件之间传递
> 而在每一步都做压缩，于是所有组件收到的都是有损上下文。我们通过一个没有容量上限的统一
> 文件索引，让所有组件都能按需取到无损上下文。

Two corollaries. First, seeing all the prose is still not the same as having
queryable state: none of these systems lets a component ask "what does this
character know as of scene 12" or "which promises are still open" and get typed
records back with source spans. Second, the word "root cause" is not supported by
existing evidence — ablations show context flow is causally linked to quality
(RecurrentGPT loses coherence without its memories; DOME's conflict rate rises
from 0.56 to 4.52 without MEM; StoryWriter's summary window beats discarding
history), but nobody has run the controlled experiment that isolates
canonical-state access. Say **a shared structural bottleneck**, not *the* root
cause — until our own ablation says otherwise.

Why a filesystem is what makes "no capacity ceiling" real: prompt-resident state
is bounded by the window, a database row set is bounded by whatever query the
component was allowed to run, but a directory tree has no size limit and an agent
with `grep`/`read` can descend to any depth on demand. The index can hold every
scene's full prose, every relation phase, and every promise with provenance, and
a component pays only for what it actually asks for.

The concrete gaps that remain true across systems:

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

**Status: unproven.** v2 does not demonstrate it (CED 4.690 vs bare 4.100). The
claim stands or falls on v3 measurements.

## Novelty 2 — For story state, a free-form filesystem index beats graphs and tables

The human's original framing, which v2 lost:

> A directory is the character-relationship index. Compared with a graph, a
> graph can only record one relation between two people, but what happens
> between two people in a story is *temporal*: they may pass through many
> relations — strangers, master and student, lovers, enemies, then lovers again,
> then friends. A graph struggles to represent that; a free-form index can.

### Corrected 2026-07-25: the first formulation is falsified by NWM

We had written that a graph "can only record one relation between two people".
**That is false for NWM** (`survey/notes/nwm-2607.05577.md`). Its typed records
include a `Relationship state` with fields `character pair, relation type,
polarity/status, validity`, and every temporal-KG edge stores `source chapter,
evidence, validity interval, confidence` — facts still holding are open
intervals, superseded facts are closed intervals, **and old edges are retained as
history**. So "strangers → mentor → lovers → enemies → lovers again" is
expressible: one edge per phase, each with its own interval, all kept. DOME's
`<subject, action, object, chapter>` quadruple genuinely cannot do this; NWM can.

Two further findings from the same paper that constrain what we may claim:

- Their ablation shows **typed labels are not what wins**. Same store, same
  reader, same 12k-character budget: query-conditioned retrieval scores 0.898
  while serialising the whole typed store scores 0.358 (83% of misses are "the
  fact is in the store but got positionally truncated"). The paper attributes the
  win to narratological decomposition plus query-conditioned retrieval, *not* to
  type labels, graph size, or the extractor.
- Dumping all prior prose (~80k tokens) scores **0.852**, *below* the bounded 12k
  packet's 0.898. So "give the agent more context" is not the mechanism; **"put
  the right thing in front of it" is.** Any framing of novelty 1 that sounds like
  "more context is better" is contradicted by this.

### What survives, stated narrowly

The claim is not about *sequence* — it is about **what each transition contains**.
NWM stores one typed label per interval (`relation_type: mentor_student`). It has
no place for *why* the transition happened or *how* it progressed: that the
discipleship began by bowing to the wrong master, that affection went through
tentative liking, then mutual dependence, then love. A typed label discards the
causal texture; an `evidence span` can only *point back at* prose, which means
recovering the texture requires re-reading the source — precisely what a memory
system exists to avoid. And because **every NWM record is chapter-scoped**,
within-chapter progression is flattened, while relationship change is usually
exactly where sub-chapter ordering matters.

So, for the paper: **narrative state must carry the dense, time-indexed,
free-text texture of how each relation changed, not merely a typed label per
interval, because continuing a story requires knowing how the characters got here
and what is still unsettled — not only what they currently are.** A free-form
file per entity pair, with ordered phases carrying prose and provenance to a
scene span, holds this; a typed edge does not.

**Status: this is an argument, not evidence.** It becomes testable the way NWM
itself tested representation (176 multi-hop narratological QA items, Graph
Retrieval 0.898 vs Graphiti 0.574): build probes that ask about *transition
causes* and *within-chapter progression*, and compare a typed-graph store against
a free-form index on the same questions. Cheap — no generation needed — and it
attacks NWM on its own methodological ground. Until that runs, this claim must be
labelled as a design argument.

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
