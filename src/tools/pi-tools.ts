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
  /**
   * Where a command actually runs.
   *
   * Supplied by a sandbox backend that confines it. Omitted, commands run on the
   * host with the refusal list as the only barrier — which is what every run
   * before the sandbox existed did, and is the honest control arm rather than a
   * secret default.
   */
  readonly shell?: {
    exec(
      command: string,
      options?: { cwd?: string; timeoutMs?: number },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
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
export function nativeTools(options: NativeToolOptions): {
  readonly tools: unknown[];
  readonly spend: (label: string) => string | null;
} {
  const limits: ShellLimits = { ...DEFAULT_SHELL_LIMITS, ...options.limits };
  const host = new NodeExecutionEnv({ cwd: options.projectRoot });
  /**
   * Reads stay on the host, execution may not.
   *
   * pi's `read` goes through `readTextFile`, and every role is meant to see the
   * whole tree — confining reads would break the uniform-read-reach guarantee to
   * solve a problem nobody has. Writes are the thing being gated, and the only
   * write vector an agent has is `bash`, so swapping `exec` alone is both
   * necessary and sufficient.
   */
  const env = options.shell
    ? (Object.create(host, {
        exec: {
          value: async (
            command: string,
            opts?: {
              cwd?: string;
              timeout?: number;
              onStdout?: (chunk: string) => void;
              onStderr?: (chunk: string) => void;
            },
          ) => {
            const result = await options.shell!.exec(command, {
              ...(opts?.cwd ? { cwd: opts.cwd } : {}),
              ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
            });
            // pi captures output through these callbacks, not from the return
            // value — the return only carries the exit code. A backend that
            // fills in `stdout` and stops produces a tool result the model sees
            // as empty, which is the silent-payload failure from `FOUNDATION`
            // gotcha 4 wearing different clothes.
            if (result.stdout) opts?.onStdout?.(result.stdout);
            if (result.stderr) opts?.onStderr?.(result.stderr);
            return { ok: true as const, value: result };
          },
        },
      }) as NodeExecutionEnv)
    : host;
  const used = new Map<string, number>();

  /**
   * One budget across every way of reading, not one per tool.
   *
   * Budgeting `bash` alone does not reduce anything — it relocates it. The
   * context-builder has three ways to read the same tree (`bash`, `read`,
   * `read_index`), and on the run where it consumed 81% of the tokens it used
   * all three: 10 shell commands, 27 reads and 8 path reads in a single run.
   * A cap that one of them respects is a cap.
   */
  const spend = (label: string): string | null => {
    const key = options.budgetKey();
    const spent = used.get(key) ?? 0;
    if (spent >= limits.maxCallsPerTransaction) {
      return (
        `read budget exhausted for this scene (${limits.maxCallsPerTransaction} reads, ` +
        `across bash, read and read_index together). Work with what you have, and say ` +
        `plainly what you could not check rather than guessing at it.`
      );
    }
    used.set(key, spent + 1);
    options.onRead?.({ command: label, durationMs: 0 });
    return null;
  };

  const bash = createBashTool({
    prepare: (execution) => {
      const reason = refusalFor(execution.command, limits);
      // Policy before budget: a refused command should not cost a read, and the
      // agent should hear why it was refused rather than that it is out of room.
      if (reason) throw new ShellRefused(reason);
      const exhausted = spend(execution.command);
      if (exhausted) throw new ShellRefused(exhausted);
    },
  }) as unknown as HarnessTool;

  const read = createReadTool() as unknown as HarnessTool;
  const budgetedRead: HarnessTool = {
    ...read,
    execute: async (id, params, signal, onUpdate, context) => {
      const target =
        typeof params === "object" && params !== null && "path" in params
          ? `read ${String((params as { path: unknown }).path)}`
          : "read";
      const exhausted = spend(target);
      if (exhausted) throw new ShellRefused(exhausted);
      return read.execute(id, params, signal, onUpdate, context);
    },
  };

  return {
    tools: [adapt(bash, env), adapt(budgetedRead, env)],
    /** Shared with `read_index` so one budget covers every way of reading. */
    spend,
  };
}
