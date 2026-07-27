# StoryOS status tracker

Live state, not a design doc. Updated 2026-07-27 10:30 +08 on sgp-dev; the newest
iteration log is the highest-lettered §0x section, currently **§0d**. Design of
record is `docs/02-architecture.md`; what the paper claims is `docs/01-novelty.md`;
measured numbers are `docs/04-results.md`.

This repository is **independent of `~/storyos` and its four `track/*` worktrees**
— separate git remote (`storyos-new.git`), separate history. Work here does not
touch the motivation / eval / baselines / longbench tracks, and the only thing it
reads from them is `~/work/longbench/experiments/longbench-write`, read-only,
through `smoke/score-lbw.sh` and `smoke/compare-lbw.py`, both of which redirect
every output path back into this repo.

## 0. Where each piece of the argument stands

| Layer | Claim / artefact | State |
|---|---|---|
| Motivation | quality degrades and facts drift as output grows | **directionally supported, not established** — our own pilot gives r = 0.405, p = 0.076 (N=20, never exceeded 14.1k actual words). Needs the 60k sweep (§2 below). |
| Motivation | raw frontier models cannot reach novel length | **established and clean** — 11–22% of a 40k target, nobody weakened them |
| Novelty 1 | existing harnesses hand each other *lossy* context | **claim rewritten 2026-07-25**, evidence audit done for 7 systems; the earlier "components can't see the prose" version was falsified by our own audit and must not be reused |
| Novelty 1 | a unified lossless index fixes it | **unproven.** v2 scored CED 4.690 vs bare 4.100. This is what v3 exists to test. |
| Novelty 2 | filesystem index beats graphs for dense time-varying relations | **argued, not yet demonstrated.** Schema designed (`relations/<pair-id>.yaml`); no run has produced one. |
| Novelty 3 | FreshNovelBench | **built** — 50 frozen tasks, contamination gate, in Mongo and on the site. Human spot-check and full-50 probe still outstanding. |
| Method | v3 five-agent resident harness on pi | **running end to end.** Five resident agents, three-layer verification, atomic commit, scene transaction loop, revisable plan, two-tier compaction, agent memory, per-scene compute allocated by story position. 413 tests. Writes complete stories; see §0d for the current measurement and what is still broken. |
| Results | ConStory tuning-20, 8 systems | **measured but 3 rows invalid** — adapter unfaithfulness, see `docs/04-results.md` §0 |
| Results | FreshNovelBench subset-10 lengths | **measured**; CED scoring incomplete |
| Experiments | all ablations | **none run** |
| Writing | 8-page AAAI draft, 3 generated figures | **exists only on the local mac and is not in git** — see §1 |

## 0b. Iteration log — 2026-07-25 evening, context budget and memory

The instruction was to stop letting the token budget shape the design: raise the
allowance, get the behaviour right, decide later what to cut. Two profiles now
exist (`docs/08` §5b) and `generous` is 64k output, a 256k working context
ceiling, and `max(8M, 400 × target words)` per task. What that bought was less
than expected and more useful than expected.

**The raised ceilings are not yet what binds.** Measured on the harbour premise:
peak context 38.7k at four scenes and 65.8k at four scenes with repairs, against
a level-1 threshold of 165k; peak output 21.5k against the new 64k cap. Budget
utilisation on a 4k-word run is 24.6%. The larger allowance has so far bought
one thing — removing the cap as a confound, so the real constraints become
visible. They are the repair budget and the verifier's false-positive rate.

**Three defects were found by raising the ceiling and then reading the runs.**
Each was reproducible and each is fixed with a test:

1. Compaction compared its thresholds against `usage.input` summed over a whole
   turn, which is ~11× the transcript on a turn with ten tool calls, and ignored
   `cacheRead`, which is most of the prompt under caching. It also recursed —
   summarising is a turn by the same agent — and paired compacted messages back
   to their originals by position after a fold had changed every position.
   None of this had ever run, because the old trigger was never reached.
