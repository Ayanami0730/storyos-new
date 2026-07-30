# The gpt-5.6-terra backbone arm, 2026-07-30

What this settles: swapping every role from `gpt-5-mini` to `gpt-5.6-terra` closes
almost all of our quality and consistency deficit against the other scaffolds, and
it does not produce a lead over them. The measured advantage that remains is length
adherence, and it is no longer unique to us.

Everything below is `0.9.20` on two tasks per tier, the tasks the iteration subset
picks as the ones we score worst on (`smoke/make-iter-subsets.py` says why each).
The baselines were re-run on the same backbone and the same tasks, so the rows are
paired; `smoke/paper-tables.py` regenerates all of this from the artefacts.

## What moved

Gap to the best row sharing our backbone, per tier:

| tier | quality gap, gpt-5-mini | quality gap, terra | CE gap, gpt-5-mini | CE gap, terra |
|---|---|---|---|---|
| 20k | −0.240 | −0.025 | +0.59 | +0.36 |
| 40k | −0.108 | −0.021 | +0.79 | **−0.10** |
| 60k | −0.037 | −0.021 | +1.68 | +0.11 |
| 80k | not run | −0.016 | not run | +0.35 |

The quality judge's own retest standard deviation is 0.061 (single-retest maximum
deviation 0.187, `experiments/quality_judge/discriminability.json`, 78 stories). A
uniform −0.02 is a third of that, so on this instrument the four tiers read as
parity rather than as a deficit — and equally, they cannot be turned into a lead by
tuning, because a lead of that size is not resolvable at any n we can afford.

## What the n=2 cells do and do not support

Within-cell spread across the two tasks is 0.027–0.090, so the pair agrees closely.
That is enough to rule out a gap of the size we carried on gpt-5-mini (−0.24 at
20k). It is not enough to adjudicate ±0.02: separating that from a retest sd of
0.061 needs roughly ten tasks a tier.

## Length is the only axis that separates, and not by much

Attainment, delivered over target:

| system | 20k | 40k | 60k | 80k |
|---|---|---|---|---|
| StoryOS | 1.00 1.00 | 1.00 1.00 | 1.00 1.01 | 0.97 1.00 |
| RecurrentGPT | — | — | 1.00 1.01 | 1.00 1.00 |
| bare-long-context | 1.24 1.03 | 1.03 1.00 | 1.05 0.99 | 0.91 0.84 |
| StoryWriter | — | — | 1.17 1.15 | 1.17 1.03 |
| Agents' Room | 1.08 1.03 | 1.03 0.97 | 0.81 0.76 | 0.60 0.64 |
| AgentWrite | 1.45 1.26 | 1.36 1.35 | 1.29 1.34 | 1.19 1.34 |
| raw gpt-5.6-terra | 0.46 0.35 | 0.25 0.24 | 0.15 0.17 | 0.12 0.12 |

Two things follow, and both cut against the claim this arm was meant to support.
`RecurrentGPT` also holds 1.00 at 60k and 80k, so "only the harness delivers the
requested length" is false on this backbone. And `bare-long-context` reaches
0.84–0.91 at 80k here against 0.46 on gpt-5-mini: a stronger backbone writes longer
on its own, which weakens the premise that scaffolding is what buys length.

## The argument the data does support, and its cost

Agents' Room takes the top quality score at every tier while delivering 0.60–0.64 of
target at 80k, and the quality composite is negatively coupled to delivered length
(Spearman −0.366, same artefact). Its 4.749 at attainment 0.62 and our 4.732 at 0.985
are therefore not like for like, and a length-matched comparison reverses the sign.
This is the strongest thing in the data, but it rests on criticising the instrument
rather than on a clean margin, and a paper that leans on it has to make the coupling
argument in full rather than in a footnote.

## Recommendation

Do not move the paper's backbone to terra on this evidence. The gpt-5-mini table has
a separation that terra removes: on LongBench-Write, 21 tasks at 0.9.18 give 84.5
against AgentWrite's 80.1, eighteen wins to three, with the paired 95% CI excluding
zero. On terra there is no cell we could bold.

If the arm is pursued anyway, the two places with room are the 20k and 80k CE cells
(+0.36 and +0.35, while 40k is already the lowest in the field, so this is a
specific defect rather than a ceiling) and the task count, which has to reach about
ten a tier before any of these differences can be reported as differences.

## Reproducing

```bash
BACKBONE=gpt-5.6-terra PAR=8 smoke/iterate.sh lnb tiers a   # our four tiers
smoke/run-lnb-terra-baselines.sh                            # the baselines
smoke/paper-tables.py                                       # all four tables
```
