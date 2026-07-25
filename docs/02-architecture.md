# StoryOS v3 architecture

Design of record. Anything contradicting this file needs an explicit decision,
not a silent drift. Rationale and citations live in
`../../research/2026-07/25-storyos-v3-harness-design-research.md`.

## 1. Shape of the system

Five agents, all resident, in one Node process. The orchestrator owns the
process and calls the other four as **native function-calling tools**; each
callee keeps its own persistent session so its context accumulates across
invocations rather than being rebuilt each time. Delegation depth is fixed at
**1** — specialists never spawn specialists.

```
                         premise
                            │
                    ┌───────▼────────┐
                    │  orchestrator  │  resident; owns task DAG, budget,
                    └───┬───┬───┬───┬┘  transactions, retry/abort
     call_index_manager │   │   │   │ call_verifier
        call_context_builder │   │ call_writer
                        │   │   │   │
   ┌────────────────┐   │   │   │   │   ┌──────────────┐
   │ index-manager  │◄──┘   │   │   └──►│   verifier   │
   │ sole committer │       │   │       │ findings only│
   └───────┬────────┘       │   │       └──────┬───────┘
           │        ┌───────▼─┐ │              │
           │        │ context │ │◄─── writer asks follow-ups (≤3)
           │        │ builder │ │              │
           │        └────┬────┘ │              │
           │             │  ┌───▼────┐         │
           │             └─►│ writer │◄────────┘ findings (≤5 rounds)
           │                └───┬────┘
           │                    │ staged draft + proposed state delta
           ▼                    ▼
   ┌──────────────────────────────────────────────┐
   │  canonical filesystem index  (read: all)     │
   │  write: index-manager only, via atomic commit│
   └──────────────────────────────────────────────┘
```

Every agent has the **same read reach** over the index — none is a second-class
citizen with a narrower view. What differs is write authority.

## 2. Tools

Split by mutation, not by role:

**Free-form reads — every agent gets these.** A single `run_command` executing
inside the sandbox gives `grep`, `ls`, `find`, `sed`, `head`, `wc`, `cat` and
composition for free. This is deliberately not a hand-designed read tool per
partition: agents already know shell, and a shell adapts to index layouts we have
not thought of yet. pi also ships `read`/`grep`/`find`/`ls` as typed tools; keep
them enabled as ergonomic shortcuts, but `run_command` is the general capability.

**Typed mutations — schema-validated, role-restricted.**

| Tool | Who | Effect |
|---|---|---|
| `build_context_packet` | context-builder | writes `staging/<txid>/context-packet.json` + coverage report |
| `write_staged_scene` | writer | writes `staging/<txid>/scene-draft.md` |
| `propose_state_delta` | writer | writes `staging/<txid>/proposed-state-delta.json` |
| `write_findings` | verifier | appends `staging/<txid>/validation-findings.jsonl` |
| `apply_state_delta` / `commit_transaction` | index-manager | the only path into canonical state |
| `open_transaction` / `abort_transaction` / `request_commit` | orchestrator | control plane; no file writes |

Rule: if an operation changes canonical state it must be a typed tool with schema
validation and provenance. If it only reads, let the shell do it.

## 3. Canonical state is the filesystem

SQLite is a **derived projection**, rebuildable from files at any time. This
inverts v2 and is required by novelty 2: an entity pair must be able to carry an
ordered sequence of overlapping, revisable relations, which rigid triples flatten.

