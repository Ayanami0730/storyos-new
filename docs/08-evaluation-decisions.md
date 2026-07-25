# 08 — Evaluation decisions

Decisions of record for how StoryOS is measured, with the evidence behind each.
Anything contradicting this file needs an explicit decision, not silent drift.
Snapshot 2026-07-25 16:35.

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

## 6. Open decisions

- **Main third-party bench**: ConStory is being demoted (its 8–10k design cannot
  show length degradation, which is our motivation). Candidates under evaluation
  in `survey/bench-selection-analysis.md`: whether EQ-Bench Longform's prescribed
  brainstorm→plan→revise flow admits an agent harness at all, and whether
  LongBench-Write is the better neutral yardstick despite its 20k ceiling.
- **Target length anchoring**: replace the manual 40k/60k/80k tiers with
  per-task targets derived from each source novel's real length. Feasibility and
  cost analysis in `benchmarks/novelbench/length-anchoring-analysis.md`.
- **Mode imbalance**: 42 `from_scratch` vs 8 `continuation`. Rebalance or declare.