2. World rules were handed to the writer as a bare P0 block. In three
   consecutive runs the writer wrote them into the viewpoint character's head on
   page one, destroying the discovery premise; the verifier correctly rejected
   scene 1 each time and the writer could not repair it. With the rules framed
   as "true, but not known", scene 1 committed first try with zero findings.
3. The writer filed events (`action: climbed the stairs`) as canon attributes,
   so the continuity checker saw a property change value and rejected a scene in
   which nothing was wrong. Now refused at the tool boundary.

A fourth is fixed but unproven: a 24k run hung for over twenty minutes on one
established socket with no CPU, no output and no error. There is now a per-turn
watchdog (`DEFAULT_TURN_TIMEOUT_MS`, 600s against a measured median of 45s and a
maximum of 301s) that aborts, records the cost, and lets the story continue.

**Memory works and is being used.** `remember` / `read_memory`, `MEMORY.md` as a
regenerated index, topic files with `source` / `last_verified_at` / `expires_at`,
and a code-enforced refusal to store anything mentioning a story entity. In a
four-scene run the writer recorded two role-craft lessons unprompted by
compaction — the trigger that worked was the nudge attached to repair rounds,
which is where the lessons are. Memory is run-scoped unless `--memory-dir` says
otherwise, and the summary records which.

**Open, in priority order:** the repair budget looks like the binding constraint
(a run at `--max-repairs 4` committed scenes at attempt 4 that a run at 2 would
have thrown away); the verifier's remaining rejections are spatial and causal
reasoning, which may be real defects the writer cannot repair or may need a
different repair brief.

## 0c. Iteration log — 2026-07-26, the orchestrator actually orchestrating

The previous round got all five agents live and produced the first clean run
(`runs/v8-native`: 4/4 scenes committed, 3,936 of 4,000 words, no dangling
cross-partition references, `relations/` and `beliefs.jsonl` populated for the
first time). Reading its transcripts turned up the thing this round is about.

**The orchestrator sent eight messages in the entire run and delegated nothing.**
It planned, called `update_plan` once, and stopped. Every scene was driven by the
engine calling the other four in a fixed order. Its own `AGENT.md` described a
loop — "open a transaction, have context built, have the scene drafted, send both
to the verifier" — that it had no tools to perform: `delegationTools` existed in
`residents.ts`, had tests, and was **never registered on any agent**. So the
architecture's central claim, five agents collaborating over a shared index, was
being carried by four agents and a for-loop.

What changed:

- **`SceneDirector`** breaks the scene transaction into steps that refuse to run
  out of order. Both drivers use the same steps: `runScene` walks them
  deterministically (what tests use), and `orchestratorTools` exposes them as
  `call_context_builder` / `call_writer` / `call_verifier` / `call_index_manager`.
  A call in the wrong state comes back naming the state and the legal next call.
- **`call_index_manager` is the commit.** Not a delegation followed by a commit —
  index-manager is the only actor that may produce COMMITTED, so the delegation
  and the transition are one call and there is no second commit tool for a
  different role to reach.
- **The engine finishes what the orchestrator leaves**, and records how many
  steps it had to rescue. That number is the measurement: a scene carried to a
  commit by the orchestrator alone is evidence agent-driven orchestration works;
  a rescued one is evidence it does not yet. Either way the novel gets written,
  which matters because losing an approved scene to a missed tool call would
  corrupt the only headline number with a failure unrelated to writing.
- **Artefacts are paths, not inlined strings.** The packet goes to
  `.context-builder/history/<ch>/<scene>.md`, drafts to `.writer/drafts/`, audits
  to `.verifier/audits/<scene>-aN.md`, the orchestrator's own account to
  `.orchestrator/scenes/`. A follow-up answer is **appended to the packet it was
  asked about** and the writer re-reads it with `read_context`, which is what the
  brief described. Before this, the orchestrator had never seen any artefact of
  any scene, which made "decide whether the outline needs revising" a decision
  from nothing.
