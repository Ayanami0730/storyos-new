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
  evictablePayloadTokens,
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
    /** Everything the provider reported, `cacheRead` included. */
    readonly total: number;
    /**
     * `input + output` — what the baselines count, and therefore what the
     * budget must charge.
     *
     * The distinction is not pedantic; it was costing us most of every run. pi's
     * `totalTokens` includes `cacheRead`, and under prompt caching that is the
     * overwhelming majority of it: on a measured run, 7,490,529 of 8,369,537
     * reported tokens — **89.5%** — were cache reads, against 879,008 of fresh
     * input and output. Charging the budget with `total` therefore stopped our
     * runs after roughly a ninth of the work the baselines are allowed, because
     * every baseline counts `input_tokens + output_tokens` and nothing else
     * (`run_lbw.py`: `self.used_tokens += input_tokens + output_tokens`).
     *
     * Both numbers are kept. `total` is what the provider says the call was;
     * `billable` is what a comparison may use.
     */
    readonly billable: number;
  };
  readonly toolCalls: number;
  readonly stopReason?: string;
  /** The provider's own words when the call failed, so a bad run says why. */
  readonly errorMessage?: string;
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
  /**
   * Set by pi when the provider call failed.
   *
   * pi does not throw on a provider error. It appends an assistant message with
   * empty content, zero usage and `stopReason: "error"`, and the loop carries
   * on. For most callers that is a reasonable choice; for us it was a hole
   * straight through the gate, because our verifier reports defects by calling a
   * tool and a call that never happened is indistinguishable from a clean scene.
   */
  readonly errorMessage?: string;
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
        (role === "orchestrator"
          ? `An orchestrator turn nests the specialists' turns, so this ceiling is far above ` +
            `any legitimate scene — reaching it means it was looping, not working.`
          : `The slowest legitimate turn observed is 527s, so this is a stalled request ` +
            `rather than a slow one.`),
    );
    this.name = "TurnTimeout";
  }
}

/**
 * Ceiling on a specialist's turn, tool loop included.
 *
 * Without one, a stalled socket ends the run: a 24k-word attempt sat on a single
 * established connection for over twenty minutes with no CPU, no output and no
 * error, and would have sat there indefinitely — at forty scenes that is not an
 * edge case, it is a certainty.
 *
 * Raised from 600s on 2026-07-26 because the measurement it was calibrated
 * against had moved. It was set at twice the slowest turn then observed (301s);
 * the slowest since is a 527s verifier turn, which left 14% of headroom on a
 * legitimate turn. The gateway's own 300s per-request timeout is what catches a
 * dead socket now, so this is the backstop for a turn that keeps making calls
 * without finishing rather than the first line of defence.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 900_000;

/**
 * Ceiling on the orchestrator's turn.
 *
 * Much larger, and not because the orchestrator is slower. Its turn is a
 * *supervisor* turn: a single `call_verifier` blocks for a whole verifier turn,
 * and driving one scene nests a build, a draft, a review and a commit, plus two
 * more draft-and-review pairs if the repair budget is spent. At the slowest
 * turns we have measured that is around 2,000s of legitimate work, all of it
 * already guarded turn by turn underneath.
 *
 * So this number is not protecting against a hang — the children are. It is
 * protecting against an orchestrator that has started looping, and it is set
 * where a scene that is merely slow can never reach it.
 */
export const ORCHESTRATOR_TURN_TIMEOUT_MS = 5_400_000;

