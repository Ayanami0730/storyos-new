/**
 * The write gate as a read-only mount.
 *
 * This is the strong version of the claim. The project is bind-mounted into a
 * container at `/project` with `:ro`, every agent shell command runs as
 * `docker exec` inside it, and a write to canonical state fails with `EROFS`
 * from the kernel. There is no command an agent can compose that gets around
 * it, because the permission it would need is not held by the process running
 * the command — which is the difference between "we instructed the agents not
 * to write" and "the agents could not write".
 *
 * ## Why the whole project is read-only, not just the canonical partitions
 *
 * Simpler and strictly stronger. The writable things — `staging/`, `runtime/`,
 * each `.<role>/` — are written by the harness process on the host, never by an
 * agent's shell. An agent's shell is for reading; the typed tools are for
 * changing things, and they do not run in here. So there is nothing an agent
 * legitimately writes through a shell, and the mount can say so.
 *
 * ## The agent loop stays outside
 *
 * The container holds no state and runs no model. It exists so that a `grep`
 * has somewhere to happen where the write is impossible. `CanonicalIndex.commit`
 * runs in the host process, which is exactly where the one actor allowed to
 * write belongs — so `withWriteAccess` is a no-op here rather than a hole: the
 * gate is on the agents, and the harness was never inside it.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { ExecResult, ProbeResult, SandboxBackend } from "./types.ts";

const run = promisify(execFile);

/**
 * Small, present on the host already, and has the tools an agent reads with.
 * BusyBox `grep`, `sed`, `find` and `ls` cover everything our briefs suggest.
 */
export const DEFAULT_IMAGE = "alpine:latest";

export class DockerUnavailable extends Error {}

export interface DockerSandboxOptions {
  readonly root: string;
  readonly image?: string;
  /** Per command. The turn watchdog is the outer bound; this is the inner one. */
  readonly timeoutMs?: number;
}

export class DockerSandbox implements SandboxBackend {
  readonly id = "docker" as const;
  readonly enforcement = "mount" as const;
  readonly #root: string;
  readonly #image: string;
  readonly #timeoutMs: number;
  #container: string | null = null;

  constructor(options: DockerSandboxOptions) {
    this.#root = path.resolve(options.root);
    this.#image = options.image ?? DEFAULT_IMAGE;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  /**
   * Start the container.
   *
   * Long-lived and idle: starting one per command would add a second of latency
   * to every `grep`, and a container that only ever runs `docker exec` costs
   * nothing while it waits.
   */
  async start(): Promise<void> {
    try {
      const { stdout } = await run("docker", [
        "run",
        "--detach",
        "--rm",
        // Read-only, and that single flag is the entire guarantee.
        "--volume",
        `${this.#root}:/project:ro`,
        "--workdir",
        "/project",
        // No network: an agent reading an index has no business making
        // requests, and a sandbox that can reach the internet is a sandbox
        // whose failure modes are somebody else's.
        "--network",
        "none",
        // Bounded, so a runaway command cannot take the host down with it.
        "--memory",
        "512m",
        "--cpus",
        "1",
        this.#image,
        "sleep",
        "infinity",
      ]);
      this.#container = stdout.trim();
    } catch (error) {
      throw new DockerUnavailable(
        `could not start the sandbox container from ${this.#image}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Translate a host path into the container's view of it.
   *
   * pi hands the tool an **absolute host** cwd, not a relative one. Joining that
   * onto `/project` produced `/project/tmp/storyos-.../project` and every single
   * command failed with `chdir ... no such file or directory` — the whole docker
   * backend was broken in a way no unit test could see, because a backend test
   * calls `exec` without a cwd and pi is the only thing that supplies one.
   */
  #containerPath(cwd: string | undefined): string {
    if (!cwd) return "/project";
    const relative = path.isAbsolute(cwd) ? path.relative(this.#root, cwd) : cwd;
    if (!relative || relative.startsWith("..")) return "/project";
    return path.posix.join("/project", relative.split(path.sep).join("/"));
  }

  readonly shell = {
    exec: async (
      command: string,
      options: { cwd?: string; timeoutMs?: number } = {},
    ): Promise<ExecResult> => {
      if (!this.#container) {
        throw new DockerUnavailable("the sandbox container is not running");
      }
      const args = [
        "exec",
        "--workdir",
        this.#containerPath(options.cwd),
        this.#container,
        "sh",
        "-c",
        command,
      ];
      try {
        const { stdout, stderr } = await run("docker", args, {
          timeout: options.timeoutMs ?? this.#timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        // A non-zero exit is an ordinary result for a shell — `grep` finding
        // nothing exits 1 — so it comes back as output rather than as a throw.
        const e = error as { stdout?: string; stderr?: string; code?: number; message?: string };
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? e.message ?? "",
          exitCode: typeof e.code === "number" ? e.code : 1,
        };
      }
    },
  };

  /**
   * A no-op, and that is the design rather than an omission.
   *
   * The commit runs in the harness process on the host, which was never inside
   * the mount. There is nothing to open.
   */
  async withWriteAccess<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async probe(): Promise<ProbeResult> {
    const result = await this.shell.exec("echo probe > /project/world/.gate-probe");
    if (result.exitCode === 0) {
      return {
        writeRefused: false,
        detail: "a shell inside the sandbox wrote to world/ — the mount is not read-only",
      };
    }
    return {
      writeRefused: true,
      detail: `writing world/.gate-probe from inside the sandbox failed: ${
        result.stderr.trim().slice(0, 200) || `exit ${result.exitCode}`
      }`,
    };
  }

  async dispose(): Promise<void> {
    if (!this.#container) return;
    const id = this.#container;
    this.#container = null;
    // `--rm` handles removal; killing is what stops the idle `sleep`.
    await run("docker", ["kill", id]).catch(() => {});
  }
}

/** Is a docker daemon reachable? Checked rather than assumed. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