- **The revision phase is consumed.** It produced tasks for two rounds and
  changed no prose in either, because nothing read them. The plan is now written
  to `.orchestrator/revision-plan.md` and put in front of the orchestrator, which
  judges each task rather than accepting it — with the two constraints that make
  it hard stated: later scenes were written against the defect, and a payoff with
  no preparation reads worse than the abandonment it repairs.

Three pieces of debt were paid at the same time:

- **The persona allowlists were fiction.** They named six tools that no factory
  built (`open_transaction`, `build_context_packet`, `apply_state_delta`, …) while
  the factory ignored the list entirely. They now name real tools and the factory
  checks both directions — granted-but-unlisted is an unreviewed capability,
  listed-but-not-granted is a role that cannot do its job and will not say so
  until mid-scene. `smoke/allowlist.ts` builds all five before a run starts.
- **Dead code removed**: `piAgentFactory`, `commitRevision` (which still wrote to
  the flat `manuscript/` path the tree replaced), and the unregistered
  `delegationTools` — the third parallel tool mechanism in this repo.
- **The CLI stopped being a god object**: 691 → 213 lines, with assembly, summary
  and planning in modules named after what they do.

309 tests and typecheck pass. Whether the orchestrator uses any of this is a
question for the run, not the code — the previous round is a standing reminder
that having a tool and using it are different facts.

## 0d. Iteration log — 2026-07-27, compute allocated by story position

Two versions landed this round: **0.5.0** allocates per-scene compute by position
in the story, **0.5.1** fixes two repair-loop defects that running 0.5.0 exposed.
Both are tagged, and `src/version.ts` records why each could move a number.

### What 0.5.0 changed

Three allowances stopped being constants and became a function of where a scene
sits (`src/runtime/allocation.ts`): **repair rounds and writer follow-ups go
1 / 3 / 5** across the opening third, the middle third and the final 40%, and the
packet carries **1 / 2 / 3** previous scenes of prose. This is the bottom-right
panel of the motivation figure — rising compute per scene against the prior
paradigm's flat bars — and it is realised in the measured data: mean billable
tokens per scene across five runs went **440k → 877k → 1,207k → 1,030k**, a 2.7×
ramp.

It is a *reallocation*, not an increase. The opening tier is tighter than 0.4.0's
flat default of two repair rounds; rounds not spent where defects are rare are
what pay for the tier where they accumulate. `--max-repairs <n>` no longer sets a
global ceiling — it pins every scene to one allowance and is the uniform-allocation
ablation arm.

The empirical basis is `experiments/degradation` (error instances rise with
finished length, r = 0.711 over 16 cells, all four per-premise correlations
positive; timeline/plot and factual detail are 54.8% of them). **The inference is
stated in the code**: that experiment varies total length *across runs*, not
position *within* one run, so every scene's allowance is recorded beside its
findings in `summary.json` → `allocation.by_tier` to make the schedule falsifiable
from our own data.

### What that record already says, and it is not flattering

Pooled over 20 scenes in five runs:

| tier | scenes | findings/scene | repair rounds used | at ceiling |
|---|---:|---:|---:|---:|
| opening | 5 | 1.40 | 5/5 | **5/5** |
| middle | 5 | 1.20 | 7/15 | 0/5 |
| endgame | 10 | 1.40 | 11/50 | **0/10** |

Findings per scene are **flat**, not rising. The binding constraint is the
*opening* — every opening scene hit its single round and committed carrying a
defect — while the endgame's five rounds were never once reached, because the
stall detector ends a non-converging loop long before the ceiling. So the schedule
is mis-shaped in both directions at these lengths, and the open decision is whether
to raise the opening tier to 2. **Left at 1/3/5 pending that decision** rather than
tuned to fit n=20.

### The two 0.5.1 fixes, both found by running 0.5.0