/** The ceiling for a role. */
export function defaultTurnTimeoutFor(role: AgentRole): number {
  return role === "orchestrator" ? ORCHESTRATOR_TURN_TIMEOUT_MS : DEFAULT_TURN_TIMEOUT_MS;
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

/**
 * Put a compacted body back into the pi message it came from.
 *
 * Only messages the policy actually evicted are rewritten; everything else is
 * returned untouched, by identity. The previous version worked out whether a
 * message had changed by joining its blocks' `.text` and comparing with the
 * compacted text — and a `toolCall` block has no `.text`, so an assistant
 * message that made a tool call never compared equal to itself. Every one of
 * them was flattened into a plain text block, which deleted the `tool_calls`
 * the following tool results were answers to, and the provider rejected the
 * next request outright:
 *
 *   400 messages with role 'tool' must be a response to a preceding message
 *       with 'tool_calls'
 *
 * The lesson is narrower than "compare more carefully": a transform should say
 * what it changed rather than leave the caller to detect it, because the caller
 * can only detect it through a representation that has already lost the detail
 * that mattered.
 */
function rewrite(original: PiMessage | undefined, m: CompactableMessage): PiMessage {
  if (!original) return { role: m.role, content: [{ type: "text", text: m.text }] };
  if (!m.evicted) return original;
  return { ...original, content: [{ type: "text", text: m.text }] };
}

export class DelegationError extends Error {}

/**
 * The provider refused or failed, and retrying did not help.
 *
 * Thrown rather than returned because the alternative is what we had: pi
 * records a failed call as an empty assistant message with `stopReason:
 * "error"` and the loop continues, so a rate-limited verifier looks exactly
 * like a verifier that found nothing. Measured on the first orchestrator-driven
 * run — every `gemini-3.1-pro-preview` call came back
 * `429 channel:model_rate_limited`, every scene was recorded APPROVED with zero
 * findings, and nothing anywhere said the gate had not run.
 */
export class TurnFailed extends Error {
  readonly attempts: number;
  constructor(role: AgentRole, detail: string, attempts: number) {
    super(`${role}'s turn failed after ${attempts} attempt(s): ${detail}`);
    this.name = "TurnFailed";
    this.attempts = attempts;
  }
}

/**
 * Worth trying again, or not.
 *
 * Rate limits and transient server errors are the retryable ones and they are
 * also the common ones: a cross-family verifier shares a gateway quota with
 * everything else on it, so 429 is a scheduling accident rather than a
 * statement about the request. A 400 or a 404 will fail identically forever and
 * retrying only spends the budget slower.
 */
export function isRetryableTurnError(message: string): boolean {
  return (
    /\b(429|5\d\d)\b|rate.?limit|rate_limit|too_many_requests|resource exhausted|负载已饱和|overloaded|time(?:d)?[\s_-]*out|terminated|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
      message,
    ) ||
    isTruncatedStream(message) ||
    isMisroutedAuth(message)
  );
}

/**
 * A 401 that is about the gateway's routing, not about our key.
 *
 * This one cost two 40,000-word runs a third of their length. Both reported
 * `exit 0` at 28,186 and 27,427 words — attainment 0.70 — because the writer hit
 *
 *     401: Access denied due to invalid subscription key or wrong API endpoint.
 *
 * at s-021 and s-023, spent all six of the scene's attempts on it (one API
 * attempt each, since 401 was not retryable), and every later scene aborted.
 *
 * The key was fine. The proof is that a third run was writing through the same
 * window on the same key: it absorbed **110** of these 401s and was still
 * producing scenes eleven hours later, against 124 and 113 in the two that died.
 * The gateway fans requests across upstream partitions and a mis-keyed partition
 * answers 401, so which run dies is a question of which partition it drew — a
 * scheduling accident, which is the classifier's existing argument for retrying
 * a 429, unchanged.
 *
 * Deliberately narrow. A genuinely revoked key produces this same status, and
 * then every call spends six attempts before failing instead of one. That is the
 * bounded, cheap side of the trade: an expired key fails the run either way, a
 * few minutes later, while a misrouted partition currently truncates a
 * five-hour manuscript and calls it a success.
 */
function isMisroutedAuth(message: string): boolean {
  return /\b401\b/.test(message) && /invalid subscription key|wrong API endpoint/i.test(message);
}

