/**
 * Resident agents and the delegation tools that reach them.
 *
 * "Resident" is the load-bearing word. pi's own subagent example spawns a
 * throwaway process per delegation with `--no-session`, so each call meets the
 * book for the first time. Here each role owns **one long-lived `Agent`** whose
 * message history accumulates across invocations: the verifier remembers that
 * it already checked this character's eye colour twice, the writer keeps the
 * voice it established. Shared hands, isolated brains.
 *
 * What that costs is context growth, which is why compaction thresholds exist,
 * and why the index — not the transcript — remains the truth. A resident agent
 * whose session is trimmed must lose nothing that matters, because everything
 * that matters was written to a file.
 */

import {
  type CompactableMessage,
  type CompactionLevel,
  type CompactionThresholds,
  type Summariser,
  type StorySummaryInput,
  DEFAULT_THRESHOLDS,
  compactLevel1,
  compactLevel2,
  estimateTokens,
  levelFor,
} from "./compaction.ts";
import type { AgentRole } from "../transaction/types.ts";
import { type TokenBudget } from "../runtime/budget.ts";
import { type PersonaSpec, personaFor, systemPromptFor, toolNamesFor } from "./personas.ts";

/** One entry per model call, so a finished novel comes with its bill. */
export interface LedgerEntry {
  readonly role: AgentRole;
  readonly txid: string;
  readonly model: string;
  readonly at: string;
  readonly durationMs: number;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly reasoning: number;
    readonly total: number;
  };
  readonly toolCalls: number;
  readonly stopReason?: string;
  /**
   * Prompt size of the **last** model call in this turn — the transcript as the
   * provider last saw it.
   *
   * Not the same thing as `usage.input`, and the difference is why compaction
   * never fired correctly before. A turn with ten tool calls is eleven model
   * calls, and `usage.input` is their sum: in `runs/v1` one writer turn reports
   * 83,185 input tokens for a transcript that was never larger than about 15k.
   * Summing is right for the bill and wrong for the question compaction asks,
   * which is "how big is the context now".
   *
   * It also adds `cacheRead`, because a cached prompt token still occupies the
   * window. Under prompt caching most of the transcript arrives as `cacheRead`,
   * so a policy watching `input` alone would watch the small half.
   */
  readonly contextTokens: number;
}

export interface PiMessage {
  readonly role: string;
  readonly content: unknown;
  readonly usage?: Record<string, number>;
  readonly model?: string;
  readonly stopReason?: string;
  /** On a toolResult message these are top-level, not inside a content block. */
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

/** Minimal surface we need from a pi Agent; keeps the seam testable. */
export interface AgentLike {
  prompt(input: string): Promise<unknown>;
  readonly state: {
    messages: PiMessage[];
    /** Mutable on a pi Agent, which is what lets memory reach a live session. */
    systemPrompt?: string;
  };
  /** Present on a real pi Agent; the only way out of a hung request. */
  abort?(): void;
}

/**
 * A turn that stopped responding.
 *
 * Distinguished from every other failure because it is not the agent's fault
 * and tells us nothing about the story — but it must still be visible, since a
 * run that quietly waited an hour on one socket looks identical in the results
 * to a run that was merely slow.
 */
export class TurnTimeout extends Error {
  constructor(role: AgentRole, ms: number) {
    super(
      `${role} did not finish its turn within ${Math.round(ms / 1000)}s and was aborted. ` +
        `Median turns are around 45s and the slowest observed was 301s, so this is a stalled ` +
        `request rather than a slow one.`,
    );
    this.name = "TurnTimeout";
  }
}

/**
 * Ceiling on a single turn, tool loop included.
 *
 * Twice the slowest turn we have measured. Without it one stalled socket ends
 * the run: a 24k-word attempt sat on a single established connection for over
 * twenty minutes with no CPU, no output and no error, and would have sat there
 * indefinitely — at forty scenes that is not an edge case, it is a certainty.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 600_000;

export type AgentFactory = (
  persona: PersonaSpec,
  systemPrompt: string,
  toolNames: readonly string[],
) => AgentLike;

export interface CompactionRecord {
  readonly role: AgentRole;
  readonly level: CompactionLevel;
  readonly at: string;
  readonly inputTokens: number;
  readonly evicted: number;
  readonly summarised: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export interface CompactionConfig {
  readonly thresholds: CompactionThresholds;
  /**
   * Summarise with the agent's **own** model, over its own transcript.
   *
   * An earlier version routed this through the orchestrator, which is wrong
   * twice: the orchestrator would have to be handed the writer's transcript,
   * and the summary of a writer's session is a judgement about writing that the
   * writer is better placed to make. Each role compresses its own memory.
   */
  readonly summarise: (role: AgentRole, input: StorySummaryInput) => Promise<string> | string;
  /** Re-read per compaction: canon moves, and a stale digest misleads. */
  readonly context: () => Omit<StorySummaryInput, "folded">;
  /**
   * Called after each compaction.
   *
   * Compaction is the one thing in a run that changes what the agents can see
   * and leaves no trace in the prose, so a run that compacted silently is a run
   * whose behaviour cannot be explained afterwards.
   */
  readonly onCompaction?: (record: CompactionRecord) => void;
}

