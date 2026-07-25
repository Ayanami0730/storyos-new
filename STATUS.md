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
| Novelty 1 | a unified lossless index fixes it | **unproven.** v2 scored CED 4.672 vs bare 4.069. This is what v3 exists to test. |
| Novelty 2 | filesystem index beats graphs for dense time-varying relations | **argued, not yet demonstrated.** Schema designed (`relations/<pair-id>.yaml`); no run has produced one. |
| Novelty 3 | FreshNovelBench | **built** — 50 frozen tasks, contamination gate, in Mongo and on the site. Human spot-check and full-50 probe still outstanding. |
| Method | v3 five-agent resident harness on pi | **designed, zero lines written.** Foundation smoke test passes. |
| Results | ConStory tuning-20, 8 systems | **measured but 3 rows invalid** — adapter unfaithfulness, see `docs/04-results.md` §0 |
| Results | FreshNovelBench subset-10 lengths | **measured**; CED scoring incomplete |
| Experiments | all ablations | **none run** |
| Writing | 8-page AAAI draft, 3 generated figures | **exists only on the local mac and is not in git** — see §1 |

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
  only the laptop-built `out/` is current. The deployed
  `out/data/research-pages.json` still carries the pre-correction CED values
  (4.69 ×6, 5.06 ×9, 6.15 ×9).

## 1b. Three published CED values were wrong, now corrected

The laptop's handoff flagged one stale number. Checking every system against the
authoritative `experiments/reproduction-subsubset/summary.md` found **three**:

| System | was | measured |
|---|---:|---:|
| storyos-index (v2) | 4.69 | **4.672** |
| storywriter-style | 5.06 | **4.857** |
| agentwrite | 6.15 | **6.240** |

The rest were rounding (1.20→1.211, 1.20→1.229, 3.96→3.960, 4.10→4.069,
6.61→6.632). The old values look like a mid-run reading taken while scoring was
still in flight. Ranking order is unchanged, but the StoryOS-to-storywriter gap
is 0.185 rather than 0.37 — the nearest harness is much closer than the earlier
table implied, which matters for how the v2 result is framed. All `.md` files in
this tree are corrected; **the website still needs it.**

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
