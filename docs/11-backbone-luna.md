# gpt-5.6-luna as the shared backbone — the 2026-07-31 price drop and what it changes

What this settles: **Luna is now cheaper than `gpt-5-mini` on every axis and scores
well above it on our own LongBench-Write slice.** What it does not settle: whether
*StoryOS on Luna* keeps the one advantage we have, because we have never run our own
harness on it. That run is the next thing to do and it costs about an hour.

Read `docs/10-backbone-swap-terra.md` first. This is the same question asked of a
different model, and the terra arm's answer was no.

## 1. The price change

OpenAI cut list prices on 2026-07-30. Luna fell 80%, Terra 20%, Sol not at all.

| model | input, old → new | cached, old → new | output, old → new |
|---|---|---|---|
| gpt-5.6-sol | 5.00 → 5.00 | 0.50 → 0.50 | 30.00 → 30.00 |
| gpt-5.6-terra | 2.50 → **2.00** | 0.25 → **0.20** | 15.00 → **12.00** |
| gpt-5.6-luna | 1.00 → **0.20** | 0.10 → **0.02** | 6.00 → **1.20** |

USD per million tokens, checked 2026-07-31 against OpenAI's pricing page, the
GPT-5.6 announcement and the developer-forum announcement thread. Above 272,000
input tokens the whole request reprices at 2x input and 1.5x output; `INPUT_CEILING`
is 256,000, so the standard tier is the right one.

Against the current shared backbone:

| | gpt-5-mini | gpt-5.6-luna | Luna is |
|---|---:|---:|---|
| input | $0.25 | $0.20 | 20% cheaper |
| cached input | $0.025 | $0.02 | 20% cheaper |
| output | $2.00 | $1.20 | **40% cheaper** |

`src/runtime/rates.ts` was written on 07-30, the day the cut began rolling out, and
captured the pre-cut numbers. It is now corrected. The other price table,
`~/storyos/experiments/novelbench-run/cost_model.py`, is **deliberately left stale**:
its rates came from the gateway operator rather than from OpenAI, and assuming a
reseller passed a cut through is not a measurement. It carries a warning instead.

## 2. Is Luna the counterpart of gpt-5-mini?

**By the vendor's own tiering, no.** OpenAI's model page says Luna "roughly
corresponds to the **nano** model tier used in earlier GPT-5 families" — a step
*below* mini, not level with it. The new price agrees: at $0.20/$1.20 it sits
essentially on top of `gpt-5.4-nano` ($0.20/$1.25), while `gpt-5.4-mini` is
$0.75/$4.50.

**By measurement on our own task, the label is wrong.** We already ran Luna on the
21-prompt LongBench-Write slice, so this does not need a new experiment:

| row | S̄ | S_q | S_l |
|---|---:|---:|---:|
| raw `gpt-5.6-luna` | 86.7 | **4.62** | 81.1 |
| raw `gpt-5-mini` | 76.7 | 4.07 | 72.0 |
| `bare-long-context` on luna | 87.3 | 4.53 | 83.9 |
| `bare-long-context` on gpt-5-mini | 82.6 | 3.83 | 88.5 |

**Luna beats gpt-5-mini by 10.0 points of S̄ and 0.55 of S_q as a raw row**, and by
4.7 / 0.70 in the continuation loop. A nano-tier model outscoring a mini-tier model
by half a point of rubric is a generation gap, not a tier gap: Luna is 5.6-family,
gpt-5-mini is a 2025-08 model. The tier name describes where it sits inside its own
family, not where it sits against a model a year older.

## 3. Connectivity and token efficiency, measured 2026-07-31

Probed directly against `ai-prod-sg.wenxiaobai.com`, our key, the same prompt:

| model | budget | latency | prose | output tokens | of which reasoning |
|---|---:|---:|---:|---:|---:|
| gpt-5.6-luna | 8,000 | 3.4 s | 734 chars | 191 | 29 (15%) |
| gpt-5-mini | 8,000 | 8.8 s | 633 chars | 789 | **640 (81%)** |

Concurrency: Luna returned **16/16 with zero failures, p50 3.6 s, max 5.8 s**.
Served model id is `gpt-5.6-luna-2026-07-09`, `finish_reason: stop`, real content.
No new key or route is needed — it goes through the same Singapore gateway on
`YS_KEY`, and `lbw_systems.MODEL_ROUTES` already lists it.

