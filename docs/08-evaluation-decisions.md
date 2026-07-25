# 08 — Evaluation decisions

Decisions of record for how StoryOS is measured, with the evidence behind each.
Anything contradicting this file needs an explicit decision, not silent drift.
Snapshot 2026-07-25 16:35, restructured 2026-07-25 18:55.

## 0. The paper has two tables. Everything below serves one of them.

**Decided 2026-07-25.** This supersedes the four-arena split in §6: ConStory is
no longer an arena we compete in.

**Table 1 — our own bench (FreshNovelBench, 40k–80k), two halves that are never
combined into one score.**

| Half | What it measures | How |
|---|---|---|
| **Quality** | the unverifiable half — plot, character, prose, emotional effect | LongStoryEval's hierarchical rubric and its aggregation architecture (§3) |
| **Fact** | the verifiable half — internal consistency | ConStory's nineteen-subtype taxonomy and checker recipe, scored as **EID**, not CED (§1) |

**Table 2 — LongBench-Write**, every system re-run by us under one frozen
evaluator, reporting $S_l$, $S_q$ and per-bucket breakdown separately (§6).

### What changed and why it is a simplification

ConStory stops being a place we post a score and becomes the *method* behind
Table 1's Fact half. Three things follow, all of them good:

1. **CED disappears entirely.** Its length-dependent ceiling
   ($\mathrm{CED}_{\max} = 190{,}000/w$, so 4.75 at 40k words) was only ever a
   problem because we wanted comparability with their leaderboard. We are not on
   their leaderboard. EID has no cap and is length-robust, and §1's evidence for
   switching now costs us nothing at all.
2. **The `o4-mini` blocker stops being a blocker.** §2 argued a same-set
   `o4-mini` row was mandatory to anchor checker substitution against their
   reported 0.884/0.550/0.678. That argument existed to defend *comparability
   with their numbers*. Since we no longer claim comparability, what we owe is
   validity on our own injected-error ground truth, which the running selection
   experiment already provides. `o4-mini` returns 404 on our gateway; that is now
   a footnote, not a gate.
3. **Baseline runs re-target.** Systems are run on FreshNovelBench and
   LongBench-Write. ConStory's 8–10k tasks remain useful only as a cheap
   development harness and as the calibration set for the Fact checker.

### The claim structure this supports

Do not state a single SOTA. Three separate claims, each on the arena that can
carry it:

- **Length**: frontier models cannot reach novel length and harnesses can.
  Measured twice, at two scales, and the gap widens with the target.

  At a **20,000-word** LongBench-Write request: `raw-gpt-5.5` produced 5,324
  words and `raw-gemini-3.1-pro-preview` 4,870, both scoring $S_l = 0$, while
  every harness scored 75–100.

  At a **40,000-word** target on our own bench (budget probe,
  `experiments/novelbench-run/`, one task, all systems):

  | System | words | share of target |
  |---|---:|---:|
  | `bare-long-context` | 40,090 | **100%** |
  | `agentwrite` | 34,294 | 86% |
  | `raw-gpt-5.5` | 11,071 | **28%** |
  | `raw-gpt-5.6-sol` | 7,980 | **20%** |
  | `raw-gemini-3.1-pro-preview` | 4,494 | **11%** |

  This is the cleanest number the project has. It is also the reason every
  consistency comparison must report actual words beside target words: a
  frontier model "scoring well" at a 40k target is scoring on 4.5k words of
  prose, where there is almost no opportunity to contradict itself.
- **Quality**, on Table 1's Quality half: at novel length we are not worse than
  the harnesses that can also get there.
- **Fact**, on Table 1's Fact half: this is where the gate is supposed to pay
  for itself, and where a null result is still publishable.

A caution that must not be lost in the restructuring: on ConStory's 8–10k tasks
`raw-gpt-5.6-sol` scores EID 1.666, the best number in the field, because a
model writing 9k words in one call has little opportunity for cross-chapter
contradiction. **Do not pick a fight on that terrain.** Our bench starts at 40k
precisely because that is where the opportunity to contradict exists.

