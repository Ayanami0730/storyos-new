# StoryOS v3 handoff

Read this first, then `FOUNDATION.md` (validated platform facts), then
`docs/01-novelty.md` (what the paper claims), then `docs/02-architecture.md`
(what to build).

This repo is the **system**: `Ayanami0730/storyos-new`, branch `main`. It accepts
tasks concurrently and emits complete results. Everything that *judges* those
results — data, evaluation scripts, every reproduced baseline, the paper, the v2
engine — stays in `storyos`, reachable here as the `storyos-legacy` remote. The
flow is one-way: run here, evaluate there.

## Why v3 exists

v2 shipped and produced the first measured number for our own system:
**CED 4.690** on ConStory tuning-20 (14/19 tasks completed, 130,557 words,
gpt-5-mini backbone). Under the same backbone, `bare-long-context` scores
**4.100** — the simplest possible baseline beats us. Full table and the root
cause are in `docs/03-v2-postmortem.md`; the short version is that v2's
validation gate protects *declared typed state* while CED measures *prose*, and
the audit extractor is hard-capped at 5 claims / 3 knowledge uses per scene, so
the gate only ever inspects a sample of what it is supposed to protect.

v2 also lost the design's strongest idea. It stored everything in SQLite tables,
which cannot express what the original design was about (see novelty 2).

## Division of labour: local vs sgp-dev

| Concern | Where | Why |
|---|---|---|
| Engine development, unit tests, single-task smoke | local mac | fast edit loop; Node 25 already installed |
| Sandboxed parallel experiments, long runs, benchmark sweeps | sgp-dev | direct gateway access, Docker, tmux, no laptop dependency |
| Paper, figures, benchmark data | `storyos` repo | unchanged |

Bridge is git. Do not copy files between machines by hand.

### sgp-dev environment facts (measured 2026-07-25)

Good:

- Gateway is reachable **without a proxy**: `https://ai-prod-sg.wenxiaobai.com/v1`
  answers in ~0.019s. The internal host `ai-prod-sg-internal.wenxiaobai.com`
  also answers. Neither the proxy dance nor the mainland-IP 403 from
  `FOUNDATION.md` applies there.
- Docker 26.1.3 is installed, so the write gate can be enforced by read-only
  bind mounts instead of prompt discipline.
- GitHub SSH works (`git@github.com:Ayanami0730/...`).
- tmux is the established pattern for long runs.

Blockers to clear before running anything:

1. ~~Node is v20.19.2~~ — **cleared 2026-07-25.** Node 22.20.0 is installed at
   `~/bin/node22` (official tarball; the system `/usr/bin/node` is still v20 and
   was left alone). Activate per shell with
   `export PATH="$HOME/bin/node22/bin:$PATH"`, or add that line to your shell rc.
   `npm install` and `smoke/gateway-tool-loop.mjs` both pass on sgp-dev with it,
   **without any proxy** — see "verified on sgp-dev" below.
2. **Disk is at 100%: 2.0T total, 16G free** (was 2.4G; codex reclaimed caches on
   2026-07-25). The home directory only accounts for ~85G (`popia_dmx` 23G,
   `raw_pools` 12G, `miniconda3` 12G, `vibe-engine-server` 11G), so the rest of
   the root filesystem is full for reasons outside this project. Experiments emit
   GB-scale run artifacts — treat free space as a hard gate, not a warning. The
   remote v2 history already contains a round invalidated by a mid-run disk-full
   abort; its response (preflight ≥3G, abort below 1G) is worth keeping.
3. ~~sgp-dev is shared with a running codex session~~ — **retired 2026-07-25**.
   The `storyos-v2` codex session, its watchdog and the tuning workers were
   stopped; see `STATUS.md` §3 for why and what was salvaged. Only
   `storyos-viewer` (port 30133) still runs. Still check `tmux ls` before
   launching anything that competes for the gateway.

### Why an agent on sgp-dev should own execution