The reasoning split is the part worth keeping. **gpt-5-mini spent 81% of its output
budget on reasoning to produce slightly less prose than Luna produced with 15%.**
At list price that is roughly $0.0025 against $0.0003 per thousand characters of
prose on the output side — about **eight times cheaper**, from the price cut and the
token efficiency together, on top of being 2.6x faster.

Two caveats, because one prompt is one prompt. This is n=1 on prose samples, and
reasoning-token share is prompt-dependent. Do not quote the 8x; quote the ledger
after a real run. The direction is not in doubt, though, and it is corroborated by
the 21-task slice above.

**A trap this exposes**: at a 2,000-token budget gpt-5-mini returned
`finish_reason: length` with **empty content** — it had spent the whole budget on
reasoning. That is the failure `HANDOFF-supplies.md` warns about, and it is much
easier to hit on gpt-5-mini than on Luna. Any harness giving a scaffold role a tight
completion budget is silently penalising the mini backbone.

## 4. Why this is not the terra decision again

The terra arm was rejected because a stronger backbone closed our deficit to
unreadable parity *and* removed our only advantage: baselines started delivering the
requested length on their own, `bare-long-context` going from 0.46 attainment at 80k
on gpt-5-mini to 0.84–0.91 on terra. Length adherence is the one axis where StoryOS
separates, so terra bought a tie and sold our margin.

Luna sits differently on exactly that axis. In the loop row, **`bare-long-context`
on Luna has S_l 83.9 against 88.5 on gpt-5-mini** — it did *not* get better at
hitting length, it got better at prose. So the axis we win on may survive a move to
Luna in a way it did not survive a move to terra.

The counter-signal is in the same table and has to be stated. **Scaffolding's
marginal value shrinks as the backbone improves.** On gpt-5-mini the loop gains
+5.9 S̄ over the raw row (82.6 vs 76.7); on Luna it gains +0.7 (87.3 vs 86.7). If
that pattern holds for our harness too, Luna reproduces the terra outcome by a
different route — everyone converges, and there is nothing to bold.

**We cannot tell which happens, because there is no StoryOS-on-Luna run.** That is
the whole decision, and it is one subset away.

## 5. Decision

**Not adopting Luna as the paper's backbone yet. Running the arm first.**

Adopting it would mean regenerating every scaffolded row on both benchmarks — the
generation stage alone is about 100 M of the 292 M tokens spent so far, and the
judging would follow. That is not a decision to take on a price cut and a raw row.

What to run, in order:

```bash
cd ~/storyos-v3
BACKBONE=gpt-5.6-luna smoke/iterate.sh lbw fast      # 8 cells, ~1 h
python smoke/lbw-standings.py                        # our row against every baseline
```

Then read exactly two numbers:

1. **Our S_q.** On gpt-5-mini it is 3.56, the lowest in the table, and that is the
   project's central problem. If Luna lifts it into the 4s, the price cut has handed
   us the fix we were going to have to engineer.
2. **Our S_l against `bare-long-context` on Luna.** If we keep 97-ish while the loop
   stays around 84, the margin survives and Luna is strictly better than gpt-5-mini
   for us — cheaper, faster, higher quality, same advantage. If the loop catches up
   on length, this is the terra outcome again and we stay on gpt-5-mini.

If the LBW subset says yes, the LiveNovelBench arm is
`BACKBONE=gpt-5.6-luna smoke/iterate.sh lnb tiers a` plus the paired baselines, the
same shape as `smoke/run-lnb-terra-baselines.sh`.

## 6. One thing to fix regardless of the outcome

`cost_model.RATE_BRACKETS["high"]["gpt-5-mini"]` names Luna as gpt-5-mini's expensive
neighbour, which was true at $1.00/$6.00. After the cut Luna is *below* gpt-5-mini's
own public $0.25/$2.00, so the upper bracket now sits under the lower end of what the
model plausibly costs, and every gpt-5-mini dollar range that module prints is
understated at the top. A warning is in the code; the repair needs a new upper
neighbour and should land with the operator's re-confirmed card.
