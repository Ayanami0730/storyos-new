# Measured results as of 2026-07-25

Everything here was read off disk from completed runs. Nothing is projected or
rounded in our favour. Source paths are given so any number can be re-derived.

Backbone for all controlled systems is `gpt-5-mini`; the three `raw-*` rows use
frontier models and are therefore **not** a controlled comparison. Checker/judge
is `gpt-5.5`, selected because `gpt-5-mini` failed the preregistered calibration
threshold.

## 0. VALIDITY WARNING — the harness rows below are not yet a fair comparison

A code-level audit of our own baseline adapters against the official
implementations (`../../research/2026-07/25-baseline-context-flow-audit.md` §
"我方 baseline adapters 的复现忠实度警报") found that three adapters are
**unfaithfully weakened**, in every case in the direction that flatters us:

- **AgentWrite**: our writer prompt carries only premise, continuation setup and
  the current section brief (`storyos/src/baselines/implementations.py:393-405`).
  The official implementation passes the **accumulated full text so far** into
  every step (`LongWriter@447539b:agentwrite/write.py:56-84`). Our version
  effectively writes each section in isolation.
- **Agents' Room**: our writer receives the current brief plus a list of
  completed chapter *titles* (`implementations.py:540-566`). The paper specifies
  that every agent reads the **complete current shared scratchpad**, including
  planning blocks and prose written so far. We manufactured the most severe
  context break in the comparison.
- **RecurrentGPT**: our adapter dropped both the previous paragraph and the
  long-term top-k retrieval that the official loop performs.
- **DOME**: our writer omits `last_chapter_story`, which the official DHO writer
  prompt includes (`storyos/src/baselines/dome.py:681-716`).

Consequence: the 4.857 / 6.240 / 6.632 harness scores are inflated (i.e. made worse)
by our own implementation choices, so **"harnesses lose to bare long-context"
is not established** and this table must not be published in its current form.
Required before any claim rests on it: restore faithfulness, re-run the affected
systems, re-score, and re-derive the table. The `bare-long-context`, `raw-*` and
`storyos-index` rows are unaffected.

## 1. ConStory tuning-20 — consistency (CED, lower is better)

CED = distinct error subtypes detected ÷ (words / 10,000), range [0, 19] per 10k
words. Source: `storyos/experiments/reproduction-subsubset/checker/*.summary.json`.

| System | Class | CED ↓ | mean words | completed |
|---|---|---:|---:|---:|
| raw-gpt-5.6-sol | frontier zero-shot | 1.211 | 10,321 | 20/20 |
| raw-gpt-5.5 | frontier zero-shot | 1.229 | 12,201 | 20/20 |
| raw-gemini-3.1-pro-preview | frontier zero-shot | 3.960 | 10,480 | 20/20 |
| bare-long-context | controlled zero-shot | 4.069 | 11,060 | 20/20 |
| **storyos-index (v2)** | **ours** | **4.672** | 9,326 | **14/19** |
| storywriter-style | harness | 4.857 | 14,824 | 20/20 |
| agentwrite | harness | 6.240 | 15,065 | 20/20 |
| agents-room-style | harness | 6.632 | 14,098 | 20/20 |
| dome | harness | not scored | 10,504 | 4/20 |

Corrected 2026-07-25 against the authoritative
`experiments/reproduction-subsubset/summary.md` and `checker/*.summary.json`,
now in git. The earlier table carried mid-run partial values read off an
incomplete scoring pass; **three were materially wrong**, not just rounded:
storyos-index 4.69 → 4.672, storywriter-style 5.06 → **4.857**, agentwrite
6.15 → **6.240**. The ranking order is unchanged, but the StoryOS-to-storywriter
gap is less than half what the old numbers implied (0.185, not 0.37).

v2 category breakdown: `timeline_plot_logic` 1.92, `factual_detail` 1.38,
`narrative_style` 0.92, `characterization` 0.23, `world_building_setting` 0.23.
By task type: Continuation 6.17, Completion 4.58, Generation 3.88, Expansion 3.59.
Per-task CED spans 0.00 (task 1004) to 8.79 (task 0) over 14 tasks and 130,557
words, so variance is high and n is small.

Two caveats that must always travel with this table: the frontier rows use a
different backbone, and v2's five failed tasks are excluded from its mean, which
biases v2 optimistically if the failures were the harder items.

Honest reading: under a controlled backbone we beat every decomposition harness
and lose to the simplest baseline. Root cause in `03-v2-postmortem.md`.

## 2. FreshNovelBench subset-10 — can a system even reach novel length?

Targets are 40,000 words. Source:
`storyos/experiments/novelbench-subset/terminal-accounting.jsonl`.

| System | mean words | max | attainment | completed |
|---|---:|---:|---:|---:|
| storywriter-style | 69,140 | 75,043 | 172.8% | 9/10 |
| agentwrite | 67,041 | 75,609 | 167.6% | 10/10 |
| agents-room-style | 62,834 | 69,494 | 157.1% | 10/10 |
| bare-long-context | 40,485 | 40,943 | 101.2% | 10/10 |
| raw-gpt-5.6-sol | 8,690 | 10,828 | **21.7%** | 6/10 |
| raw-gpt-5.5 | 8,389 | 10,317 | **21.0%** | 9/10 |
| raw-gemini-3.1-pro-preview | 4,395 | 5,313 | **11.0%** | 10/10 |

