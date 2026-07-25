/**
 * The two tools that reach an agent's memory.
 *
 * Kept apart from `memory.ts` so the store can be tested without a tool
 * runtime, and so the rejection messages — which are the part the model
 * actually reads — sit next to each other where they can be kept consistent.
 */

import { Type } from "typebox";

import { type AgentMemory, MEMORY_SCOPES, memoryProblems } from "./memory.ts";

/** Tool payloads must be wrapped like this or the model never sees them. */
function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

export interface MemoryToolOptions {
  /** Where the lesson is being learnt — usually the current scene id. */
  readonly source: () => string;
  /**
   * Called after a successful write so the caller can put the refreshed index
   * back into the system prompt. Without it an agent writes a memory and then
   * cannot see that it exists until the next process.
   */
  readonly onChange?: () => Promise<void> | void;
  readonly knownEntities?: () => readonly string[];
}

export function memoryTools(memory: AgentMemory, options: MemoryToolOptions): unknown[] {
  const knownEntities = options.knownEntities ?? (() => []);
  return [
    {
      label: "Remember",
      name: "remember",
      description:
        "Record something you learnt about how to do your job on this project, so it " +
        "survives your conversation being summarised. Reuse a topic name to update that " +
        "lesson. Story facts do not belong here — those go in the index.",
      parameters: Type.Object({
        topic: Type.String({
          description: "Lowercase slug, e.g. false-positive-metaphor. Reuse to update.",
        }),
        title: Type.String({ description: "One line, at most 80 characters" }),
        hook: Type.String({
          description: "One line shown in your index; enough to decide whether to open it",
        }),
        body: Type.String({ description: "The lesson, and what it is based on" }),
        scope: Type.String({ description: MEMORY_SCOPES.join(" | ") }),
        expires_in_days: Type.Optional(
          Type.Number({ description: "Omit if the lesson has no shelf life" }),
        ),
      }),
      execute: async (
        _id: string,
        args: {
          topic: string;
          title: string;
          hook: string;
          body: string;
          scope: string;
          expires_in_days?: number;
        },
      ) => {
        const input = {
          topic: args.topic,
          title: args.title,
          hook: args.hook,
          body: args.body,
          scope: args.scope as never,
          source: options.source(),
          ...(args.expires_in_days ? { expiresInDays: args.expires_in_days } : {}),
        };
        const problems = memoryProblems(input, knownEntities());
        if (problems.length > 0) {
          // Every problem at once: one field per round trip turns a three-field
          // mistake into three turns, and the agent cannot see the later
          // problems until it has fixed the first.
          return toolText(
            `rejected:\n- ${problems.map((p) => `${p.path}: ${p.problem}`).join("\n- ")}`,
          );
        }
        const stored = await memory.write(input);
        await options.onChange?.();
        return toolText(
          `remembered as ${stored.file}` +
            (stored.expiresAt ? `, expiring ${stored.expiresAt.slice(0, 10)}` : "") +
            `. It is in your index from now on.`,
        );
      },
    },
    {
      label: "Read memory",
      name: "read_memory",
      description: "Open one of your memory topics in full, by its topic name.",
      parameters: Type.Object({
        topic: Type.String({ description: "Topic name from your index, without .md" }),
      }),
      execute: async (_id: string, args: { topic: string }) => {
        const found = await memory.read(args.topic);
        if (!found) {
          const live = await memory.live();
          return toolText(
            `no memory topic ${JSON.stringify(args.topic)}. ` +
              (live.length > 0
                ? `You have: ${live.map((m) => m.topic).join(", ")}.`
                : `You have not recorded any yet — that is a real answer, not a reason to ` +
                  `invent one.`),
          );
        }
        return toolText(
          `# ${found.title}\n(scope ${found.scope}, from ${found.source}, last verified ` +
            `${found.lastVerifiedAt.slice(0, 10)})\n\n${found.body}`,
        );
      },
    },
  ];
}
