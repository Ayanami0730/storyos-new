/**
 * pi's own `bash` and `read`, adapted to the plain `Agent`.
 *
 * These existed all along and I wrote replacements for them. Worth recording
 * why, because the mistake is instructive rather than merely embarrassing: the
 * built-in tools live under `harness/`, take an extra `context` argument, and
 * are typed for `AgentHarness` — so nothing about using the bare `Agent` makes
 * them reachable, and nothing about them advertises that they are one adapter
 * away. Choosing `Agent` over `AgentHarness` was never recorded as a decision
 * (`FOUNDATION.md` has nothing on it); everything since has been built on that
 * unexamined default.
 *
 * The adapter is five lines: bind an `ExecutionEnv` and drop the argument. What
 * that buys, per tool:
 *
 * - **read**: offset/limit, a structured truncation report, image handling.
 *   Mine had a 20k hard slice and no way to page.
 * - **bash**: truncation with the full output spilled to a path, and — the part
 *   that matters — a `prepare` hook invoked before execution that may throw.
 *   That is exactly the seam our refusal list needs, so the guarantees survive
 *   while the plumbing goes away.
 *
 * The guard stays ours because the *policy* is ours: no writes, no interpreters,
 * no network, no git, no reading another agent's transcript, a stated purpose,
 * and a per-transaction budget. pi has no opinion on any of that, correctly.
 */

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createBashTool, createReadTool } from "@earendil-works/pi-agent-core";

import { type ShellLimits, DEFAULT_SHELL_LIMITS, refusalFor } from "./shell.ts";

/** What a refused command looks like to the model: feedback, not a crash. */
export class ShellRefused extends Error {}

export interface NativeToolOptions {
  readonly projectRoot: string;
  /** Per-transaction budget key, so one scene cannot spend the next scene's reads. */
  readonly budgetKey: () => string;
  readonly limits?: Partial<ShellLimits>;
  readonly onRead?: (entry: {
    readonly command: string;
    readonly durationMs: number;
  }) => void;
}

interface HarnessTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: { env: NodeExecutionEnv },
  ): Promise<unknown>;
}

/**
 * Bind the environment so a harness tool becomes a plain `AgentTool`.
 *
 * A thrown refusal is converted to a normal result, because a tool that throws
 * ends the turn while a tool that answers "no, and here is why" lets the agent
 * try a different command in the same turn — which is the whole point of having
 * reasons in the refusal messages.
 */
function adapt(tool: HarnessTool, env: NodeExecutionEnv): unknown {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => {
      try {
        return await tool.execute(toolCallId, params, signal, onUpdate, { env });
      } catch (error) {
        if (error instanceof ShellRefused) {
          return { content: [{ type: "text", text: error.message }], details: undefined };
        }
        // pi's `read` throws on a missing file, which ends the turn. For us a
        // missing file is ordinary and the answer matters: a scene not yet
        // written, a character with no profile. Saying so is the difference
        // between the agent moving on and the agent inventing the contents.
        if ((error as { name?: string })?.name === "FileError") {
          const target =
            typeof params === "object" && params !== null && "path" in params
              ? String((params as { path: unknown }).path)
              : "that path";
          return {
            content: [
              {
                type: "text",
                text:
                  `${target} does not exist. It may not have been written yet — that is a ` +
                  `real answer, not a reason to invent its contents. If it should exist, ` +
                  `say so rather than working around it.`,
              },
            ],
            details: undefined,
          };
        }
        throw error;
      }
    },
  };
}

/**
 * `bash` and `read`, guarded and bound to the project.
 *
 * The budget is counted here rather than inside `prepare` so that a refusal for
 * budget reasons is indistinguishable in shape from a refusal for policy
 * reasons — an agent should not have to learn two failure vocabularies.
 */
export function nativeTools(options: NativeToolOptions): unknown[] {
  const limits: ShellLimits = { ...DEFAULT_SHELL_LIMITS, ...options.limits };
  const env = new NodeExecutionEnv({ cwd: options.projectRoot });
  const used = new Map<string, number>();

  const bash = createBashTool({
    prepare: (execution) => {
      const key = options.budgetKey();
      const spent = used.get(key) ?? 0;
      const reason = refusalFor(execution.command, limits);
      if (reason) throw new ShellRefused(reason);
      if (spent >= limits.maxCallsPerTransaction) {
        throw new ShellRefused(
          `shell budget exhausted for this transaction (${limits.maxCallsPerTransaction} ` +
            `calls). Work with what you have read, or say what you could not check.`,
        );
      }
      used.set(key, spent + 1);
      const started = Date.now();
      // Recorded on entry rather than on completion: a command that hangs is
      // exactly the one we want to see in the log.
      options.onRead?.({ command: execution.command, durationMs: Date.now() - started });
    },
  }) as unknown as HarnessTool;

  const read = createReadTool() as unknown as HarnessTool;

  return [adapt(bash, env), adapt(read, env)];
}