- **A failed writer turn aborted the whole scene.** `lbw103`'s opening call hit a
  provider content filter, the transaction went terminal, and the orchestrator's
  sensible retry was refused because the transaction no longer existed — a quarter
  of that manuscript lost with the repair allowance unspent. A failed turn now
  costs an attempt and leaves the scene draftable, bounded by the scene's own
  allowance.
- **The livelock detector compared finding *ids*,** which are subtype plus quoted
  spans — so a writer that rewrote the passage without fixing the defect produced a
  new id every round and looked like progress. `lbw081` s-001 spent three rounds on
  five findings that were all the same causal-logic defect about one door. It now
  also stops when a blocking subtype recurs after a rewrite without the blocking
  count falling. This is a **precondition** for 0.5.0's wider endgame ceiling: five
  rounds multiply the cost of an undetected livelock by two and a half.

### Measured: six LongBench-Write tasks, 500–5,000 words

All six committed every scene (24/24), `scenes_unverified: 0`, $22.65 total at list
price. **Five of the six are in LongBench-Write's official `creative writing ≥2k`
story slice**, so they are directly comparable to Table 2b. Paired on those five
tasks:

| system | S̄ | S_l | S_q | words |
|---|---:|---:|---:|---:|
| raw-gpt-5.6-sol | 94.6 | 93.3 | 4.80 | 3811 |
| raw-gemini-3.1-pro | 93.6 | 94.6 | 4.63 | 3523 |
| raw-gpt-5.5 | 91.8 | 85.7 | 4.90 | 4503 |
| **storyos-v3 0.5.1** | **90.0** | **98.1** | 4.10 | 3286 |
| agentwrite | 80.5 | 80.4 | 4.03 | 5209 |
| raw-gpt-5-mini (our backbone) | 78.2 | 79.8 | 3.83 | 4956 |
| bare-long-context | 77.3 | 77.3 | 3.87 | 5324 |
| storywriter-style | 75.4 | 79.4 | 3.57 | 5212 |
| agents-room-style | 74.3 | 71.3 | 3.87 | 5993 |

**+11.8 against our own backbone and +9.5 to +15.7 against the four harnesses, with
all 25 individual task comparisons positive** — not an average hiding a split. Our
$S_l$ is the highest in the table on the fewest words, so the length compliance is
not padding. The whole remaining gap to the frontier models is $S_q$. `lbw081` went
80.9 (0.4.0) → 88.2. Do not read this as SOTA: three raw frontier models are ahead,
and n=5.

### Short tasks: the four-scene floor had to yield

`lbw029` at 500 words was cut into four 125-word scenes and scored **best length
compliance of nine systems and worst quality of them**. `sceneCountFor` now floors
at 500 words per scene, so 500 words is one scene: 93.6 against 88.0, for $0.46
against $1.31 and 304 tokens per word against 4,542. Nothing at 2,000 words and
above changes, deliberately — those lengths are already scored.

### Infrastructure this round

- **`src/cli/run-batch.ts`** — many tasks from one jsonl, concurrent, resumable.
  Resume is decided from artefacts (`summary.json`, `run.lock`), never from a
  progress file, because a progress file is a second source of truth that
  disagrees exactly after a kill. Reads LongBench-Write's `tasks.jsonl` unchanged.
- **`run.lock` on every run directory** (`wx`, atomic). This closed the worst data
  defect of the session: two processes shared one output directory, interleaved
  their commits into one index, and a score was reported for a manuscript that no
  longer existed on disk. The write gate does not cover this — it confines agents,
  not harness processes.
- **`smoke/score-lbw.sh` matches judgement rows by `text_sha256`.** It previously
  printed the last row in an append-only file, which is how the above corruption
  surfaced as a plausible-looking score.
- **Trace detail** — `--deep` reconstructs every model round-trip from the
  transcripts (input, output, tool arguments, tool results, duration, tokens,
  next step). `lbw081` is 29 turns / 315 round-trips. Rendered on the site with a
  per-block 中/EN/双语 toggle.
