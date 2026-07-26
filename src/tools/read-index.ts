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
}): unknown {
  const maxChars = options.maxChars ?? 20_000;
  return {
    label: "Read index",
    name: "read_index",
    description:
      "Read a committed file from the index by path, e.g. novel/chapters/ch-01/scenes/" +
      "s-003.md. Say why in `purpose`.",
    parameters: Type.Object({
      path: Type.String(),
      purpose: Type.String(),
    }),
    execute: async (_id: string, args: { path: string }) => {
      try {
        const text = await options.read(args.path);
        return { content: [{ type: "text", text: text.slice(0, maxChars) }] };
      } catch {
        return {
          content: [
            {
              type: "text",
              text:
                `no such committed file: ${args.path}. It may not have been written yet — ` +
                `that is a real answer, not a reason to invent its contents.`,
            },
          ],
        };
      }
    },
  };
}