/**
 * Map a pi message onto what the policy needs.
 *
 * Verified against a real transcript (`smoke/message-shape.ts`), not inferred
 * from the type declarations — the first version of this function looked for
 * `toolCallId` inside a content block, where it is not. A tool result carries
 * `role: "toolResult"` with `toolCallId` and `toolName` at the **top level**;
 * only the assistant's `toolCall` block is nested, and its key is `id`.
 *
 * Getting that wrong is quiet in exactly the wrong way: eviction still happens,
 * but the pointer it leaves says `unknown (?)`, and being able to look again is
 * the entire reason eviction is safe.
 */
function toCompactable(m: PiMessage, sourceIndex: number): CompactableMessage {
  const blocks = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
  const text = blocks
    .map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b)))
    .join("\n");
  const isToolResult = m.role === "toolResult";
  return {
    role: m.role,
    kind: isToolResult ? "toolResult" : m.role === "user" ? "user" : "assistant",
    tokens: estimateTokens(text),
    text,
    sourceIndex,
    ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    ...(m.toolName ? { toolName: m.toolName } : {}),
    ...(isToolResult ? { digest: text.slice(0, 80).replace(/\s+/g, " ") } : {}),
  };
}

/** Put a compacted body back into the pi message it came from. */
function rewrite(original: PiMessage | undefined, m: CompactableMessage): PiMessage {
  if (!original) return { role: m.role, content: [{ type: "text", text: m.text }] };
  const blocks = Array.isArray(original.content) ? original.content : [];
  const unchanged =
    blocks.map((b) => (b as { text?: string }).text ?? "").join("\n") === m.text;
  if (unchanged) return original;
  return { ...original, content: [{ type: "text", text: m.text }] };
}

export class DelegationError extends Error {}

export class ResidentAgents {
  readonly #agents = new Map<AgentRole, AgentLike>();
  readonly #ledger: LedgerEntry[] = [];
  readonly #factory: AgentFactory;
  readonly #agentsRoot: string;
  readonly #personas: readonly PersonaSpec[];
  readonly #now: () => number;
  readonly #compaction: CompactionConfig | null;
  readonly #budget: TokenBudget | null;
  readonly #promptSuffix: ((role: AgentRole) => string) | null;
  readonly #turnTimeoutMs: number;
  readonly #transcriptSink:
    | ((
        role: AgentRole,
        messages: readonly PiMessage[],
        meta: { txid: string; durationMs: number },
      ) => Promise<void> | void)
    | null;
  readonly #compactions: CompactionRecord[] = [];
  /** Roles currently inside a compaction, so summarising cannot re-enter it. */
  readonly #compacting = new Set<AgentRole>();
  /** Message count already accounted for, per role, so usage is not double-counted. */
  readonly #accounted = new Map<AgentRole, number>();