```
story-project/
├── HARNESS.md                     # system contract, human-maintained
├── config/{project,models,budgets,policies}.yaml
├── agents/<agent>/
│   ├── AGENT.md                   # system prompt + tool allowlist
│   └── memory/
│       ├── MEMORY.md              # INDEX only: "- [Title](topic.md) — hook"
│       └── <topic>.md             # full memories, read on demand
├── skills/<skill>/SKILL.md        # procedure only, never story state
├── index/
│   ├── manifest.yaml
│   ├── _schemas/*.schema.json
│   ├── project/{brief.md,constraints.yaml,decisions.jsonl,glossary.yaml}
│   ├── plan/{task-graph.jsonl,milestones.yaml,pass-plan.yaml,budgets.json}
│   └── story/
│       ├── premise.md, logline.md, synopsis/{paragraph,long}.md
│       ├── structure/
│       │   ├── framework.yaml     # kishotenketsu | save-the-cat | 3-act | ...
│       │   ├── beats.yaml, arcs.yaml, chapters.yaml
│       │   ├── scenes/<scene-id>.yaml
│       │   └── tension-{target,actual}.csv
│       ├── bible/
│       │   ├── characters/<id>.yaml, locations/<id>.yaml
│       │   ├── factions/<id>.yaml, objects/<id>.yaml
│       │   ├── world-rules.yaml, terminology.yaml
│       │   └── relations/<pair-id>.yaml     # ← novelty 2 lives here
│       ├── continuity/
│       │   ├── canon-facts.jsonl, timeline-events.jsonl
│       │   ├── character-state.jsonl, beliefs/<char-id>.jsonl
│       │   ├── plot-contracts.jsonl, open-loops.yaml, retcons.jsonl
│       └── revision/{findings.jsonl,pass-status.yaml,style-sheet.yaml}
├── manuscript/parts/<part>/chapters/<ch>/scenes/<scene>.md
├── staging/<txid>/{intent,context-packet,scene-draft,proposed-state-delta,validation-findings,status}
└── runtime/
    ├── events.jsonl               # append-only truth
    ├── ledger.jsonl               # per-call tokens/cost/latency roll-up
    ├── projection.sqlite          # DERIVED; rebuildable from index/
    ├── transcripts/<agent>/<run-id>.jsonl
    └── artifacts/<artifact-id>/   # evicted tool payloads, re-fetchable
```

### The relation record — where novelty 2 becomes concrete

`bible/relations/<pair-id>.yaml` holds an ordered list of intervals, not one edge:

```yaml
pair_id: mira--warden
participants: [char-mira, char-warden]
phases:
  - {from_scene: s-001, to_scene: s-004, relation: strangers,
     asymmetry: null, source: {scene: s-001, span: "L12-L18"}}
  - {from_scene: s-005, to_scene: s-011, relation: mentor_student,
     asymmetry: "warden mentors mira; mira suspects nothing",
     source: {scene: s-005, span: "L44-L60"}}
  - {from_scene: s-012, to_scene: null, relation: enemies,
     supersedes_phase: 2, reason: "betrayal revealed",
     source: {scene: s-012, span: "L88-L96"}}
open_questions: ["does mira learn warden's real faction?"]
```

