/**
 * `run_command` as an actual tool, with a real executor.
 *
 * `GuardedShell` has existed, tested, since the tool layer was written — and was
 * never registered. The first nineteen-scene run gave its agents exactly one read
 * tool, `read_index(path)`, so:
 *
 *   - nothing could `grep`, which is the reason `context-builder` had no job and
 *     was never invoked;
 *   - an agent had to already know a path to read it, which means it could only
 *     find what we had thought to tell it about;
 *   - the design principle "free-form shell for reading, typed tools for writing"
 *     was half-implemented, and the half that was missing is the half that makes
 *     the index worth having.
 *
 * The executor is confined by cwd rather than by parsing the command. Parsing
 * shell for path escapes is a losing game (`$(...)`, symlinks, `--`), so the
 * guarantee comes from where the process starts and from `GuardedShell`'s refusal
 * list, and — once the sandbox backends land — from a read-only mount, which is
 * the only version of this that is actually enforced rather than argued.
 */

import { exec } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { GuardedShell, type ShellLimits } from "./shell.ts";
import { ToolRefusal } from "./registry.ts";

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

/**
 * Run a command inside the project, with a hard timeout and a bounded buffer.
 *
 * `maxBuffer` matters: without it a runaway `grep -r` can hold hundreds of
 * megabytes in memory before `GuardedShell` ever gets to truncate it.
 */
export function projectExecutor(cwd: string) {
  return (command: string, timeoutMs: number) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      exec(
        command,
        { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          // A non-zero exit is a legitimate answer, not a tool failure: `grep`
          // exits 1 when it finds nothing, and "nothing matched" is information
          // the agent needs rather than an error it should retry.
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : error
                ? 1
                : 0;
          resolve({
            exitCode: code,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? (error ? error.message : "")),
          });
        },
      );
    });
}

/** Spill large payloads under `runtime/artifacts/`, returning the readable path. */
export function artifactSink(projectRoot: string) {
  let seq = 0;
  return async (payload: string) => {
    seq += 1;
    const rel = path.join("runtime", "artifacts", `shell-${Date.now()}-${seq}.txt`);
    const full = path.join(projectRoot, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, payload, "utf8");
    return rel;
  };
}

export interface ShellToolOptions {
  readonly projectRoot: string;
  /** Per-transaction budget key, so one scene cannot spend the next scene's reads. */
  readonly budgetKey: () => string;
  readonly limits?: Partial<ShellLimits>;
  /** Records every read, for the "why did this run look at that" question. */
  readonly onRead?: (entry: {
    readonly command: string;
    readonly purpose: string;
    readonly exitCode: number;
    readonly chars: number;
    readonly truncated: boolean;
    readonly durationMs: number;
  }) => void;
}

export function shellTool(options: ShellToolOptions): unknown {
  const shell = new GuardedShell({
    execute: projectExecutor(options.projectRoot),
    spill: artifactSink(options.projectRoot),
    ...(options.limits ? { limits: options.limits } : {}),
  });

  return {
    label: "Run command",
    name: "run_command",
    description:
      "Read the project with a shell: ls, grep, sed -n, find, cat, head, wc. Paths are " +
      "relative to the project root. Read as much as you need — the index is the cheap " +
      "thing and guessing is the expensive thing — but narrow your commands: a grep that " +
      "returns the whole novel displaces the material the scene actually needs. Writing, " +
      "redirection, interpreters, network and git are refused.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        purpose: { type: "string", description: "Why this read is needed" },
      },
      required: ["command", "purpose"],
    },
    execute: async (_id: string, args: { command: string; purpose: string }) => {
      try {
        const outcome = await shell.run(
          { command: args.command, purpose: args.purpose },
          options.budgetKey(),
        );
        options.onRead?.({
          command: args.command,
          purpose: args.purpose,
          exitCode: outcome.exitCode,
          chars: outcome.stdout.length,
          truncated: outcome.truncated,
          durationMs: outcome.durationMs,
        });
        const body =
          outcome.stdout.trim() ||
          (outcome.exitCode === 0
            ? "(no output — the command succeeded and matched nothing, which is an answer)"
            : "(no output)");
        return toolText(
          outcome.exitCode === 0
            ? body
            : `exit ${outcome.exitCode}\n${body}${
                outcome.stderr ? `\nstderr: ${outcome.stderr.slice(0, 2_000)}` : ""
              }`,
        );
      } catch (error) {
        // A refusal is feedback, not a crash: the agent should read why and try a
        // different command in the same turn.
        if (error instanceof ToolRefusal) return toolText(String(error.message));
        throw error;
      }
    },
  };
}