/**
 * A response stream that was cut mid-JSON.
 *
 * Measured on `runs-070/lbw092` s-001: the orchestrator's turn died with
 * `Expected ':' after property name in JSON at position 74`, and the log above it
 * shows why — a server-sent chunk that ends inside an object:
 *
 *     Could not parse message into JSON: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"01"},"index"
 *
 * That is a transport accident of exactly the same kind as a socket hang-up, and it
 * was not retried: `TurnFailed after 1 attempt(s)`, on the first scene of the run.
 * Nothing about the request was wrong, so the classifier's own argument for
 * retrying a 429 — "a scheduling accident rather than a statement about the
 * request" — applies unchanged.
 *
 * The risk of matching too widely is a model that emits malformed tool arguments
 * every time, which would spend six attempts instead of one. That is bounded and
 * cheap next to what happens otherwise: a lost orchestrator turn on a scene whose
 * transaction is mid-flight.
 *
 * `Stream ended without finish_reason` is the same accident with none of the JSON
 * wording, and it was not covered: measured on `lnbcustom-horror-molka-ch24`,
 * whose planning turn spent thirty-one minutes — six request-level attempts — and
 * then died `TurnFailed after 1 attempt(s)`, because the turn-level classifier
 * did not recognise the message. A stream that closes without saying why it
 * stopped is a transport failure by definition; there is no request that could
 * be phrased differently to avoid it.
 */
function isTruncatedStream(message: string): boolean {
  return /(?:Expected .*after property name|Unexpected end of JSON input|Unterminated string in JSON|Unexpected (?:token|non-whitespace character).*JSON|is not valid JSON|Could not parse message into JSON|Stream ended without finish_reason)/i.test(
    message,
  );
}

/**
 * Backoff between retries.
 *
 * Seconds rather than milliseconds because the thing being waited out is a
 * provider's quota window, and a retry 200ms after a 429 is just a second 429.
 *
 * Six attempts rather than four, and that number comes from a measurement. When
 * the cross-family verifier's channel was being rate-limited, probing it
 * directly returned `200, 429, 429` — the model was up and the shared quota was
 * simply contended, roughly one request in three getting through. Against odds
 * like that, four attempts is not persistence, it is a coin flip: it fails
 * about one time in five, and it failed on the first scene of the run that
 * prompted this. Six takes that to roughly one in eleven.
 *
 * The lesson generalises past this incident. A contended shared quota wants
 * *more attempts*, where a genuinely exhausted one wants *longer waits*, and
 * only one of those can be read off an error code — so the schedule does both
 * and lets the cheap case exit early.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [
  5_000, 15_000, 30_000, 60_000, 90_000, 120_000,
];

/**
 * Jitter, so concurrent agents do not retry in lockstep.
 *
 * Without it, two roles that hit the same quota window at the same moment wake
 * together and collide again on every attempt, turning a shared limit into a
 * synchronised one.
 */
