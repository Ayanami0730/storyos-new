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

import { Agent } from "@earendil-works/pi-agent-core";

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
import { type ModelId, installGateway } from "../runtime/gateway.ts";
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
}

export interface PiMessage {
  readonly role: string;
  readonly content: unknown;
  readonly usage?: Record<string, number>;
  readonly model?: string;
  readonly stopReason?: string;
}

/** Minimal surface we need from a pi Agent; keeps the seam testable. */
export interface AgentLike {
  prompt(input: string): Promise<unknown>;
  readonly state: {
    messages: PiMessage[];
  };
}

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
  readonly summarise: Summariser;
  /** Re-read per compaction: canon moves, and a stale digest misleads. */
  readonly context: () => Omit<StorySummaryInput, "folded">;
}

/**
 * Map a pi message onto what the policy needs.
 *
 * Tool results are the ones worth identifying precisely, because they are the
 * only thing level 1 may evict — everything else is either pinned or folded.
 */
function toCompactable(m: PiMessage): CompactableMessage {
  const blocks = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
  const text = blocks
    .map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b)))
    .join("\n");
  const isToolResult = m.role === "toolResult" || blocks.some((b) => b.type === "toolResult");
  const toolCall = blocks.find((b) => b.type === "toolCall") as
    | { toolCallId?: string; name?: string }
    | undefined;
  return {
    role: m.role,
    kind: isToolResult ? "toolResult" : m.role === "user" ? "user" : "assistant",
    tokens: estimateTokens(text),
    text,
    ...(toolCall?.toolCallId ? { toolCallId: toolCall.toolCallId } : {}),
    ...(toolCall?.name ? { toolName: toolCall.name } : {}),
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
  readonly #compactions: CompactionRecord[] = [];
  /** Message count already accounted for, per role, so usage is not double-counted. */
  readonly #accounted = new Map<AgentRole, number>();

  constructor(options: {
    readonly agentsRoot: string;
    readonly factory: AgentFactory;
    readonly personas?: readonly PersonaSpec[];
    readonly now?: () => number;
    /** Omit to disable compaction entirely, which is right for short runs. */
    readonly compaction?: CompactionConfig;
  }) {
    this.#agentsRoot = options.agentsRoot;
    this.#factory = options.factory;
    this.#personas = options.personas ?? [];
    this.#now = options.now ?? (() => Date.now());
    this.#compaction = options.compaction ?? null;
  }

  #persona(role: AgentRole): PersonaSpec {
    return this.#personas.find((p) => p.role === role) ?? personaFor(role);
  }

  /**
   * The agent for a role, created on first use and reused thereafter. Reuse is
   * the whole point: a fresh instance would be a fresh mind.
   */
  agent(role: AgentRole): AgentLike {
    let existing = this.#agents.get(role);
    if (!existing) {
      const persona = this.#persona(role);
      existing = this.#factory(
        persona,
        systemPromptFor(role, this.#agentsRoot),
        toolNamesFor(role),
      );
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
    await agent.prompt(task);
    const durationMs = this.#now() - started;

    const fresh = agent.state.messages.slice(before);
    const entry = this.#account(role, context.txid, fresh, durationMs);
    const text = textOf(fresh);
    await this.#maybeCompact(role, agent, entry);
    return { text, ledger: entry };
  }

  /**
   * Compact after a turn, using the context size the provider just reported.
   *
   * `usage.input` is what the model actually received, so there is no reason to
   * estimate it — and estimating is where compaction policies usually go wrong,
   * firing late on a long transcript and never at all on a short one full of
   * huge tool payloads.
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
    const used = entry.usage.input;
    const level = levelFor(used, this.#compaction.thresholds);
    if (level === "none") return;

    const before = agent.state.messages;
    const compactable = before.map((m) => toCompactable(m));

    let result =
      level === "level1"
        ? compactLevel1(compactable, this.#compaction.thresholds)
        : await compactLevel2(
            compactLevel1(compactable, this.#compaction.thresholds).messages,
            this.#compaction.summarise,
            this.#compaction.context(),
            this.#compaction.thresholds,
          );

    // Level 2 subsumes level 1: at that pressure, evicting payloads first means
    // the summary is written over pointers instead of over megabytes of grep.
    if (level === "block") {
      result = await compactLevel2(
        compactLevel1(compactable, this.#compaction.thresholds).messages,
        this.#compaction.summarise,
        this.#compaction.context(),
        this.#compaction.thresholds,
      );
    }

    agent.state.messages = result.messages.map((m, i) =>
      m.kind === "summary"
        ? ({ role: "user", content: [{ type: "text", text: m.text }] } as PiMessage)
        : rewrite(before[i], m),
    );

    this.#compactions.push({
      role,
      level,
      at: new Date(this.#now()).toISOString(),
      inputTokens: used,
      evicted: result.evicted.length,
      summarised: result.summarised,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    });
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
  ): LedgerEntry {
    const usage = { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 };
    let toolCalls = 0;
    let model = this.#persona(role).model as string;
    let stopReason: string | undefined;

    for (const message of fresh) {
      if (message.usage) {
        usage.input += message.usage.input ?? 0;
        usage.output += message.usage.output ?? 0;
        usage.cacheRead += message.usage.cacheRead ?? 0;
        usage.reasoning += message.usage.reasoning ?? 0;
        usage.total += message.usage.totalTokens ?? 0;
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
      ...(stopReason ? { stopReason } : {}),
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

/**
 * The `call_*` tools, defined here rather than sketched in a diagram.
 *
 * They were the least specified part of the architecture and they are the
 * system's main artery: everything except the orchestrator's own reasoning
 * flows through them. `txid` is required on every call because a delegation
 * that is not attributable to a transaction cannot be billed, replayed, or
 * blamed.
 */
export interface DelegationCall {
  readonly txid: string;
  /** What the callee is being asked to do, in full. */
  readonly task: string;
}

export const DELEGATION_TARGETS: readonly AgentRole[] = [
  "context-builder",
  "writer",
  "verifier",
  "index-manager",
];

export function delegationToolName(role: AgentRole): string {
  return `call_${role.replace(/-/g, "_")}`;
}

export function delegationTools(residents: ResidentAgents) {
  return DELEGATION_TARGETS.map((role) => ({
    name: delegationToolName(role),
    description: `Delegate to the resident ${role}. It keeps its own session, so refer to earlier work rather than restating it.`,
    validate: (args: DelegationCall) => {
      const errors: { path: string; problem: string }[] = [];
      if (!args?.txid?.trim()) {
        errors.push({
          path: "txid",
          problem: "required: a delegation outside a transaction cannot be billed or replayed",
        });
      }
      if (!args?.task?.trim()) {
        errors.push({ path: "task", problem: "required: say what the callee should do" });
      }
      return errors;
    },
    run: async (args: DelegationCall) =>
      (await residents.invoke(role, args.task, { txid: args.txid, caller: "orchestrator" }))
        .text,
  }));
}

/** Build a real pi-backed factory. Kept apart so tests never touch the network. */
export function piAgentFactory(
  buildTools: (role: AgentRole, names: readonly string[]) => unknown[],
): AgentFactory {
  const gateway = installGateway();
  return (persona, systemPrompt, toolNames) => {
    return new (Agent as unknown as new (init: unknown) => AgentLike)({
      initialState: {
        systemPrompt,
        model: gateway.model(persona.model as ModelId),
        thinkingLevel: "off",
        tools: buildTools(persona.role, toolNames),
      },
    });
  };
}
