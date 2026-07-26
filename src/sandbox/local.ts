/**
 * The write gate as filesystem permissions.
 *
 * The canonical partitions are made read-only and unlocked only inside
 * `withWriteAccess`, which wraps the commit and nothing else. A shell command
 * that tries to write canon gets `EACCES` from the kernel rather than a refusal
 * from our regular expressions.
 *
 * Its honest limit: the agent's shell runs as the same user, so a command that
 * thought to `chmod` first would get through. Our policy layer refuses `chmod`,
 * which makes this two independent barriers rather than one — but it is why
 * `enforcement` says `permissions` and not `mount`, and why the docker backend
 * exists. Worth having anyway: it needs no daemon, no image and no network, so
 * it is the one backend that runs everywhere including in tests, and it catches
 * the accidental write, which is the only kind we have actually seen.
 */

import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import {
  type ExecResult,
  type ProbeResult,
  type SandboxBackend,
  CANONICAL_PARTITIONS,
} from "./types.ts";

const LOCKED_DIR = 0o555;
const LOCKED_FILE = 0o444;
const OPEN_DIR = 0o755;
const OPEN_FILE = 0o644;

async function setMode(root: string, locked: boolean): Promise<void> {
  for (const partition of CANONICAL_PARTITIONS) {
    const full = path.join(root, partition);
    try {
      await stat(full);
    } catch {
      continue; // a partition that does not exist yet needs no lock
    }
    await walk(full, locked);
  }
  // HEAD last on the way down and first on the way up: it is the file that
  // makes a commit visible, so it should be the hardest thing to change by
  // accident and the last thing unlocked.
  try {
    await chmod(path.join(root, "HEAD"), locked ? LOCKED_FILE : OPEN_FILE);
  } catch {
    // Not created yet. `init` writes it before anything is locked.
  }
}

async function walk(dir: string, locked: boolean): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Children before the directory itself when locking, because a read-only
  // directory cannot have its children's modes changed afterwards; the reverse
  // when unlocking, for the same reason in the other direction.
  if (!locked) await chmod(dir, OPEN_DIR);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, locked);
    else await chmod(full, locked ? LOCKED_FILE : OPEN_FILE).catch(() => {});
  }
  if (locked) await chmod(dir, LOCKED_DIR).catch(() => {});
}

export class LocalSandbox implements SandboxBackend {
  readonly id = "local" as const;
  readonly enforcement = "permissions" as const;
  readonly #root: string;
  readonly #env: NodeExecutionEnv;
  #locked = false;
  /**
   * Nesting depth, so a commit inside a commit cannot re-lock the tree under
   * the outer one. Not a hypothetical: the seed and the first scene's commit
   * both go through here, and a future revision pass will nest.
   */
  #open = 0;

  constructor(root: string) {
    this.#root = path.resolve(root);
    this.#env = new NodeExecutionEnv({ cwd: this.#root });
  }

  readonly shell = {
    exec: async (
      command: string,
      options: { cwd?: string; timeoutMs?: number } = {},
    ): Promise<ExecResult> => {
      const result = await this.#env.exec(command, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      } as never);
      const value = (result as { value?: ExecResult }).value;
      if (value) return value;
      const error = (result as { error?: { message?: string } }).error;
      return { stdout: "", stderr: error?.message ?? "exec failed", exitCode: 1 };
    },
  };

  /** Lock the canonical tree. Call once the project exists. */
  async engage(): Promise<void> {
    await setMode(this.#root, true);
    this.#locked = true;
  }

  async withWriteAccess<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.#locked) return fn();
    this.#open += 1;
    if (this.#open === 1) await setMode(this.#root, false);
    try {
      return await fn();
    } finally {
      this.#open -= 1;
      if (this.#open === 0) await setMode(this.#root, true);
    }
  }

  async probe(): Promise<ProbeResult> {
    if (!this.#locked) {
      return { writeRefused: false, detail: "the tree was never locked" };
    }
    const target = path.join(this.#root, "world", ".gate-probe");
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "probe", "utf8");
      await rm(target, { force: true });
      return {
        writeRefused: false,
        detail: `wrote ${path.relative(this.#root, target)} while the gate was supposed to be shut`,
      };
    } catch (error) {
      const code = (error as { code?: string }).code ?? "unknown";
      return {
        writeRefused: true,
        detail: `writing world/.gate-probe failed with ${code}, as it should`,
      };
    }
  }

  async dispose(): Promise<void> {
    // Unlocked on the way out so the run's output is an ordinary directory
    // somebody can read, copy and delete without fighting it.
    if (this.#locked) await setMode(this.#root, false);
    this.#locked = false;
  }
}
