# StoryOS status tracker

Live state, not a design doc. Updated 2026-07-25 13:10 +08 on sgp-dev, on taking
over the project. Design of record is `docs/02-architecture.md`; what the paper
claims is `docs/01-novelty.md`; measured numbers are `docs/04-results.md`.

## 0. Where each piece of the argument stands

| Layer | Claim / artefact | State |
|---|---|---|
| Motivation | quality degrades and facts drift as output grows | **directionally supported, not established** — our own pilot gives r = 0.405, p = 0.076 (N=20, never exceeded 14.1k actual words). Needs the 60k sweep (§2 below). |
| Motivation | raw frontier models cannot reach novel length | **established and clean** — 11–22% of a 40k target, nobody weakened them |
| Novelty 1 | existing harnesses hand each other *lossy* context | **claim rewritten 2026-07-25**, evidence audit done for 7 systems; the earlier "components can't see the prose" version was falsified by our own audit and must not be reused |
| Novelty 1 | a unified lossless index fixes it | **unproven.** v2 scored CED 4.690 vs bare 4.100. This is what v3 exists to test. |
| Novelty 2 | filesystem index beats graphs for dense time-varying relations | **argued, not yet demonstrated.** Schema designed (`relations/<pair-id>.yaml`); no run has produced one. |
| Novelty 3 | FreshNovelBench | **built** — 50 frozen tasks, contamination gate, in Mongo and on the site. Human spot-check and full-50 probe still outstanding. |
| Method | v3 five-agent resident harness on pi | **running end to end.** Five resident agents, three-layer verification, atomic commit, scene transaction loop, revisable plan, two-tier compaction, agent memory. 226 tests. Writes complete stories; see §0b for what is measured and what is still broken. |
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
different repair brief; promises are still declared and never paid; the revision
phase still produces tasks nothing consumes.

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