Three properties no fixed-schema edge gives us: phases are ordered and may be
revised in place with `supersedes_phase`; a phase can be asymmetric (A's view of
B ≠ B's view of A) in free text; every phase carries provenance to a scene span.

## 4. Scene as an atomic transaction

```
OPEN
 → CONTEXT_BUILT            context-builder emits packet + coverage
 → DRAFTED                  writer may ask context-builder ≤3 follow-ups
 → STATE_DELTA_PROPOSED
 → VALIDATING               verifier: deterministic first, then LLM tracks
     → REPAIR_REQUIRED → DRAFTED    (≤5 rounds; ≤1 context-builder query each)
     → REJECTED
     → APPROVED
 → COMMITTING
     → STALE_BASE → CONTEXT_BUILT   (base_commit_id moved under us)
     → COMMITTED
```

`APPROVED` is the verifier's opinion. Only index-manager produces `COMMITTED`,
and prose plus state delta land in one commit or neither does. Verification order
runs cheapest-and-most-certain first: schema/reference integrity → time, space,
object, visibility, hard world rules → promise-payoff and scene contract → LLM
judgement on motivation, causality, pacing, prose.

Coverage discipline, learnt the hard way from v2: extraction is **not** capped at
a handful of claims per scene. Coverage scales with scene length, and the
coverage→CED relationship is measured, not assumed.

## 5. Context management

Three budgets kept separate: runtime conversation, task context packet, output
reserve. With window `W` and `E = W - min(maxOutput, 20k)`:

- **Level 1 at `0.70·E`** — clear re-fetchable tool payloads. Keep
  `tool_call_id`, tool name, input hash, artifact path and a one-line digest;
  move the payload to `runtime/artifacts/`. Keep the last 8–12 tool results
  verbatim. Never touch memory, canon, transaction records or user messages.
- **Level 2 at `E - 13k`** — structured summary of older history while keeping a
  verbatim recent tail (10k–40k, never splitting a tool_use/tool_result pair).
  The summary records `covered_event_ids`, source transcript, model and time, and
  enters only the LLM view — never canonical state.
- **Hard block at `E - 3k`** — no new turn; compact, checkpoint or fail.

Percentages are configurable; those defaults derive from Claude Code's measured
buffers. Context packets target 40–70k (default 60k) regardless of how large the
window is: scene card 2–4k, predecessor prose verbatim 4–10k, chapter/arc summary
2–6k, relevant canon/state/beliefs 10–20k, open promises and reveal limits 4–8k,
style exemplars 4–8k, provenance overhead 2–4k.

Packet assembly is priority-ordered, not top-k similarity: P0 hard constraints
(scene card, world rules, reveal limits, base revision) → P1 present entities'
state/beliefs → P2 direct dependencies (previous scene, triggered contracts) →
P3 remote recall → P4 optional background. **P0/P1 can never be displaced by
similarity ranking, and a missing hard-required id fails the build** rather than
letting the writer infer.

## 6. Memory and skills

`MEMORY.md` is an index: first 200 lines, 25KB cap, one pointer per line. Full
memories are topic files the agent greps and reads on demand. Agent memory stores
only "how this role works better" — verifier calibration against a known false
positive, writer style feedback already approved. **Story state never goes in
memory or skills**; it goes in the index. Each memory topic carries `source`,
`last_verified_at`, `scope` and optional `expires_at` so stale lessons expire.

Skills follow the SKILL.md spec: frontmatter `name` + `description` loaded at
startup (~100 tokens), full body only on invocation, `references/` and `scripts/`
on demand. First set: `project-intake`, `story-architecture`,
`scene-card-planning`, `scene-drafting`, `canon-extraction`, `continuity-audit`,
`belief-boundary-audit`, `promise-payoff-audit`, `structural-revision`,
`character-revision`, `prose-revision`, `copyedit`. A skill never escalates tool
permissions.

## 7. Sandbox backends

Isolation here is not about defending against malicious agents; it makes the
gated write path **OS-enforced rather than prompt-enforced**, which is a
materially stronger guarantee than instructing a model not to write.

| Backend | Use | Write gate mechanism |
|---|---|---|
| `local` | development, unit tests | confined cwd; canonical files read-only except inside index-manager's commit section |
| `docker` | sgp-dev, production | canonical index bind-mounted read-only into every agent except index-manager; staging read-write |
| `e2b` | burst parallelism, or when local disk is exhausted | fresh 10 GiB per sandbox; same mount discipline |

Critical constraint on the e2b path: **the agent loop stays outside the
sandbox.** Each `run_command` enters, runs for seconds, returns. The Hobby tier's
1-hour continuous-runtime cap therefore never applies, and we are not paying
per-second for a VM that is idle waiting on gateway latency. Sandbox state
persists via the project directory, synced or mounted, so a sandbox is
disposable.

## 8. Trace, cost and reproducibility

pi already attaches to every assistant message: `usage {input, output, cacheRead,
cacheWrite, reasoning, totalTokens, cost{...}}`, `timestamp`, `model`,
`responseModel`, `responseId`, `stopReason` — persisted in JSONL sessions with
fork/resume. On top we add `runtime/ledger.jsonl`, a story-level roll-up per
agent and per phase: tokens, cost, wall time, tool call counts, retries, gate
outcomes.

**A run is not complete unless its trace, cost and timing ledger are on disk.**
Every commit records `base_commit_id`, the config digest and the engine source
digest, so a result can always be tied to the exact code and configuration that
produced it.

## 9. Known risks carried forward

Write contention between agents on different base revisions (mitigated by
single-writer plus `base_commit_id` plus staging); summaries mistaken for facts
(summaries may only navigate; canon needs source span and commit id); prose and
state committing separately (same transaction, or neither); verifier editing prose
(it writes findings only); LLM verifier sharing the generator's blind spots
(deterministic checks first, cross-family judge for soft quality); repair livelock
(bounded rounds, log unchanged findings, then abort or escalate); over-structuring
killing the writing (hard canon vs soft plan vs aesthetic target are different
tiers, and the writer may propose a deviation or retcon); tension metrics being
reward-hacked (bands and trends only, never a commit gate).