Scoring in progress; `bare-long-context` came in at CED 2.35.

Combined with table 1 this is the length–consistency Pareto front: the most
consistent systems cannot reach length, and every system that reaches length is
markedly less consistent.

## 3. v2 gate process evidence

Across the same 19 tasks (`storyos/runs/tuning-local-r1-20260724-after-3m-w20k/`):

- 154 scene drafts committed, 279 rejected → **first-pass acceptance 35.6%**
- findings by validator: epistemic 363, semantic-fatal 198, audit 46,
  contract 17, schema 14, temporal 2
- 14/19 tasks completed; the 5 failures all stalled at 9 committed scenes
  (~8.4k words) after the rejection load exhausted the token budget

The breakthrough that produced 14/19 was raising the per-task budget to 3M tokens
and the writer completion cap to 20k, matching the configuration remote codex had
already validated. Every earlier local round completed 0/19.

## 4. Length-degradation pilot

`storyos/experiments/degradation/analysis_summary.json`, 4 premises × 5 target
tiers, N=20 completed cells:

- raw error instance count vs actual words: **r = 0.405, p = 0.076** — positive
  but not significant at α = 0.05
- CED (length-normalised) vs actual words: **r = −0.202, p = 0.394** — slightly
  negative, not significant
- dominant error categories by summed category CED: timeline/plot logic 53.1,
  factual detail 37.0, characterization 13.6, world-building 13.2, style 13.0
- actual words never exceeded 14,100 even at a 24,000-word target

So "errors grow with length" is directionally supported but **not statistically
established by our own data**. The published ConStory RQ2 result is the citable
backstop. Any figure using this must label it as a trend, not a law.

## 5. Judge / checker calibration

- LitBench, 300 pairs × 4 candidate judges × dual-order: `gpt-5.5` **0.740**
  human agreement (highest), `gpt-5.6-luna` 0.731, `gpt-5.6-sol` 0.725
  (best position consistency at 0.895), `gpt-5.6-terra` 0.709. All CIs overlap
  in 0.71–0.74. ~16/600 items tripped content filters.
- ConStory checker calibration, 30 paired tasks
  (`storyos/experiments/checker_calibration/report.json`): binary subtype
  agreement 0.842, **mean positive Jaccard only 0.209**, story exact-match 0.10.
  `gpt-5-mini` missed the preregistered threshold (agreement ≥ 0.95 with per
  category delta ≤ 0.03), so `gpt-5.5` is the frozen checker.

That 0.209 Jaccard is a real reliability limit and must be reported, not buried:
the checker agrees on *whether* a subtype fires far more often than on *which
instances* fire.

## 6. Cost

Local ledger `storyos/experiments/costs.csv`: 20,721 rows, **49.5M input tokens,
26.8M output tokens**. USD is not computed — the gateway does not expose verified
per-model rates, so `estimated_usd` is empty by design rather than guessed.

Notable per-system cost shape: DOME needs ~972 calls and ~2.6 hours for a single
10k-word task and still only completed 4/20, which is itself a finding about
faithful reproduction cost.

## 7. Reproduction status of every baseline

| System | Implemented | Ran | Scored | Notes |
|---|---|---|---|---|
| bare-long-context | yes | 20/20 | yes | strongest controlled baseline |
| agentwrite | yes | 20/20 | yes | segment budget bug fixed mid-run |
| storywriter-style | yes | 20/20 | yes | |
| agents-room-style | yes | 20/20 | yes | simplified multi-agent |
| raw-gpt-5.6-sol / raw-gpt-5.5 / raw-gemini-3.1-pro | yes | 20/20 | yes | frontier, different backbone |
| dome | yes | 4/20 | no | ~972 calls/task; failures mostly "output outside the 9k–11k word gate" |
| recurrentgpt | adapter exists | no | no | needs real sentence-transformers VectorDB → GPU |
| longwriter-zero-32b | not deployed | no | no | needs a full GPU |
| general-agent class (pi-agent-raw) | designed only | no | no | the cleanest "with vs without narrative OS" ablation |

## 8. What is not yet measured at all

No ablations have been run: gate on/off, bounded-working-set size, repair budget
k ∈ {0,1,2,4}, audit track off, semantic track off, typed patch vs free text,
versioning off. The injected-error study (3 error classes × 10 instances × 4
modes) is registered but unrun. No human evaluation. No 40k-word run by our own
system. The paired-bootstrap unlock gate for the frozen 200-task report set
(10,000 resamples, seed 20260724, both rounds' CI lower bound > 0) has not been
approached.

## 9. Artefact locations

| Artefact | Path |
|---|---|
| ConStory scores | `storyos/experiments/reproduction-subsubset/checker/` |
| NovelBench runs | `storyos/experiments/novelbench-subset/` |
| Degradation pilot | `storyos/experiments/degradation/` |
| v2 engine runs | `storyos/runs/tuning-local-r1-20260724-after-3m-w20k/` |
| Stories and metadata | `~/storyos-data/outputs/<system>/<bench>/` |
| Cost ledger | `storyos/experiments/costs.csv` |
| Paper and figures | `storyos/paper/` |
| Public site | http://8.222.254.65:30133/ |
| Public paper PDF | http://8.222.254.65:30133/main.pdf |