export function withJitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

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
  readonly #turnTimeoutFor: (role: AgentRole) => number;
  readonly #transcriptSink:
    | ((
        role: AgentRole,
        messages: readonly PiMessage[],
        meta: { txid: string; durationMs: number },
      ) => Promise<void> | void)
    | null;
  readonly #compactions: CompactionRecord[] = [];
  readonly #retryBackoffMs: readonly number[];
  readonly #onRetry:
    | ((event: {
        readonly role: AgentRole;
        readonly attempt: number;
        readonly waitMs: number;
        readonly detail: string;
      }) => void)
    | null;
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
    /**
     * Per turn, tool loop included. A number applies to every role; a function
     * lets the orchestrator have the larger ceiling its nested turns need. See
     * `defaultTurnTimeoutFor`.
     */
    readonly turnTimeoutMs?: number | ((role: AgentRole) => number);
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
    /**
     * Called before each backoff wait.
     *
     * A run that quietly slept ninety seconds per scene waiting out a quota is
     * indistinguishable in the log from a run that was merely slow, and the two
     * call for completely different responses.
     */
    readonly onRetry?: (event: {
      readonly role: AgentRole;
      readonly attempt: number;
      readonly waitMs: number;
      readonly detail: string;
    }) => void;
    /**
     * Waits between retries. Overridden only by tests — the defaults are a
     * policy about a provider's quota window, and a unit test should assert the
     * retry happened rather than sit through eighty-five seconds of it.
     */
    readonly retryBackoffMs?: readonly number[];
  }) {
    this.#agentsRoot = options.agentsRoot;
    this.#factory = options.factory;
    this.#personas = options.personas ?? [];
    this.#now = options.now ?? (() => Date.now());
    this.#compaction = options.compaction ?? null;
    this.#budget = options.budget ?? null;
    this.#promptSuffix = options.promptSuffix ?? null;
    const timeout = options.turnTimeoutMs;
    this.#turnTimeoutFor =
      typeof timeout === "function"
        ? timeout
        : typeof timeout === "number"
          ? () => timeout
          : defaultTurnTimeoutFor;
    this.#transcriptSink = options.transcriptSink ?? null;
    this.#onRetry = options.onRetry ?? null;
    this.#retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
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
   * Drop a role's accumulated conversation, keeping the agent itself.
   *
   * Residency is the default and it is most of what makes these agents useful: an
   * agent that has read forty scenes answers differently from one meeting the book
   * for the first time. But residency is paid for by re-sending the whole history
   * on every request, and whether that is affordable depends entirely on whether
   * the provider gives us prompt caching.
   *
   * For the cross-family verifier it does not. Measured on `lbw081`:
   * `gemini-3.1-pro-preview` returned **zero** cache reads across every call of
   * every scene, while `gpt-5-mini` roles ran 60–84% cached. So the verifier's
   * first-call input grew 10k → 25k → 41k → 62k tokens across four scenes, each
   * re-sent in full at eight times the input rate, and the verifier ended up
   * **81% of the run's cost on 11% of its round-trips**. At novel length that
   * grows quadratically — scene count times history length — which is the specific
   * reason a 20k-word target was out of reach.
   *
   * What the verifier loses by forgetting is small and testable: its job is
   * per-scene, cross-scene facts come from the index it can read, and its durable
   * lessons live in memory files that survive this. The run records which scope
   * was used so "does verifier residency buy anything" stays answerable.
   */
  resetSession(role: AgentRole): void {
    const agent = this.#agents.get(role);
    if (agent) agent.state.messages = [];
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
   * The model each role will actually run on, read from the effective persona.
   *
   * Reported per run because the backbone is the one setting that has to be held
   * constant across every system in the comparison, and the project has already
   * published a margin that mixed an architectural effect with a stronger model
   * in one role. A summary that names all five is checkable against the roll-up;
   * a sentence claiming "gpt-5-mini for every role" is not, and was wrong for two
   * versions while nobody could see it.
   */
  models(): Readonly<Record<string, string>> {
    const roles: readonly AgentRole[] = [
      "orchestrator",
      "context-builder",
      "writer",
      "verifier",
      "index-manager",
    ];
    return Object.fromEntries(roles.map((role) => [role, this.#persona(role).model]));
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
    // Before the call, not after it. `charge` can only notice an overrun once
    // the tokens are gone; this is what makes the stop hard.
    this.#budget?.assertNotExhausted();

    const agent = this.agent(role);
    const before = agent.state.messages.length;
    const started = this.#now();
    const deadlineMs = this.#turnTimeoutFor(role);

    /**
     * Retry a provider failure, rewinding the transcript first.
     *
     * The rewind matters. pi has already appended the user message and the
     * failed assistant reply, so re-prompting without truncating would leave the
     * agent's own history holding a question it appears to have answered with
     * silence — twice, three times — and a resident agent carries that
     * impression into every later scene.
     */
    let timedOut = false;
    let failure: string | null = null;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      agent.state.messages = agent.state.messages.slice(0, before);
      timedOut = await this.#promptWithDeadline(agent, task, deadlineMs);
      failure = timedOut ? null : providerFailure(agent.state.messages.slice(before));
      if (!failure) break;
      const scheduled = this.#retryBackoffMs[attempts - 1];
      if (scheduled === undefined || !isRetryableTurnError(failure)) break;
      const wait = scheduled > 0 ? withJitter(scheduled) : 0;
      this.#onRetry?.({ role, attempt: attempts, waitMs: wait, detail: failure });
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

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
      this.#budget?.charge(entry.usage.billable);
      throw new TurnTimeout(role, deadlineMs);
    }
    if (failure) {
      // Raised rather than returned. A caller handed an empty turn cannot tell
      // it apart from a turn that had nothing to say, and for the verifier those
      // two readings differ by the whole quality gate.
      this.#budget?.charge(entry.usage.billable);
      throw new TurnFailed(role, failure, attempts);
    }
    const text = textOf(fresh);
    // Charge before compacting: the tokens were spent either way, and a run
    // that hides its spend behind a compaction step is not comparable.
    this.#budget?.charge(entry.usage.billable);
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
  async #promptWithDeadline(
    agent: AgentLike,
    task: string,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
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
    let level = levelFor(used, this.#compaction.thresholds);

    if (level === "none") {
      // The overflow thresholds ask whether this session will run out of room.
      // Cost asks a different question and answers it much sooner: a turn
      // re-sends its whole prompt once per tool call, so stale payload is paid
      // for tens of times over before anything is close to full. The
      // context-builder was 81% of a run's tokens while never crossing the
      // overflow trigger. Level 1 is lossless, so there is nothing to weigh.
      const bulk = evictablePayloadTokens(
        agent.state.messages.map((m, i) => toCompactable(m, i)),
        this.#compaction.thresholds,
      );
      if (bulk < this.#compaction.thresholds.level1PayloadTokens) return;
      level = "level1";
    }

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
    const usage = { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0, billable: 0 };
    let toolCalls = 0;
    let model = this.#persona(role).model as string;
    let stopReason: string | undefined;
    let errorMessage: string | undefined;
    let contextTokens = 0;

    for (const message of fresh) {
      if (message.usage) {
        usage.input += message.usage.input ?? 0;
        usage.output += message.usage.output ?? 0;
        usage.cacheRead += message.usage.cacheRead ?? 0;
        usage.reasoning += message.usage.reasoning ?? 0;
        usage.total += message.usage.totalTokens ?? 0;
        usage.billable += (message.usage.input ?? 0) + (message.usage.output ?? 0);
        // Overwritten by each successive call, so what survives is the last.
        contextTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0);
      }
      if (message.model) model = message.model;
      if (message.stopReason) stopReason = message.stopReason;
      if (message.errorMessage) errorMessage = message.errorMessage;
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
      ...(errorMessage ? { errorMessage } : {}),
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

  /**
   * Per-role and per-model roll-up for the run summary.
   *
   * `ms` does not sum to wall time and must not be read as though it did. Once
   * the orchestrator drives the loop, one of its turns *contains* the turns it
   * delegates: a `call_verifier` blocks for the whole verifier turn, so those
   * seconds are counted once against the verifier and again against the
   * orchestrator. Tokens do not have this problem — each agent's usage is
   * reported by its own calls — so `tokens` is additive and `ms` is not. The
   * run's real duration is `elapsed_ms` in the summary.
   */
  rollUp(): Record<string, { calls: number; tokens: number; reported: number; ms: number }> {
    const out: Record<string, { calls: number; tokens: number; reported: number; ms: number }> = {};
    for (const e of this.#ledger) {
      const key = `${e.role}:${e.model}`;
      const row = (out[key] ??= { calls: 0, tokens: 0, reported: 0, ms: 0 });
      row.calls += 1;
      row.tokens += e.usage.billable;
      row.reported += e.usage.total;
      row.ms += e.durationMs;
    }
    return out;
  }
}

/**
 * The provider's error for this turn, or null if it completed.
 *
 * Reads the messages pi appended rather than catching an exception, because pi
 * does not throw: a failed call becomes an assistant message with empty
 * content, zero usage and `stopReason: "error"`.
 */
function providerFailure(fresh: readonly PiMessage[]): string | null {
  for (const message of fresh) {
    if (message.stopReason === "error") {
      return message.errorMessage ?? "the provider returned an error with no message";
    }
  }
  return null;
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
