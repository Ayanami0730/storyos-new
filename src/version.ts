/**
 * The harness version, stamped into every run.
 *
 * A version number is only worth having if an artefact can tell you which one
 * produced it. Every `summary.json` and every trace bundle carries this, so a
 * result found six months later is attributable without archaeology — and so
 * two results can be compared knowing whether they came from the same system.
 *
 * Bump `VERSION` when behaviour changes in a way that could move a number. The
 * things that qualify are not the obvious ones: a prompt edit moves numbers, a
 * refactor with identical prompts usually does not, and a fixed accounting bug
 * moves them a great deal.
 */

/** Semantic version of the harness. */
export const VERSION = "0.7.1";

/**
 * What this version is, in one line, for a reader who has only the artefact.
 *
 * Not a changelog — `git log` is the changelog. This is the sentence that tells
 * someone reading a six-month-old `summary.json` what kind of system produced
 * it, because "0.4.0" alone will mean nothing to them.
 */
export const VERSION_NOTE =
  "orchestrator-driven scene loop with per-scene compute allocated by position in " +
  "the story (2/3/5 repair rounds and follow-ups across the opening, middle and " +
  "final 40%, with recall depth 1/2/3), path-addressed artefacts, OS-enforced " +
  "write gate (docker read-only mount), cost-triggered level-1 compaction, " +
  "baseline-comparable token accounting (input+output, cache reads excluded), and a " +
  "per-scene verifier session; the verifier runs the same gpt-5-mini backbone as every " +
  "other role and every baseline, with cross-family available as an ablation, and " +
  "checks two axes — ConStory consistency subtypes and a craft axis distilled from the " +
  "LongBench-Write and LongStoryEval rubrics — against a deterministically assembled " +
  "claim-by-claim comparison with canon";

/**
 * Behaviours that could move a measured number, and when they landed.
 *
 * Kept because the most confusing kind of result is one produced by a version
 * you cannot characterise. Four of these were accounting or plumbing bugs whose
 * fixes changed numbers by large factors, so a run from before them is not
 * comparable with one from after, no matter how similar the configuration looks.
 */
