/**
 * `run_command` and its guardrails.
 *
 * The architecture gives every agent a shell instead of a hand-designed read
 * tool per index partition, because agents already know grep and a shell adapts
 * to layouts we have not thought of yet. The cost of that generality is that a
 * single careless command can wreck the run: `grep -r . index/` returns the
 * whole novel, and the reply lands in the conversation, not in a file.
 *
 * That failure is quiet and expensive. A 50k-token tool result does not error —
 * it displaces the context packet, trips compaction, and the writer then drafts
 * from a summary of its own canon instead of the canon. So the read path needs
 * three limits, and it needs to *say* when it hits them: a truncated result that
 * looks complete is worse than a refusal.
 */

import { ToolRefusal } from "./registry.ts";

export interface ShellLimits {
  /** Characters returned inline. Beyond this the payload is spilled to a file. */
  readonly maxInlineChars: number;
  readonly timeoutMs: number;
  /** Calls allowed per transaction, per agent. */
  readonly maxCallsPerTransaction: number;
}

/**
 * Defaults sized against the packet budget, not against what a terminal can
 * print. Packets target 40–70k words, so a read that returns more than a few
 * thousand characters inline is competing with the material the scene actually
 * needs.
 */
export const DEFAULT_SHELL_LIMITS: ShellLimits = {
  maxInlineChars: 8_000,
  timeoutMs: 30_000,
  maxCallsPerTransaction: 40,
};

/** Commands refused outright, with the reason the agent should read. */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /(^|[\s;|&])(rm|mv|truncate|dd|shred)\s/,
    why: "canonical state changes only through the commit path, never through the shell",
  },
  {
    pattern: />>?\s*\S/,
    why: "shell redirection writes files; use the typed write tools so the change is validated and attributed",
  },
  {
    pattern: /(^|[\s;|&])(tee|sed\s+-i|python|node|sh|bash)\s/,
    why: "the shell here is for reading the index; running an interpreter escapes every check",
  },
  {
    pattern: /(^|[\s;|&])(curl|wget|nc|ssh|scp)\s/,
    why: "no network from the read path: a run must be reproducible from the index alone",
  },
  {
    pattern: /(^|[\s;|&])git\s+(commit|push|checkout|reset|clean)/,
    why: "run provenance depends on the engine owning every commit",
  },
  {
    pattern: /runtime\/transcripts/,
    why:
      "transcripts are another agent's private session, not canon. Asked to find " +
      "material with no outline on disk, a context-builder once read the orchestrator's " +
      "transcript and cited it as provenance for the cast — resourceful, and wrong twice: " +
      "a transcript records what was said rather than what is true, and it is nobody's " +
      "source of truth but its own author's. Whatever you are looking for belongs in the " +
      "index; if it is not there, that absence is the finding",
  },
];

export interface ShellRequest {
  readonly command: string;
  /** Why the agent is running it; recorded in the ledger, not optional. */
  readonly purpose: string;
}

export interface ShellOutcome {
  readonly exitCode: number;
  /** What the caller sees, already truncated if it had to be. */
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  /** Set when the payload was spilled, so the caller can re-read it on demand. */
  readonly artifactPath?: string;
  readonly durationMs: number;
}

export type ShellExecutor = (
  command: string,
  timeoutMs: number,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Where a spilled payload goes, so the caller can fetch it deliberately. */
export type ArtifactSink = (payload: string) => Promise<string> | string;

export class GuardedShell {
  readonly #limits: ShellLimits;
  readonly #execute: ShellExecutor;
  readonly #spill: ArtifactSink;
  readonly #calls = new Map<string, number>();
  readonly #now: () => number;

  constructor(options: {
    readonly execute: ShellExecutor;
    readonly spill: ArtifactSink;
    readonly limits?: Partial<ShellLimits>;
    readonly now?: () => number;
  }) {
    this.#limits = { ...DEFAULT_SHELL_LIMITS, ...options.limits };
    this.#execute = options.execute;
    this.#spill = options.spill;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Why a command would be refused, or null. Separate from running it so the
   * reason can be shown in a prompt and asserted in a test.
   */
  refusalReason(request: ShellRequest, budgetKey: string): string | null {
    if (!request.command.trim()) return "command is empty";
    if (!request.purpose.trim()) {
      // The ledger has to be able to answer "why did this run read that", and
      // asking after the fact never works.
      return "purpose is required: say why this read is needed";
    }
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(request.command)) {
        return `refused: ${why} (matched ${pattern.source})`;
      }
    }
    const used = this.#calls.get(budgetKey) ?? 0;
    if (used >= this.#limits.maxCallsPerTransaction) {
      return `shell budget exhausted for this transaction (${this.#limits.maxCallsPerTransaction} calls)`;
    }
    return null;
  }

  async run(request: ShellRequest, budgetKey: string): Promise<ShellOutcome> {
    const reason = this.refusalReason(request, budgetKey);
    if (reason !== null) throw new ToolRefusal(reason);

    this.#calls.set(budgetKey, (this.#calls.get(budgetKey) ?? 0) + 1);
    const started = this.#now();
    const raw = await this.#execute(request.command, this.#limits.timeoutMs);
    const durationMs = this.#now() - started;

    if (raw.stdout.length <= this.#limits.maxInlineChars) {
      return { ...raw, truncated: false, durationMs };
    }

    // Spill rather than silently cut: the head alone reads as a complete answer
    // and an agent will draw conclusions from it.
    const artifactPath = await this.#spill(raw.stdout);
    const head = raw.stdout.slice(0, this.#limits.maxInlineChars);
    return {
      exitCode: raw.exitCode,
      stdout:
        `${head}\n\n[truncated: ${raw.stdout.length} chars total, first ` +
        `${this.#limits.maxInlineChars} shown. Full output at ${artifactPath}. ` +
        `Narrow the command instead of reading the whole file.]`,
      stderr: raw.stderr,
      truncated: true,
      artifactPath,
      durationMs,
    };
  }

  callsUsed(budgetKey: string): number {
    return this.#calls.get(budgetKey) ?? 0;
  }
}