## 1. The primary consistency metric is EID, not CED

**Decision.** Report **EID = error instances per 10,000 words** as the primary
verifiable consistency metric. Keep ConStory's CED as a secondary column for
comparability with their leaderboard, never as the primary.

**Why CED fails at novel length.** ConStory's CED numerator is *the count of
error subtypes that fired*, capped at 19 — `metrics.py::check_error_exists`
counts a subtype as 1 if its JSON array holds at least one record with an
`exact_quote`, so five naming errors and one naming error contribute equally.
Divided by words/10⁴, this gives a **length-dependent ceiling**:

| target length | max attainable CED |
|---|---:|
| 10,000 words | 19.00 |
| 15,000 words | 12.67 |
| **40,000 words** | **4.75** |
| 60,000 words | 3.17 |
| 100,000 words | 1.90 |

Saturation is already visible in our own data: at 14–15k words `agentwrite` and
`agents-room-style` fire 9.3 of 19 subtypes. At 40k nearly every subtype fires
once, so the ceiling (4.75) sits *below* what those systems already score at 14k
(6.155 / 6.610). CED at novel length compresses every system into a 4× narrower
band and structurally rewards longer output. It is unusable for a 40k–80k bench.

**EID needs no re-scoring.** The checker already stores every instance: each
subtype is a list of records carrying `exact_quote`, `location`,
`contradiction_pair`. CED merely collapses the list to a boolean. Recomputed from
the existing ConStory tuning-20 outputs (macro average, per-task ratio then mean):

| System | CED | **EID** | ×best |
|---|---:|---:|---:|
| raw-gpt-5.6-sol | 1.200 | **1.666** | 1.0× |
| raw-gpt-5.5 | 1.202 | **2.006** | 1.2× |
| raw-gemini-3.1-pro-preview | 3.964 | **5.441** | 3.3× |
| bare-long-context | 4.100 | **8.047** | 4.8× |
| storyos-index (v2) | 4.690 | **≈8.35** † | ≈5.0× |
| storywriter-style | 5.055 | **12.350** | 7.4× |
| agentwrite | 6.155 | **28.461** | 17.1× |
| agents-room-style | 6.610 | **32.633** | 19.6× |

† approximate: 109 instances over 130,557 words across 14 tasks; per-task prose
was not synced to sgp-dev, only the engine journal.

CED spans 5.5×, EID spans 19.6× — **3.5× more resolution, identical ranking**. So
switching costs no conclusion and buys discriminative power. Note `agentwrite` and
`agents-room-style` average 4.6 and 4.9 instances per fired subtype; CED discards
all of that. Recomputed CED matches the reported values digit-for-digit, which
validates the instance counter.

## 2. Checker selection must be redone against ground truth