export const VERSION_HISTORY: readonly {
  readonly version: string;
  readonly note: string;
}[] = [
  {
    version: "0.7.1",
    note:
      "the writer's follow-up allowance could be spent by the context-builder before the " +
      "writer asked anything, and on the opening tier that left it none. The allowance was " +
      "metered by counting `answer_writer` calls; that tool is on the builder's allowlist " +
      "permanently, so during its *initial* build — with no question outstanding — the builder " +
      "called it unprompted. Measured on `runs/v062/lbw081` s-001: the count reached one, the " +
      "opening allowance was one, and the writer's first and only question came back `no " +
      "follow-ups left`. It wrote the scene without the fact it had asked for and said so in " +
      "its closing message. Invisible in every summary, because the spontaneous call was " +
      "recorded *as* a follow-up — `follow_ups.by_tier` reported the mechanism as used. " +
      "`answer_writer` now requires an outstanding question, and the refusal message prints " +
      "the count and the allowance separately instead of printing the allowance for both.",
  },
  {
    version: "0.7.0",
    note:
      "the verifier gets a second axis and the evidence to use the first one. Three changes, " +
      "all of which move numbers. (1) A **craft axis**: findings for the defects the quality " +
      "rubrics penalise and ConStory's nineteen subtypes cannot express, each check naming the " +
      "graded dimension that penalises it — reported through a separate tool and counted in a " +
      "separate column, because pooling them would inflate EID with something that is not an " +
      "error in that taxonomy. Five checks may block, with checkable evidence required and a " +
      "cap of two per round; the rest warn. Motivated by the two worst defects found by " +
      "reading our own finished manuscripts, neither of which any layer could report: a story " +
      "that stopped instead of ending, and scenes that restate each other. (2) A " +
      "**deterministic dossier** in front of the verifier: every claim the draft makes against " +
      "what canon holds for it, with first establishments labelled as normal. The brief has " +
      "told the verifier to read the index since v0.1 and the measured result was three shell " +
      "reads across a nineteen-scene run — and eleven findings whose contradicting side was an " +
      "absence. It also finally passes the deterministic layer's findings, which the " +
      "verifier's own standing instructions have always told it to read. (3) `canon_context` " +
      "on a finding: the writer has no index access, so the verifier is the only participant " +
      "that can put a fact in front of it. Also: the opening tier's repair allowance goes 1 → " +
      "2, because the falsifiability check reported against the schedule — 5/5 opening scenes " +
      "hit their ceiling and committed carrying a defect, 0/10 endgame scenes reached theirs.",
  },
  {
    version: "0.6.2",
    note:
      "the verifier is stopped from reporting absences as contradictions. On the first run " +
      "with a same-family verifier it raised eleven findings shaped like " +
      "`objects/obj-note.yaml has no first_seen entry` and `the relation query returns " +
      "nothing for these two`, each labelled a contradiction pair with the empty result " +
      "standing in for the contradicting passage — and every one described a scene " +
      "establishing a fact for the first time, which is what a scene is for. That run scored " +
      "79.8 against 88.2 for a run with five real findings: the writer has no index access " +
      "and cannot tell a spurious finding from a real one, so it spent its repair rounds " +
      "writing provenance into prose that was already fine, and the prose is what is scored. " +
      "`makeFinding` now refuses an explicit-pair finding whose `contradicts.quote` is empty, " +
      "and the verifier brief states the direction outright. Also fixes a summary field that " +
      "lied: `verifier_model` was a hard-coded string naming the old default, so a run whose " +
      "roll-up plainly showed `verifier:gpt-5-mini` reported `gemini-3.1-pro-preview`",
  },
  {
    version: "0.6.1",
    note:
      "the verifier runs `gpt-5-mini`, the same backbone as every other role and as every " +
      "baseline. It was `gemini-3.1-pro-preview` from the start, on the argument that a " +
      "verifier from the writer's own family inherits its blind spots — a sound argument " +
      "that could not answer two objections. It broke the comparison: " +
      "docs/13-experiment-settings.md holds the generation backbone constant across " +
      "systems and every baseline runs gpt-5-mini throughout, so our +11.8 over the same " +
      "backbone on the LongBench-Write story slice mixed an architectural effect with a " +
      "stronger model in one role and could not be attributed. And it was unaffordable in " +
      "a way specific to us: the gateway returns zero cache reads for that model, so the " +
      "resident verifier re-sent its whole growing history every request (first-call input " +
      "10,142 → 61,934 tokens over four scenes at 8× the rate), reaching 81% of a run's " +
      "cost on 11% of its round-trips, and then exhausted the channel's plan quota so that " +
      "every call failed and scenes committed unverified. Cross-family is now the ablation " +
      "(`--verifier-model gemini-3.1-pro-preview`), recorded per run in `verifier_model`. " +
      "Every cost and quality row from before this is not comparable with one from after",
  },
  {
    version: "0.6.0",
    note:
      "the verifier starts each scene with an empty conversation instead of staying " +
      "resident for the whole run. Residency is paid for by re-sending the entire history " +
      "on every request, and whether that is affordable is a property of the provider: on " +
      "lbw081 the cross-family verifier (gemini-3.1-pro-preview) returned **zero** cache " +
      "reads on every call of every scene while the gpt-5-mini roles ran 60–84% cached, so " +
      "its first-call input grew 10,142 → 25,473 → 41,241 → 61,934 tokens across four " +
      "scenes and it became 81% of the run's cost ($17.42 of $21.62) on 11% of its " +
      "round-trips. At novel length that grows as scene count times history length, which " +
      "is the specific reason a 20,000-word target was unreachable. What the verifier gives " +
      "up is small and testable — its work is per-scene, cross-scene facts come from the " +
      "index it can read, and its durable lessons are in memory files that survive a reset " +
      "— and `--resident-all` restores the old behaviour as the ablation arm. Cost rows " +
      "from before and after are not comparable, so `fresh_each_scene` is recorded in every " +
      "summary",
  },
  {
    version: "0.5.1",
    note:
      "two repair-loop defects, both found by running 0.5.0 and both changing how much of " +
      "a manuscript survives. (1) A writer turn that failed outright — a provider content " +
      "filter, on the measured case — aborted the whole scene on the first failure with its " +
      "repair allowance unspent, and the orchestrator's sensible retry was then refused " +
      "because the transaction no longer existed; a failed turn now costs an attempt and " +
      "leaves the scene draftable, bounded by the scene's own allowance. (2) The livelock " +
      "detector compared finding *ids*, which are subtype plus quoted spans, so a writer " +
      "that rewrote the passage without fixing the defect produced a new id every round and " +
      "looked like progress: lbw081 s-001 spent three rounds on five findings that were all " +
      "the same causal-logic defect about one door. It now also stops when a blocking " +
      "subtype recurs after a rewrite without the blocking count falling. The second fix is " +
      "a precondition for 0.5.0's wider endgame ceiling — five repair rounds multiply the " +
      "cost of an undetected livelock by two and a half",
  },
  {
    version: "0.5.0",
    note:
      "per-scene compute is allocated by position in the story instead of by three " +
      "constants: repair rounds and writer follow-ups go 1 / 3 / 5 across the opening " +
      "third, the middle third and the final 40%, and the packet carries 1 / 2 / 3 " +
      "previous scenes of prose. The opening tier is deliberately *tighter* than the " +
      "0.4.0 default of two repair rounds — rounds not spent where defects are rare are " +
      "what pay for the tier where they accumulate — so an opening scene in 0.5.0 has " +
      "less room than the same scene had in 0.4.0 and a late scene has more. The " +
      "empirical basis is experiments/degradation (consistency-error instances rise with " +
      "finished length, r=0.711 over 16 cells, all four per-premise correlations " +
      "positive; timeline/plot and factual detail are 54.8% of them). Note the inference " +
      "being made: that experiment varies total length across runs, not position within " +
      "one run, so every scene's allowance is now recorded beside its findings to make " +
      "the schedule falsifiable from run data. `--max-repairs <n>` no longer sets a " +
      "global ceiling; it pins every scene to the same allowance and is the " +
      "uniform-allocation ablation arm. Verifier findings must now carry an actionable " +
      "`suggestion`, and a scene that cannot be repaired commits with its findings " +
      "recorded rather than being dropped (that change landed at the end of 0.4.0 and " +
      "moves the length score materially, so runs straddling it are not comparable)",
  },
  {
    version: "0.4.0",
    note:
      "the orchestrator drives each scene through call_context_builder / call_writer / " +
      "call_verifier / call_index_manager instead of the engine calling them in a fixed " +
      "order; artefacts are written to paths rather than passed inline; the write gate is " +
      "enforced by a read-only mount and demonstrated at startup; the token budget charges " +
      "input+output only (it previously charged cache reads, which were 89.5% of a run and " +
      "stopped it after a ninth of the allowed work); level-1 compaction triggers on " +
      "evictable payload bulk rather than only on overflow; a failed provider call is " +
      "retried and, if it cannot get through, the scene is recorded unverified rather than " +
      "silently approved; the writer is told the per-scene word target, which it previously " +
      "received as zero",
  },
];
