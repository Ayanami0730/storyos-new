/**
 * A path-addressed read of the canonical index, kept alongside the shell.
 *
 * Redundant with `bash` for a capable agent, and worth keeping anyway for two
 * reasons. It answers "read exactly this" without spending a shell budget slot,
 * and its not-found message is written to be useful rather than to be a shell
 * error — a scene that has not been written yet is an ordinary answer in this
 * system, and the agent needs to hear it as one.
 */

import { Type } from "typebox";

export function readIndexTool(options: {
  readonly read: (relPath: string) => Promise<string>;
  /** Hard cap, because a whole chapter pasted into a transcript is a compaction. */
  readonly maxChars?: number;
  /**
   * Charge one read against the shared budget, returning a refusal if there is
   * none left.
   *
   * Shared with `bash` and `read` rather than counted separately: three ways to
   * read the same tree with one budget each is three budgets, and the agent
   * that was over-reading used all three.
   */
  readonly spend?: (label: string) => string | null;
}): unknown {
  const maxChars = options.maxChars ?? 20_000;
  return {
    label: "Read index",
    name: "read_index",
    /**
     * Takes a list, because asking for one file per network round-trip is the
     * single largest cost in this system.
     *
     * Measured on a four-scene run: 284 round-trips, 92% of them carrying one tool
     * call, the context-builder averaging 22.5 per turn — each one re-sending a
     * 12,000-token transcript to receive one small YAML file. Telling the builder
     * to batch did not work: on the next run it went to 31 round-trips per turn
     * while the index-manager, given the same instruction, fell from 29.8 to 4.0.
     * An instruction that one role follows and another ignores is not a mechanism,
     * so the tool signature is the mechanism: a parameter named `paths` cannot be
     * used one file at a time without it being visible.
     */
    description:
      "Read committed files from the index by path — pass every file you already know you " +
      "want in one call, e.g. [\"characters/char-mira/profile.yaml\", \"objects/obj-key.yaml\"]. " +
      "One call for ten files costs one round-trip; ten calls cost ten, and each one re-sends " +
      "your whole transcript. Say why in `purpose`.",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), {
        description: "One or more paths. Batch them; a second call is for what you learn from the first.",
      }),
      purpose: Type.String(),
    }),
    execute: async (_id: string, args: { paths?: string[]; path?: string }) => {
      // `path` is still accepted, because a model that has seen the old signature
      // in its own transcript will keep using it, and refusing costs a round-trip
      // to teach something the batched form already encourages.
      const paths = (args.paths ?? (args.path ? [args.path] : [])).filter(Boolean);
      if (paths.length === 0) {
        return { content: [{ type: "text", text: "rejected: give at least one path in `paths`." }] };
      }
      const exhausted = options.spend?.(`read_index ${paths.join(", ")}`);
      if (exhausted) return { content: [{ type: "text", text: exhausted }] };

      // One budget slot for the batch, not one per file. Charging per file would
      // make batching cost the same as not batching, which is the behaviour being
      // discouraged.
      const budget = Math.floor(maxChars / paths.length);
      const parts: string[] = [];
      for (const p of paths) {
        try {
          parts.push(`### ${p}\n${(await options.read(p)).slice(0, budget)}`);
        } catch {
          parts.push(
            `### ${p}\nno such committed file. It may not have been written yet — that is a ` +
              `real answer, not a reason to invent its contents.`,
          );
        }
      }
      return { content: [{ type: "text", text: parts.join("\n\n") }] };
    },
  };
}