  constructor(options: {
    readonly agentsRoot: string;
    readonly factory: AgentFactory;
    readonly personas?: readonly PersonaSpec[];
    readonly now?: () => number;
    /** Omit to disable compaction entirely, which is right for short runs. */
    readonly compaction?: CompactionConfig;
    /**
     * The per-task ceiling every system shares. Omitting it is only right for
     * unit tests; an experiment run without it is not comparable.
     */
    readonly budget?: TokenBudget;
    /**
     * Appended to every system prompt, and recomputed by `refreshSystemPrompt`.
     *
     * This is how memory reaches a resident agent. The alternative — pushing
     * the index in as a message — would put it at the top of a transcript that
     * compaction is about to fold, so the one thing designed to survive
     * compaction would be the thing compaction eats.
     */
    readonly promptSuffix?: (role: AgentRole) => string;
    /** Per turn, tool loop included. See `DEFAULT_TURN_TIMEOUT_MS`. */
    readonly turnTimeoutMs?: number;
    /**
     * Append a turn's raw messages to disk.
     *
     * The brief asked for this in as many words — *"他们的memory、原始对话也会落盘
     * 到index的合适位置"* — and its absence has already cost real time: working out
     * what the writer was actually told in a finished run required reconstructing
     * the packet from the plan and replaying canon forward, and that only works
     * because packet assembly happens to be deterministic. It says nothing about
     * what the model replied, which tools it tried first, or what a tool handed
     * back. Case analysis without transcripts is guesswork.
     *
     * Failures here are swallowed by the caller on purpose: losing a transcript
     * must never lose a scene.
     */
    readonly transcriptSink?: (
      role: AgentRole,
      messages: readonly PiMessage[],
      meta: { readonly txid: string; readonly durationMs: number },
    ) => Promise<void> | void;
  }) {
    this.#agentsRoot = options.agentsRoot;
    this.#factory = options.factory;
    this.#personas = options.personas ?? [];
    this.#now = options.now ?? (() => Date.now());
    this.#compaction = options.compaction ?? null;
    this.#budget = options.budget ?? null;
    this.#promptSuffix = options.promptSuffix ?? null;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.#transcriptSink = options.transcriptSink ?? null;
  }

