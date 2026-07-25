# Open threads — what is unfinished, in priority order

Snapshot 2026-07-25 12:50. Anything not listed here is either done (see
`04-results.md`) or explicitly out of scope. Work in this order; items 1 and 2
gate everything else.

## 1. Restore baseline adapter faithfulness, then re-run and re-score

**Why it blocks everything:** three of our adapters are weakened relative to the
official implementations, always in the direction that flatters us, so no
cross-system comparison currently means anything. Details and code citations in
`04-results.md` §0.

Per-adapter fix (all in `storyos/src/baselines/`):

| Adapter | Missing | Fix | Official reference |
|---|---|---|---|
| `agentwrite` | accumulated full text | pass all prose written so far into every section prompt | `LongWriter@447539b:agentwrite/write.py:56-84` |
| `agents_room` | full shared scratchpad | pass the complete scratchpad (planning blocks + prose), not chapter titles | paper §3, Algorithm 1 |
| `recurrentgpt` | previous paragraph + long-term top-k | restore both; needs a real embedding store for top-k | official loop |
| `dome` | `last_chapter_story` | add it to the writer prompt | official DHO writer prompt |

Suggested parallelisation — four concurrent subagents, one adapter each, because
they touch disjoint code paths and disjoint output directories:

- each agent: fix its adapter, write a unit test that asserts the prompt now
  contains the previously-missing material, run **one** smoke cell, then run its
  20 tuning cells into a *new* output root (do not overwrite the old runs — the
  old numbers must stay reproducible as the "unfaithful" baseline for the record)
- a fifth serial step afterwards: re-score all four with the frozen `gpt-5.5`
  checker and re-derive the table

Resource discipline: gateway concurrency is the bottleneck, so cap each agent at
≤3 workers, and stagger starts. Every run must carry the config digest and engine
source digest so old and new numbers can never be silently mixed.

**Report both tables in the paper.** The delta between unfaithful and faithful
reproduction is itself a useful methodological result, and disclosing it is
cheaper than being caught by a reviewer who reads our adapters.

## 2. The motivation experiment and its figure

The teaser must be driven by our own measured curves, not by a schematic. Design:

- **Two systems only**: the strongest bare frontier model, and one respected
  story harness (StoryWriter is the natural pick; substitute whichever we can
  reproduce most faithfully after item 1).
- **One premise, several detail levels** — the premise is held fixed while the
  amount of supplied detail varies, so we can separate "not enough input" from
  "cannot hold long output together".
- **Target length sweep**: 5k → 10k → 15k → … → 60k words.
- **Two line charts, two lines each** (one line per system):
  - left/lower chart: **quality score declines** with target length
  - right/upper chart: **factual/consistency errors rise** with target length
- Report actual words alongside target words — at the top of the sweep neither
  system will hit target, and that gap is part of the finding.

Then the teaser: feed **the rendered result charts** into gpt-image-2 as reference
images, together with the bottom panel showing our unified-index lossless-context
contribution, and regenerate the figure so its top half is real data and its
bottom half is the mechanism. Do not hand-draw a fake curve.

Prerequisite: the degradation pilot already covers 3k–24k with N=20 and found
r = 0.405 (p = 0.076) for raw error count and a slightly negative CED trend, so
the sweep must go much further out (to 60k) and use per-tier quality scoring, not
just CED, or it will reproduce the same non-significant result.

## 3. Ablations, none of which have been run

Gate on/off; bounded-working-set size; repair budget k ∈ {0,1,2,4}; audit track
off; semantic track off; typed patch vs free text; versioning off. Plus the
registered injected-error study (3 error classes × 10 instances × 4 modes,
measuring detection / interception / repair / rejection / escape).

The single most important one for v3 is new: **extraction coverage → CED**. v2
capped audit extraction at 5 claims / 3 knowledge uses per scene, which is why its
gate protected declared state while the metric read prose. Sweep coverage and
measure whether the gate can pay for itself.

## 4. Engine v3 Phase 1

Transaction kernel per `02-architecture.md` §4, then context packets with coverage
reports, then novel-domain schemas, then persistent multi-agent. The pi foundation
is validated (`FOUNDATION.md`); nothing else is written yet.

Sandbox decision is now settled by measurement: use the **company E2B service**
(`api.agent-vpc.infra` + private CA, 60ms creation, OSS-backed persistence,
pause/resume, `story` mount type already exists). Implement `SandboxBackend` with
`local` for development and `company-e2b` for runs; e2b.dev is not needed.

## 5. Remote engine work to merge

`storyos` remote `codex-run` is at `2a30793`, **23 commits ahead of local main and
12 ahead of the integration worktree** at `689d2e0`. Those 12 include typed
`repair_supersession_requirements`, epistemic preflight on repair, temporal
grouping, immutable-repair carry-over across restarts, action promotion, and
`present_characters` stabilisation, plus the frozen config that produced our
14/19 (3M token budget, 20k writer cap) and the preregistered 1020→1764
substitution. Integration worktree passes 65/65 engine tests. Conflict surface is
four files (`orchestrator.py`, `verifier.py` and their tests) plus a mandatory
rebuild of `v2-source-lock.json` and the frozen config hash afterwards.

Nobody has ever computed CED for the remote engine either — its 12 commits were
validated only by "does the gate pass / does the task complete".

## 6. Paper debt

Four `[[需核实]]` markers in `method-draft-en.md` are all still true: some index
partitions have no production path, `present_characters` never reaches
`ContextBuilder`, the 0.5/0.8 semantic thresholds are uncalibrated, and only
audit extraction is idempotent (not the whole gate decision). The main figure also
still misstates the gate order, draws deterministic modules as agents, attributes
the write path to index-manager instead of `CommitCoordinator`, and shows a
`memory` cluster and `names+relations` card that do not exist. Fix the code or fix
the claim; do not ship the mismatch.

Statistical protocol is written but never executed: paired bootstrap, 10,000
resamples, seed 20260724, both rounds' CI lower bound > 0 before the frozen
200-task report set is touched.

## 7. Infrastructure debt

sgp-dev root filesystem is at 100% (2.0T used, 2.4G free) with the home directory
only accounting for ~85G; `docker system prune` reclaims ~6G but the real consumer
is elsewhere. Node there is v20.19.2 and pi requires ≥22.19.0. Cost ledger has
49.5M input / 26.8M output tokens with USD uncomputed because the gateway exposes
no verified rates.
