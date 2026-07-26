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
export const VERSION = "0.4.0";

/**
 * What this version is, in one line, for a reader who has only the artefact.
 *
 * Not a changelog — `git log` is the changelog. This is the sentence that tells
 * someone reading a six-month-old `summary.json` what kind of system produced
 * it, because "0.4.0" alone will mean nothing to them.
 */
export const VERSION_NOTE =
  "orchestrator-driven scene loop with path-addressed artefacts, OS-enforced " +
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
