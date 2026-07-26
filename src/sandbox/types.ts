/**
 * The write gate, enforced by something other than a prompt.
 *
 * The agents are not adversarial, so this is not about security. Its value is
 * what the guarantee rests on. "Only index-manager writes canonical state" has
 * been true of every run so far because the other four were *told* not to and
 * because no write tool was registered for them — which is a real argument, and
 * a weaker one than it sounds, since the one tool they do have is a shell.
 * `echo x > characters/char-mira/profile.yaml` was refused by a regular
 * expression in our own policy layer. A regular expression is a claim about the
 * commands we thought of.
 *
 * With a backend the same command fails at the operating system, and the
 * difference is not cosmetic: it turns "we instructed the agents not to" into
 * "the agents could not", which is the form of the claim the paper needs.
 *
 * ## Why `probe` exists
 *
 * A guarantee nobody checks is a comment. Every backend must demonstrate its own
 * gate at startup by attempting a forbidden write and reporting what happened,
 * and the result goes in the run summary. That way a run states what it enforced
 * rather than what it intended — and a misconfigured mount is caught in the
 * second before the run rather than inferred from a corrupted index afterwards.
 *
 * ## The agent loop stays outside the sandbox
 *
 * A design constraint that holds for every backend. Each command enters, runs
 * for seconds and returns, so nothing long-lived depends on one sandbox session
 * staying up and we never pay for a container idling on gateway latency. It also
 * puts `CanonicalIndex.commit` on the *outside*, in the harness process, which
 * is exactly where the one actor allowed to write should live.
 */

/** Which backend a run used. Recorded, never inferred. */
export type SandboxId = "none" | "local" | "docker";

/**
 * How a forbidden write actually fails.
 *
 * Ordered by strength, and worth distinguishing in the summary because they are
 * three genuinely different claims:
 *
 * - `prompt` — we asked the agent not to, and our policy layer refuses the
 *   commands we anticipated.
 * - `permissions` — the filesystem refuses the write. Same user, so an agent
 *   that thought to `chmod` could undo it; our policy refuses `chmod`, which
 *   makes this belt-and-braces rather than airtight.
 * - `mount` — the canonical tree is mounted read-only into the process that
 *   runs the command. Nothing the command does can write to it.
 */
export type Enforcement = "prompt" | "permissions" | "mount";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * The subset of pi's `ExecutionEnv` a backend has to supply.
 *
 * Only `exec` differs between backends. Reads are deliberately left alone:
 * every role is supposed to see the whole tree, so gating them would break the
 * uniform-read-reach guarantee to solve a problem nobody has.
 */
export interface SandboxShell {
  exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
}

export interface ProbeResult {
  /** True when a write to canonical state was actually refused. */
  readonly writeRefused: boolean;
  /** What happened, in the operating system's own words where possible. */
  readonly detail: string;
}

export interface SandboxBackend {
  readonly id: SandboxId;
  readonly enforcement: Enforcement;
  /** Run one command with the project visible and canonical state protected. */
  readonly shell: SandboxShell;
  /**
   * Open the canonical tree for the duration of a commit, then close it.
   *
   * Only `CanonicalIndex.commit` and the initial seed belong in here. Anything
   * else inside this window is a write that bypassed the gate and did so in the
   * one place designed to look legitimate.
   */
  withWriteAccess<T>(fn: () => Promise<T>): Promise<T>;
  /** Attempt a forbidden write and report what stopped it. */
  probe(): Promise<ProbeResult>;
  dispose(): Promise<void>;
}

/**
 * Directories holding canonical state.
 *
 * Everything else under the project root is writable by design: `staging/` is
 * the transaction workspace, `runtime/` is the ledger and transcripts, and each
 * `.<role>/` is that role's own memory, skills and working artefacts. The
 * harness contract already draws this line in words — this is the same line,
 * drawn where the operating system can see it.
 */
export const CANONICAL_PARTITIONS: readonly string[] = [
  "novel",
  "characters",
  "relations",
  "locations",
  "objects",
  "factions",
  "events",
  "world",
  "continuity",
  "_schemas",
  "config",
];