**What was wrong.** The existing calibration
(`experiments/checker_calibration/`) compared `gpt-5-mini` against `gpt-5.5` for
**mutual agreement** (binary subtype agreement 0.842, mean positive Jaccard
0.209) and picked `gpt-5.5` when mini missed a preregistered 0.95 threshold. Mutual
agreement measures whether two models resemble each other, not whether either is
correct. Neither was compared against `o4-mini` (ConStory's own checker) nor
against any ground truth. **The substitution therefore has no validity evidence.**

**The redone experiment.** Rebuild ConStory's appendix-A.2 recipe: inject errors
with known ground truth, then run **all four candidates on the same set** —
`o4-mini`, `gpt-5.5`, `gpt-5-mini`, `gpt-5.6-terra` — and report P/R/F1 with
Wilson intervals. Running o4-mini ourselves is mandatory: their 200-story
diagnostic set is *not* in the released assets (released = `prompts.parquet`,
`stories.parquet`, 33 models' per-error CSVs), so our set differs in difficulty
and a cross-set comparison against their reported 0.884 / 0.550 / 0.678 proves
nothing. Only a same-set o4-mini row anchors it.

**Sample size.** 20 stories × 5 injected errors = 100 errors. Overall recall then
carries SE ≈ 0.05 (95% CI ≈ ±0.10) — enough to answer "is this candidate in
o4-mini's league". Per-category, 20 errors each gives ±0.22, which cannot separate
categories whose true recall ranges 0.35–0.625. So **report overall in the body,
per-category in the appendix explicitly marked underpowered**. 50 stories would be
needed for per-category claims.

**Carry their caveat.** ConStory concedes injected errors differ from natural
ones — injected are tidy "text says A, later says not-A", natural errors are often
weak-evidence, diffuse, requiring world knowledge. So 0.550 is optimistic for
tidy contradictions and must not be read as recall on the natural distribution.

## 3. Quality judge: architecture and selection

From LongStoryEval (`survey/notes/longstoryeval-2512.12839.md`), measured on 150
test books × 5 runs with GPT-4o, Kendall τ against Goodreads means:

| Architecture | τ×100 | input tokens | cost |
|---|---:|---:|---:|
| Aggregation — per chapter, input = metadata + full chapter + prior-chapter plot summaries; book score = mean | **15.2** | 11,480K | $416 |
| Summary-based — incremental summary trio (plot summary, character analysis, style excerpts) then one pass | 13.4 | 3,940K | **$94** |
| Incremental-updated — each step sees prior *evaluation* plus current chapter | 10.9 | 12,720K | $499 |
| One-pass — whole story at once | **5.5** | — | — |
| NovelCritique-8B (LoRA on 176K reviews) | **27.7** | — | — |

**Decision: aggregation as primary, summary-based as the cheap variant.**
One-pass is excluded on evidence: its collapse is *not* truncation (they tested
the 128K-fitting subset), it produces generic evaluations that miss book-specific
character, and subjective dimensions go **negative** (emotional impact −1.2,
enjoyment −3.2). A per-dimension one-pass is worth measuring as an ablation, but
the failure mechanism is attention diffusion over long context, not instruction
load, so splitting by dimension is not expected to fix it. Incremental is
excluded twice over: worst τ, highest cost, and a documented **anchoring effect**
where early positive impressions are not revised downward later.

**Selection experiment.** Pick the judge on 20 LongStoryEval books by Kendall τ
against Goodreads means, across `gpt-5.5`, `gpt-5-mini`, and the gpt-5.6 family
(`sol`, `terra`, `luna`). Prefer a single model for both consistency checking and
quality judging if it is competitive at both — one frozen judge identity is easier
to defend than two.

**temperature=0 stays, but multi-run averaging is mandatory.** They found closed
judges still vary run-to-run at temperature 0 in long context (the model randomly
focuses on different secondary story elements); the instability is **specific to
long inputs** and absent on short stories. temperature=0 removes sampling noise,
not this. They average 5 runs but never report single-run variance or a 3-vs-5
gain curve — we should report both, it is cheap and it is a real gap in their
methodology.

**Their ground truth has known bias**, to be disclosed when cited: Goodreads
means mix in marketing and fandom effects; their review-bias mitigation corrects
*who writes reviews* (rating rates 1★31%, 2★22%, 5★22%, 4★19%, 3★17% — high at
both ends) but cannot correct *who buys the book*, since readers self-select into
genre. And they publish **no human–human agreement upper bound**, so how far
τ=0.277 sits from the noise ceiling is unknown. Collecting even a small
human–human agreement set on our own generated stories would give us something
they lack.

## 4. Verifiable / unverifiable split

Two tables, never a composite score.

- **Verifiable**: EID (consistency), `required_elements` coverage, length
  attainment. Each has a defensible right answer.
- **Unverifiable**: quality dimensions via the LongStoryEval rubric and
  architecture.

**Hard constraint: the quality judge must not re-score consistency.** The
rubric's "plot & storyline" category naturally absorbs consistency defects; if
both tables count them, gate effects are double-counted and our advantage is
inflated. Freeze or drop the consistency-adjacent dimensions on the quality side.

## 5. Cost accounting

Measured, in tokens (USD remains uncomputable — the gateway exposes no verified
per-model rates, so `estimated_usd` is empty by design rather than guessed):

- ConStory checker, 5 categories per story, 10k-word stories: **≈82.5k tokens per
  story** (gpt-5.5; the calibration run was 2.48M tokens for 30 stories).
  A 40k-word story is ~4× the prose, so expect **≈330k tokens per story**.
- Faithful baseline regeneration at a 10,000-word target: `agentwrite` 167k
  tokens / 283s, `agents-room-style` 175k tokens / 303s.
- Quality side via aggregation, scaled from their 11,480K tokens / 150 books / 5
  runs ≈ 15.3k tokens per book-run at 121K tokens per book: a 40k-word story
  (~53k tokens) is roughly 44% of that per run.

## 6. Third-party benches: no standard exists, so split the burden of proof

Full matrix and per-bench evaluation in `survey/bench-selection-analysis.md`
(27 works × their evaluation sets).

**The headline is a negative result.** Long-form story generation has no
SWE-Bench-scale common yardstick. Highest co-usage across 27 works is **4**
(LongBench-Write: LongWriter, StoryWriter, LongWriter-Zero, IS-CoT — three of them
not the original authors). At least 12 of the 27 build their own evaluation set.
What gets reused in this field is **protocols** (Tell Me A Story's pairwise
protocol, HANNA's rubric, BookWorld's pairwise) rather than **data**.

**No public benchmark reaches 40,000 words.** The ceiling is LongBench-Write's
20k. And the gap has a second, sharper layer: every system that *does* write 40k+
evaluates itself on a self-built set with a tiny sample. MAGNET's 100-page tier is
**one story** — and so is every one of its ablations; its judge alignment was
validated on **one** 20-page story; the 6/11/12 hallucination counts it reports at
100 pages are **ATLAS's raw output, never human-verified**, while ATLAS's recall on
its own gold set is 0.8. EvoSpark writes 200–250k words but never states n.
**Beyond ~10k words, evaluation in this field degenerates into case
demonstration.** That is the necessity argument for our own bench, and it is
stronger than the contamination argument.

### EQ-Bench Longform is out

Two reasons, either sufficient. First, **zero of the 29 deep-read papers report a
score on it** — it is a model leaderboard, not something the field evaluates
against, so it cannot serve as a neutral yardstick. Second, its **chapter
degradation formula is unknown** to us, and that metric was the entire reason to
want it. Until the formula is read from the repository we cannot tell whether it
measures degradation along length at all (if it is merely a first-vs-last chapter
delta, it is blind to "collapses in the middle, recovers by the end"). Its 14-dim
rubric names, slop algorithm and n-gram repetition definitions are equally
unknown. Do not cite it in the motivation before reading the code.

On the harness question the answer is nevertheless useful: **technically it could
score a harness**, because all four metric families consume finished prose only —
nothing in the pipeline scores the brainstorm/plan/revise intermediates. The
blocker is the runner's generation interface, which is engineering, not validity.

### Recommended split

| Role | Bench | What it buys | Cost |
|---|---|---|---|
| **Main** | MoPS premises + Tell Me A Story pairwise protocol | the only combination neutral in *both* data and protocol; 8k-word scale; three comparable harness rivals (DOC, Agents' Room, StoryWriter) | human evaluation is expensive — thousands of USD even at 30–50 prompts |
| Secondary A | LongBench-Write | proves the consistency gain is not bought by writing short; highest co-usage; runnable in two days | 20k ceiling; must re-run every comparison row ourselves |
| Secondary B | ConStory | auditable consistency errors; the only bench with agent coordinates | 8–10k only; CED unusable (see §1) |
| Conditional | EQ-Bench Longform | chapter degradation, *if* the formula holds up | side table only, never a SOTA claim |

**Excluded, with reasons.** WritingBench is excluded on **validity**, not cost:
its absolute-score critic is nearly blind to orchestration gains —
LongWriter-Zero's thinking ablation is worth **+0.08** there versus **+553 Elo** on
pairwise. Our gains would be flattened. Also excluded: HelloBench, WebNovelBench,
LongGenBench, DOC-20, NARRA-Gym.

### Two corrections to numbers previously circulated

**LongBench-Write's composite is $\bar S = (20S_q + S_l)/2$, not
$(S_q + 20S_l)/2$.** Our own survey list contradicts itself between its table row
and its formula section; back-computation settles it — GPT-4o's
$(20 \times 4.1 + 52.8)/2 = 67.4$ hits the reported value exactly, the other
ordering gives 530. Consequence that matters: with $S_q \in [1,5]$ scaled by 20 and
$S_l \in [0,100]$, **half of the composite is length compliance**. StoryWriterGLM's
83.7 is therefore about half a length score, and $S_l$ must always be reported
separately.

**Cross-paper LongBench-Write numbers are not comparable.** GPT-4o scores 78.6 in
the original paper and **67.4** in StoryWriter's re-run — an 11.2-point gap,
roughly twice the 5.8-point method gain being claimed. So LongWriter-Zero's
"86.3 vs 84.0, ahead by 2.3" carries no signal against 11.2 points of
evaluator noise. Every comparison row must be re-run under one frozen evaluator.

## 7. Target length stays on the frozen tiers

**Decision: do not anchor targets to source-novel length.** Analysis in
`benchmarks/novelbench/length-anchoring-analysis.md`.

We cannot anchor to a length we do not have. `books.csv` carries `page_count`
50/50 with dual-source verification, but **real word counts 0/50** — and
`estimated_words` is not a second datum: its ratio to `page_count` has exactly one
distinct value, 275.0, so it is a pure derivation.

Page-to-word conversion is unreliable at the magnitude that matters. The decisive
evidence is inside our own book list: *Steel Gods* is **448 pages (US) versus 576
(UK)**, +28.6%; *Elizabeth and Marilyn* 368 vs 448, +21.7%. The same text under
different typesetting differs by 22–29%, which is a 35,200-word swing in an
anchored target — wider than the entire 40k→60k tier gap. The conversion error is
also correlated with dialogue density, hence with **genre**, putting the bias on
the dimension we least want contaminated. And *Steel Gods* happens to be one of
only eight `continuation` tasks.

**A premise I stated earlier was wrong and caused this detour.** I described the
40k tier as "systematically below the source novels" as if that were a defect.
`benchmarks/novelbench/selection-protocol.md:30-33` had already declared the
opposite: the tiers are a balanced factorial assignment, all 21 genre-by-length
cells are filled, and — verbatim — "Assigning a 40k target does not claim that its
source novel was 40k words." Anchoring would dismantle a frozen controlled factor.

Cost would be 1.71× (+33.8M tokens and +16.3 hours per system per round; +169M for
the five-tier E2), median target 98k, and 35 of 50 tasks would consume more than
half the frozen 3M per-task budget. Length diversity would get *worse*: 82% of
tasks would crowd into an 80k–120k band versus today's clean 40/60/80.

**What we do instead:** report the estimated source length as a **covariate**
("target 40k, source estimated 92k, ratio 0.43"). That keeps the factorial design
and comparability while stating honestly how our targets relate to real novels.

One of the analysis's objections is partly neutralised by §1: longer targets
mechanically improve CED (numerator capped at 19, so
$\mathrm{CED}_{\max} = 190{,}000/w$), but **EID has no cap and is length-robust**.
That argues for the EID switch rather than against anchoring per se — the core
objection, that we have no real length to anchor to, is untouched.

## 8. Open decisions

- **Mode imbalance is the real defect.** 42 `from_scratch` vs 8 `continuation`,
  and it is **confounded with genre**: mystery 0, romance 0, science_fiction 3,
  horror 2, the rest 1 each. Any per-mode result currently carries a genre effect.
  Cheap to fix: ConStory-style `continuation` describes a starting point in natural
  language rather than supplying literal prose, so only prompts change — no new
  books, no re-running the contamination probe. Do this before the report round.
- **Read EQ-Bench's degradation formula and runner interface** before any decision
  that depends on it (P0 in `survey/bench-selection-analysis.md`).