Reaching sgp-dev from outside requires a JumpServer MFA ControlMaster socket
that expires after a few hours, so a remote assistant cannot babysit long runs.
An agent running *on* sgp-dev has no such limit. Let the remote side own
execution and report through the repo (commits, `runs/*/summary.json`), not
through chat.

## Locked design decisions

These were decided with the human and should not be silently revisited.

1. **Canonical state lives in the filesystem.** SQLite is a derived query
   projection that must be rebuildable from files. The reverse (v2's choice)
   destroys novelty 2.
2. **Five agents, all resident, delegation depth fixed at 1.** The orchestrator
   holds process ownership and calls the other four as native tools; each callee
   keeps its own persistent session context across invocations (Anthropic
   Managed Agents' "shared hands, isolated brains"). Specialists never spawn
   specialists.
3. **Every agent gets the same index access surface.** No agent is a
   second-class citizen with a narrower view: they all get `run_command` plus
   the same read/search tooling over the index. What differs is *write*
   authority, not *read* reach.
4. **Free-form shell for reading, typed tools for mutating.** `run_command`
   gives grep/ls/find/sed natively, so we do not hand-design a read tool per
   partition. Anything that changes canonical state goes through a typed,
   schema-validated tool (`propose_state_delta`, `write_findings`,
   `commit_transaction`).
5. **Only index-manager can produce `COMMITTED`.** The verifier's `APPROVED` is
   an opinion; prose and state delta land in one atomic commit or neither does.
6. **Skills store procedure, the index stores story state.** "Character A is in
   London and does not yet know the killer" belongs in the index, never in a
   skill or in agent memory.
7. **`MEMORY.md` is an index, not a transcript.** Follow Claude Code: load the
   *first* 200 lines (25KB cap), each line a `- [Title](topic.md) — hook`
   pointer, and let the agent grep/read topic files on demand. (An earlier
   assumption of "keep the last N lines" was wrong; CC does the opposite and its
   way is better.)
8. **Two-tier context compaction, thresholds configurable.** Level 1 clears
   re-fetchable tool payloads while keeping `tool_call_id`/name/artifact
   pointers; level 2 produces a structured summary and keeps a verbatim recent
   tail. Defaults derived from CC: `E = W - min(maxOutput, 20k)`, level 1 at
   `0.70·E`, level 2 at `E - 13k`, hard block at `E - 3k`.
9. **Two budget profiles, never mixed in one table** (added 2026-07-25).
   `parity` reproduces the baselines' allowance — 32,768 tokens per call and
   3,000,000 per task — and is the only profile whose rows may sit beside a
   baseline row. `generous` (64,000 per call, a 256k working context ceiling,
   `max(8M, 400 × target words)` per task) exists because the first complete run
   spent 213 tokens per output word, which puts 40,000 words at 8.5M and makes
   every long run under `parity` die of arithmetic before it can tell us whether
   the design works. Getting the behaviour right and cutting the cost are
   separate problems. Every summary records the profile and whether it is
   comparable; see `docs/08` §5b.

## What to do first, after pulling this on sgp-dev

1. `node -v` must be ≥ 22.19.0. It is v20.19.2 on sgp-dev today; install 22+ first.
2. Free disk. Root is at 100% with 2.4G free; `docker system prune` reclaims ~6G,
   but the real consumer is outside this project's home directory.
3. ~~`npm install && node smoke/gateway-tool-loop.mjs`~~ — **verified on sgp-dev
   2026-07-25 14:45**, no proxy needed. Reproduce with:

   ```bash
   export PATH="$HOME/bin/node22/bin:$PATH"
   npm install
   YS_KEY="$(cat ~/.config/ys/key)" node smoke/gateway-tool-loop.mjs
   ```

   It returns `verdict: PASS: gateway + native function calling + pi agent loop
   all work`, with `message_roles` showing a real multi-turn loop
   (`user → assistant → toolResult → assistant → toolResult → assistant`). So the
   platform gate for Phase 1 is closed: pi drives our gateway with native
   function calling from sgp-dev directly.
4. Read `docs/05-open-threads.md` and start at item 1. Items 1 and 2 gate the rest.

Full open-thread list with priorities, per-adapter fix table, the motivation
experiment design, and the remote-merge plan lives in `docs/05-open-threads.md`.

## Sandbox: what it is actually for

The agents are not adversarial, so isolation is not about security. Its real
value is that **the gated write path becomes OS-enforced rather than
prompt-enforced** — a much stronger claim than "we instructed the agent not to
write". Implement `SandboxBackend` with three interchangeable backends:

- `local` (development, unit tests): confined working directory; canonical index
  files carry read-only permissions and are only unlocked inside index-manager's
  commit critical section.
- `company-e2b` (**the runtime target**, verified from sgp-dev): the company's
  E2B-protocol-compatible service on Alibaba Cloud. Creation in **0.06s**,
  pause/resume preserves the filesystem, OSS CSI volumes mount by `sandbox_type`
  (a `story→/story` type already exists), Redis mapping works. Connection details
  and the two mistakes that make it look unreachable — the `api.` prefix and the
  private CA — are in `FOUNDATION.md` gotcha 3.
- `docker` (fallback if the company service is unavailable): canonical index
  bind-mounted read-only into every agent container except index-manager's.

e2b.dev is **not** needed: no credits, no tier caps, no per-second billing to
manage. Design constraint that holds for every backend: **the agent loop stays
outside the sandbox.** Each `run_command` enters, runs for seconds, returns, so
nothing long-lived depends on one sandbox session staying up and we never pay for
a VM idling on gateway latency.

## Trace and cost accounting

pi covers most of this natively: every `AssistantMessage` carries
`usage {input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost{...}}`
plus `timestamp`, `model`, `responseModel`, `responseId`, and `stopReason`, and
`ToolResultMessage` can carry its own usage. `AgentHarness` persists all of it
to JSONL sessions with fork/resume.

What we add: a story-level roll-up that aggregates the five agents' sessions
into one ledger per run (per-agent and per-phase tokens, cost, wall time, tool
call counts, retry counts, and gate outcomes), so a finished novel comes with a
complete audit trail. Requirement: **no run is considered complete unless its
trace, cost, and timing ledger is on disk.**

## First implementation phase

Do these in order; do not start phase 2 before phase 1's invariants hold.

1. Transaction kernel in a single process: the five roles' permissions and
   output schemas are already separate even if they temporarily share one model.
   Scene is the atomic transaction:
   `OPEN → CONTEXT_BUILT → DRAFTED → STATE_DELTA_PROPOSED → VALIDATING → (REPAIR ≤ k | REJECTED | APPROVED) → COMMITTING → (STALE_BASE → CONTEXT_BUILT | COMMITTED)`.
2. Context packets with a coverage report. If a hard-required id is missing the
   builder fails; it must never let the writer "reasonably infer" it.
3. Novel-domain schemas, in this order: scene card → canon facts / character
   state / timeline → belief visibility → promise-payoff → tension and revision
   passes.
4. Persistent multi-agent: per-agent thread, transcript, memory, skills;
   concurrency only for mutually independent verifier passes.

## Reference material

- `FOUNDATION.md` — measured platform facts and the two gotchas that cost hours
- `docs/01-novelty.md` — the three contributions and where their evidence lives
- `docs/02-architecture.md` — index tree, agent contracts, context management
- `docs/03-v2-postmortem.md` — v2 numbers and root causes, so we do not repeat them
- `../../research/2026-07/25-storyos-v3-harness-design-research.md` — the full
  design study (Claude Code mechanisms with file/line citations, 2026
  multi-agent paradigm comparison, novelist artefact inventory, thresholds,
  20-item risk list)
- `../../research/2026-07/25-baseline-context-flow-audit.md` — per-baseline
  evidence for novelty 1
- `references/repos/pi-mono` — pi monorepo at 0.80.6 for source reading; this
  repo depends on the published 0.82.0 packages
- `~/vibe-engine-server` on sgp-dev — production-validated engine to compare
  operational patterns against (11G, Python)