- **Translation was silently echoing long blocks.** Above 8,000 characters the
  model returned its input instead of translating, 8 failures in 33 — English text
  sitting under a 中文 label. Now chunked at 2,500 characters on paragraph
  boundaries with an echo check; 8 → 1.

413 tests, typecheck clean. Not pushed.

### Open, in order

1. **Token efficiency is the only thing blocking the main result.** 973–1,331
   tokens per delivered word; the 21-task story slice would cost ~150M tokens,
   5.5× the entire existing eight-system table. Known handles: context-builder is
   81% of spend, and level-2 compaction has never once fired.
2. Whether the opening tier goes to 2 repair rounds (see the table above).
3. No run has exceeded 9.6k words. 40k is unverified.
4. Live Story Bench scoring is not wired to this harness — the quality side needs a
   summary pipeline that does not exist yet.

## 1. Sync gaps — CLOSED 2026-07-25 14:00

Both gaps recorded earlier are resolved. The laptop pushed `codex-run` to
`fd124e7` ("paper: land the submission, its figures and the scoring evidence from
the laptop", 351 files / 61,030 insertions) and tar-piped the gitignored bulk to
matching paths on sgp-dev. Verified here: `paper/main.pdf` (872,826 B),
`paper/main.tex`, 48 tracked files under `paper/figures/`, 43 under
`experiments/reproduction-subsubset/`, 29 under `experiments/novelbench-subset/`,
197 under `experiments/degradation/`. The transferred bulk matches the manifest
byte-for-byte: `runs/tuning-local-…-after-3m-w20k/` 9,159 files / 49,808,604 B,
`dome-checkpoints/` 177 / 19,332,476 B, `novelbench-subset/outputs/` 71 /
17,028,466 B. Details in `docs/07-v2-assets-and-locations.md` and the v2
`README.md` section 接手须知.

Two smaller gaps remain:

- **No TeX toolchain on sgp-dev** (`latexmk` and `pdflatex` are both absent), so
  the paper cannot be rebuilt here. Either install one — awkward at 16G free — or
  keep paper compilation on the laptop.
- **The website source is not in git and the copy on sgp-dev is stale.**
  `popia_dmx/storyos-bench-viewer/` is not a git repository, its `scripts/` has
  no `build_research_pages.py`, and `public/data/` holds only `palette.json`;
  only the laptop-built `out/` is current. Its `/leaderboard` numbers were
  never wrong — they read `mean_ced`, ConStory's own metric (see §1b).

## 1b. CED: two estimators exist, and only one is ConStory's metric

The laptop's handoff flagged StoryOS's CED as "4.69 should be 4.672". Chasing that
down revealed the real situation: `checker/*.summary.json` carries **two** numbers
per system, `mean_ced` (macro: mean of per-task CED) and `aggregate_ced` (pooled:
total errors over total words). The documented table had been using `mean_ced`
throughout, which is correct — **ConStory defines CED as the macro average**
($\overline{\mathrm{CED}}_m = \frac{1}{N}\sum_i \mathrm{CED}_{m,i}$,
`storyos/survey/notes/constory-2603.05890.md:166`).

I briefly switched the whole table to `aggregate_ced` on the assumption that the
old values were mid-run partials. That was wrong and is reverted: the table is
back on `mean_ced`. Nothing was ever "materially wrong" — the two estimators
mostly agree (|Δ| ≤ 0.03) and **give an identical ranking**; they diverge only
where per-task length varies most (storywriter 5.055 vs 4.857, agentwrite 6.155
vs 6.240). The one quantity that does depend on the choice is the
StoryOS-to-storywriter gap: 0.365 macro, 0.185 pooled.

Standing rule: macro is primary, pooled is a robustness check, never mixed in one
column. The website's `/leaderboard` reads `mean_ced` from
`~/storyos-data/scores/` via `build_outputs.py`, so it is already on the right
estimator — a second pipeline, but the same metric.

## 2. What to do, in dependency order

Detail for each lives in `docs/05-open-threads.md`; this is the sequencing view.

**Gate A — restore baseline faithfulness.** Three adapters are weakened relative
to the official implementations, always in our favour, so no cross-system
comparison currently means anything. Four adapters, four disjoint code paths,
four concurrent workers, then one serial re-score with the frozen `gpt-5.5`
checker into a *new* output root. Publish both tables; the delta between
unfaithful and faithful reproduction is itself a methodological result. Nothing
downstream is trustworthy until this lands.

**Gate B — the motivation sweep.** Two systems (strongest bare frontier model
and one respected harness), one premise at several detail levels, targets 5k →
60k, two charts: quality declining, factual errors rising, with actual words
reported next to targets. The pilot's non-significance is a warning that the
sweep must go much further out and score quality per tier. The teaser is then
regenerated with **the rendered charts as reference images**, so its top half is
real data. Depends on Gate A only for the choice of harness.

**Then, in parallel:**

- **Ablations.** The one that matters most for v3 is new: *extraction coverage →
  CED*. v2 capped audit extraction at 5 claims / 3 knowledge uses per scene, so
  its gate inspected a sample of what it was meant to protect. Sweep coverage and
  find out whether a gate can pay for itself. Then the registered set: gate
  on/off, working-set size, repair budget k, audit/semantic tracks off, typed
  patch vs free text, versioning off, and the injected-error study.
- **v3 Phase 1.** Transaction kernel → context packets with coverage reports →
  novel-domain schemas → persistent multi-agent. Sandbox is settled: the company
  E2B service, verified from sgp-dev at 60ms creation.
- **Paper debt.** Four `[[需核实]]` markers are all still true, and the main
  figure still misstates the gate order, draws deterministic modules as agents,
  and shows a `memory` cluster that does not exist. Fix the code or fix the
  claim.

**Environment: both blockers cleared 2026-07-25.** Node 22.20.0 is installed at
`~/bin/node22` (activate with `export PATH="$HOME/bin/node22/bin:$PATH"`; the
system v20 was left untouched), and the pi foundation smoke test passes on
sgp-dev with no proxy — `verdict: PASS: gateway + native function calling + pi
agent loop all work`, with a genuine multi-turn tool loop in `message_roles`.
Disk is at 100% with 16G free, which is workable but still a hard gate: the v2
history contains a round invalidated by a mid-run disk-full abort, so preflight
≥3G and abort below 1G.

## 3. Retired 2026-07-25: the sgp-dev codex session

`storyos-v2`, its watchdog `storyos-v2-wd`, and the idle `codex-goal` smoke
session were stopped, together with the two `run_constory_tuning.py` workers on
the `exact-normalization` shard. The watchdog was stopped first via its own
`.wd2-stop` flag, because it restarts codex whenever the session disappears.
`cot-distill` is a separate, unrelated codex session and was left alone.

Why: ~26 hours produced ~30 commits, every one validated by "does the gate pass /
does the task complete", **never once by CED**. No complete tuning-20 round was
ever finished, so report-200 was never unlocked, and each micro-fix exposed the
next boundary rather than converging. The architecture it was fixing is the one
v3 replaces.

What was salvaged: `docs/06-v2-repair-loop-failure-taxonomy.md` — eight
reproducible failure families with journal hashes, the most important being that
**v2's engine partially rewrites the writer's patch**, which produced a scene
whose nine consecutive drafts had identical prose digests. v3 forbids this. Also
worth inheriting: the preregistration discipline (fresh run identities, no
splicing partials, byte-identical source-lock reconstruction, config digests on
every run), the 3M-token / 20k-writer-cap configuration, and the deterministic
1020→1764 task substitution.

Not salvaged: the engine diffs themselves, which patch `orchestrator.py`,
`verifier.py` and `audit.py` in an architecture where canonical state lives in
SQLite and the engine edits the writer's proposal — the two decisions v3
explicitly reverses.

## 4. Currently running on sgp-dev

`storyos-viewer` on port 30133 serves the public site and `main.pdf`. Nothing
else related to this project is running.
