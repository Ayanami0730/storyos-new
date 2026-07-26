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
export const VERSION = "0.5.1";

/**
 * What this version is, in one line, for a reader who has only the artefact.
 *
 * Not a changelog — `git log` is the changelog. This is the sentence that tells
 * someone reading a six-month-old `summary.json` what kind of system produced
 * it, because "0.4.0" alone will mean nothing to them.
 */
export const VERSION_NOTE =
  "orchestrator-driven scene loop with per-scene compute allocated by position in " +
  "the story (1/3/5 repair rounds and follow-ups across the opening, middle and " +
  "final 40%, with recall depth 1/2/3), path-addressed artefacts, OS-enforced " +
  "write gate (docker read-only mount), cost-triggered level-1 compaction, and " +
  "baseline-comparable token accounting (input+output, cache reads excluded)";

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