  #persona(role: AgentRole): PersonaSpec {
    return this.#personas.find((p) => p.role === role) ?? personaFor(role);
  }

  #systemPrompt(role: AgentRole): string {
    const base = systemPromptFor(role, this.#agentsRoot);
    const suffix = this.#promptSuffix?.(role)?.trim();
    return suffix ? `${base}\n\n---\n\n${suffix}` : base;
  }

  /**
   * Recompose a live agent's system prompt.
   *
   * Called when its memory changes. A no-op for a role that has not been
   * invoked yet — it will compose the current suffix when it is created.
   */
  refreshSystemPrompt(role: AgentRole): void {
    const agent = this.#agents.get(role);
    if (agent) agent.state.systemPrompt = this.#systemPrompt(role);
  }

  /**
   * The agent for a role, created on first use and reused thereafter. Reuse is
   * the whole point: a fresh instance would be a fresh mind.
   */
  agent(role: AgentRole): AgentLike {
    let existing = this.#agents.get(role);
    if (!existing) {
      const persona = this.#persona(role);
      existing = this.#factory(persona, this.#systemPrompt(role), toolNamesFor(role));
      this.#agents.set(role, existing);
    }
    return existing;
  }

  /** True once the role has been invoked and is carrying history. */
  isResident(role: AgentRole): boolean {
    return this.#agents.has(role);
  }

  /**
   * Invoke a role and account for what it cost.
   *
   * The orchestrator calls this through the `call_*` tools; nothing else
   * should. Depth is enforced by the caller's allowlist, and again here.
   */
  async invoke(
    role: AgentRole,
    task: string,
    context: {
      readonly txid: string;
      readonly caller: AgentRole;
      /**
       * The orchestrator thinking, not delegating — planning the story, deciding
       * what to do with a rejected scene. Distinguished from delegation because
       * "the orchestrator cannot delegate to itself" is a real guard against an
       * unbounded call graph, and its own reasoning must not be caught by it.
       */
      readonly selfCall?: boolean;
    },
  ): Promise<{ readonly text: string; readonly ledger: LedgerEntry }> {
    if (context.caller !== "orchestrator") {
      throw new DelegationError(
        `${context.caller} may not delegate to ${role}: delegation depth is fixed at 1, ` +
          `specialists never call specialists`,
      );
    }
    if (role === "orchestrator" && !context.selfCall) {
      throw new DelegationError(
        "the orchestrator cannot delegate to itself; pass selfCall for its own reasoning",
      );
    }
    if (!task.trim()) {
      throw new DelegationError(`empty task sent to ${role}`);
    }

    const agent = this.agent(role);
    const before = agent.state.messages.length;
    const started = this.#now();
    const timedOut = await this.#promptWithDeadline(agent, task);
    const durationMs = this.#now() - started;

    const fresh = agent.state.messages.slice(before);
    // Accounted before the throw, deliberately: an aborted turn still spent
    // whatever it spent, and a ledger that omits the expensive failures makes
    // the run look cheaper than it was.
    const entry = this.#account(role, context.txid, fresh, durationMs, timedOut);
    // Written before the timeout throw: a stalled turn's partial transcript is
    // the most informative artefact a stalled turn produces.
    try {
      await this.#transcriptSink?.(role, fresh, { txid: context.txid, durationMs });
    } catch {
      // Losing a transcript must never lose a scene.
    }
    if (timedOut) {
      this.#budget?.charge(entry.usage.total);
      throw new TurnTimeout(role, this.#turnTimeoutMs);
    }
    const text = textOf(fresh);
    // Charge before compacting: the tokens were spent either way, and a run
    // that hides its spend behind a compaction step is not comparable.
    this.#budget?.charge(entry.usage.total);
    await this.#maybeCompact(role, agent, entry);
    return { text, ledger: entry };
  }

  /**
   * Run one turn under a deadline, returning whether the deadline won.
   *
   * `abort()` rather than abandoning the promise: an orphaned turn keeps
   * streaming into `state.messages`, so a later turn would find another
   * agent's half-finished reply appended to its own transcript.
   */
  async #promptWithDeadline(agent: AgentLike, task: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#turnTimeoutMs);
    });
    try {
      const outcome = await Promise.race([
        agent.prompt(task).then(() => "done" as const),
        deadline,
      ]);
      if (outcome === "done") return false;
      agent.abort?.();
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Compact after a turn, using the context size the provider just reported.
   *
   * The trigger is `entry.contextTokens` — the prompt size of the last model
   * call — rather than an estimate. Estimating is where compaction policies
   * usually go wrong, firing late on a long transcript and never at all on a
   * short one full of huge tool payloads. See `LedgerEntry.contextTokens` for
   * why it is not `usage.input`.
   *
   * Compaction runs *after* a turn rather than before the next one so a scene
   * never pauses on it, and so the ledger entry for the turn that crossed the
   * threshold records the size that triggered it.
   */
  async #maybeCompact(
    role: AgentRole,
    agent: AgentLike,
    entry: LedgerEntry,
  ): Promise<void> {
    if (!this.#compaction) return;
    // Summarising is itself a turn by this same agent, so without a guard the
    // first compaction recurses: summarise → invoke → still over threshold →
    // summarise. It never fired in `runs/v1` only because the old trigger was
    // never reached, which is exactly how a latent infinite loop survives.
    if (this.#compacting.has(role)) return;
    const used = entry.contextTokens;
    const level = levelFor(used, this.#compaction.thresholds);
    if (level === "none") return;

    this.#compacting.add(role);
    try {
      await this.#compact(role, agent, used, level);
    } finally {
      this.#compacting.delete(role);
    }
  }

  async #compact(
    role: AgentRole,
    agent: AgentLike,
    used: number,
    level: Exclude<CompactionLevel, "none">,
  ): Promise<void> {
    const compaction = this.#compaction!;
    const before = agent.state.messages;
    const compactable = before.map((m, i) => toCompactable(m, i));

    // Level 1 runs first at every level, including level 2 and block: folding a
    // transcript that still contains megabytes of grep output means paying a
    // model to summarise payloads that the index can hand back for free.
    const stage1 = compactLevel1(compactable, compaction.thresholds);
    const result =
      level === "level1"
        ? stage1
        : await compactLevel2(
            stage1.messages,
            (input) => compaction.summarise(role, input),
            compaction.context(),
            compaction.thresholds,
          );

    // Pair each survivor with the message it came from by its recorded index,
    // never by position: a level-2 fold replaces a run of messages with one
    // summary, after which position `i` in the result is a different message
    // than position `i` in the original.
    agent.state.messages = result.messages.map((m) =>
      m.kind === "summary"
        ? ({ role: "user", content: [{ type: "text", text: m.text }] } as PiMessage)
        : rewrite(m.sourceIndex === undefined ? undefined : before[m.sourceIndex], m),
    );

    const record: CompactionRecord = {
      role,
      level,
      at: new Date(this.#now()).toISOString(),
      inputTokens: used,
      evicted: result.evicted.length,
      summarised: result.summarised,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    };
    this.#compactions.push(record);
    compaction.onCompaction?.(record);
  }

  /** Every compaction, so a run can show what its agents stopped remembering. */
  compactions(): readonly CompactionRecord[] {
    return [...this.#compactions];
  }

  #account(
    role: AgentRole,
    txid: string,
    fresh: readonly AgentLike["state"]["messages"][number][],
    durationMs: number,
    timedOut = false,
  ): LedgerEntry {
    const usage = { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 };
    let toolCalls = 0;
    let model = this.#persona(role).model as string;
    let stopReason: string | undefined;
    let contextTokens = 0;

    for (const message of fresh) {
      if (message.usage) {
        usage.input += message.usage.input ?? 0;
        usage.output += message.usage.output ?? 0;
        usage.cacheRead += message.usage.cacheRead ?? 0;
        usage.reasoning += message.usage.reasoning ?? 0;
        usage.total += message.usage.totalTokens ?? 0;
        // Overwritten by each successive call, so what survives is the last.
        contextTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0);
      }
      if (message.model) model = message.model;
      if (message.stopReason) stopReason = message.stopReason;
      if (Array.isArray(message.content)) {
        toolCalls += message.content.filter(
          (c) => (c as { type?: string }).type === "toolCall",
        ).length;
      }
    }

    const entry: LedgerEntry = {
      role,
      txid,
      model,
      at: new Date(this.#now()).toISOString(),
      durationMs,
      usage,
      toolCalls,
      contextTokens,
      ...(timedOut ? { stopReason: "timeout" } : stopReason ? { stopReason } : {}),
    };
    this.#ledger.push(entry);
    this.#accounted.set(role, (this.#accounted.get(role) ?? 0) + fresh.length);
    return entry;
  }

  /**
   * Every call so far. A run is not complete unless this is on disk — including
   * a run that failed, because an aborted run with a ledger teaches us
   * something and one without teaches us nothing.
   */
  ledger(): readonly LedgerEntry[] {
    return [...this.#ledger];
  }

  /** Per-role and per-model roll-up for the run summary. */
  rollUp(): Record<string, { calls: number; tokens: number; ms: number }> {
    const out: Record<string, { calls: number; tokens: number; ms: number }> = {};
    for (const e of this.#ledger) {
      const key = `${e.role}:${e.model}`;
      const row = (out[key] ??= { calls: 0, tokens: 0, ms: 0 });
      row.calls += 1;
      row.tokens += e.usage.total;
      row.ms += e.durationMs;
    }
    return out;
  }
}

function textOf(messages: readonly AgentLike["state"]["messages"][number][]): string {
  return messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => (c as { type?: string }).type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n")
    .trim();
}
