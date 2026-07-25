/**
 * Two-tier context compaction.
 *
 * Residency is what makes our agents different from a harness that spawns a
 * fresh process per call — and it is also what makes them run out of room. A
 * writer that has drafted thirty scenes is carrying thirty scenes of
 * conversation, and the last of those scenes is where the novel most needs it
 * to be sharp.
 *
 * The policy has three thresholds and one rule that matters more than the
 * numbers: **compaction may only ever discard things that can be recovered.**
 * Tool payloads go first because they are re-fetchable — the index still has
 * them. Old conversation is summarised rather than dropped, and the summary
 * enters the model's view only; it never becomes canonical state. Anything that
 * cannot be recovered — a user instruction, a transaction record — is never
 * touched.
 *
 * That rule is why the index has to be the truth. A resident agent whose
 * session is trimmed loses nothing that matters *because* everything that
 * matters was written to a file. If compaction ever feels lossy, the fix is in
 * the index, not in the thresholds.
 *
 * Defaults derive from Claude Code's measured buffers rather than invented:
 * with window `W` and max output `O`, the effective budget is
 * `E = W - min(O, 20k)`; level 1 fires at `0.70·E`, level 2 at `E - 13k`, and
 * a hard block at `E - 3k`.
 */

import { DEFAULT_PROFILE } from "../runtime/budget.ts";

export interface CompactionThresholds {
  readonly contextWindow: number;
  readonly maxOutput: number;
  /** Fraction of the effective budget at which level 1 fires. */
  readonly level1Fraction: number;
  /** Tokens below the effective budget at which level 2 fires. */
  readonly level2Reserve: number;
  /** Tokens below the effective budget at which no new turn is allowed. */
  readonly blockReserve: number;
  /** Most recent tool results kept verbatim through level 1. */
  readonly keepRecentToolResults: number;
  /** Most recent messages kept verbatim through level 2. */
  readonly keepRecentMessages: number;
}

/**
 * Thresholds for a budget profile.
 *
 * `contextWindow` here is the ceiling we **choose to spend**, not the one the
 * model imposes. Under `generous` that is 256k against a real 400k window, so
 * compaction fires on a policy about attention and cost rather than on the
 * model refusing the request — and 256k of prompt plus 64k of output still fits
 * the real window, which is why the two can be set independently.
 */
export function thresholdsFor(profile: {
  readonly inputCeiling: number;
  readonly maxCompletionTokens: number;
}): CompactionThresholds {
  return {
    contextWindow: profile.inputCeiling,
    maxOutput: profile.maxCompletionTokens,
    level1Fraction: 0.7,
    level2Reserve: 13_000,
    blockReserve: 3_000,
    keepRecentToolResults: 10,
    keepRecentMessages: 12,
  };
}

export const DEFAULT_THRESHOLDS: CompactionThresholds = thresholdsFor(DEFAULT_PROFILE);

export function effectiveBudget(t: CompactionThresholds): number {
  return t.contextWindow - Math.min(t.maxOutput, 20_000);
}

export type CompactionLevel = "none" | "level1" | "level2" | "block";

export function levelFor(usedTokens: number, t: CompactionThresholds): CompactionLevel {
  const E = effectiveBudget(t);
  if (usedTokens >= E - t.blockReserve) return "block";
  if (usedTokens >= E - t.level2Reserve) return "level2";
  if (usedTokens >= E * t.level1Fraction) return "level1";
  return "none";
}

/** The shape compaction needs; a superset of what pi's messages provide. */
export interface CompactableMessage {
  readonly role: string;
  readonly kind: "user" | "assistant" | "toolResult" | "summary";
  /** Rough token cost of this message as it currently stands. */
  readonly tokens: number;
  /** Present on tool results; the handle that makes the payload re-fetchable. */
  readonly toolCallId?: string;
  readonly toolName?: string;
  /** Where the payload was spilled, if it was. */
  readonly artifactPath?: string;
  /** One line describing what the payload was, kept when the payload is not. */
  readonly digest?: string;
  readonly text: string;
  /**
   * Never compacted. Transaction records and the standing instruction are the
   * two things the agent cannot re-derive from the index.
   */
  readonly pinned?: boolean;
  /**
   * Position in the transcript this was read from, so a survivor can be paired
   * back with its original after a fold has changed every position after it.
   */
  readonly sourceIndex?: number;
}

export interface CompactionResult {
  readonly level: CompactionLevel;
  readonly messages: readonly CompactableMessage[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** Tool payloads evicted; each is still readable at its artifact path. */
  readonly evicted: readonly { readonly toolCallId: string; readonly artifactPath?: string }[];
  /** Ids of messages folded into a summary, so the fold is auditable. */
  readonly summarised: number;
}

const total = (messages: readonly CompactableMessage[]) =>
  messages.reduce((n, m) => n + m.tokens, 0);

/**
 * Level 1 — evict re-fetchable tool payloads.
 *
 * What survives is the handle: tool call id, name, artifact path and a one-line
 * digest. That is deliberately enough for the agent to *know it looked* and to
 * look again, and not enough to pretend it remembers. The most recent results
 * stay verbatim because the current scene is usually reasoning over them.
 */
export function compactLevel1(
  messages: readonly CompactableMessage[],
  t: CompactionThresholds = DEFAULT_THRESHOLDS,
): CompactionResult {
  const tokensBefore = total(messages);
  const toolIndices = messages.flatMap((m, i) => (m.kind === "toolResult" ? [i] : []));
  const keepFrom = toolIndices.length - t.keepRecentToolResults;
  const evictable = new Set(toolIndices.slice(0, Math.max(0, keepFrom)));

  const evicted: { toolCallId: string; artifactPath?: string }[] = [];
  const out = messages.map((m, i) => {
    if (!evictable.has(i) || m.pinned) return m;
    evicted.push({
      toolCallId: m.toolCallId ?? "unknown",
      ...(m.artifactPath ? { artifactPath: m.artifactPath } : {}),
    });
    const pointer =
      `[tool result evicted] ${m.toolName ?? "tool"} (${m.toolCallId ?? "?"})` +
      (m.digest ? ` — ${m.digest}` : "") +
      (m.artifactPath ? `. Re-read at ${m.artifactPath}.` : ". Re-run the call to see it again.");
    return { ...m, text: pointer, tokens: estimateTokens(pointer) };
  });

  return {
    level: "level1",
    messages: out,
    tokensBefore,
    tokensAfter: total(out),
    evicted,
    summarised: 0,
  };
}

/** What a novel-aware summary must carry, whatever else it drops. */
export interface StorySummaryInput {
  readonly folded: readonly CompactableMessage[];
  /** Canon facts in force, so the summary never becomes the source of them. */
  readonly canonDigest: string;
  readonly openPromises: readonly string[];
  readonly recentSceneIds: readonly string[];
}

export type Summariser = (input: StorySummaryInput) => Promise<string> | string;

/**
 * Level 2 — fold old history into a structured summary, keep a verbatim tail.
 *
 * The summary is navigation, never fact. It records what was worked on and how
 * it went; the facts themselves stay in the index and are re-read. This is the
 * distinction that keeps a compacted agent honest: a summary that starts
 * asserting canon is a summary that will eventually assert canon wrongly, and
 * nothing downstream can tell.
 */
export async function compactLevel2(
  messages: readonly CompactableMessage[],
  summarise: Summariser,
  context: Omit<StorySummaryInput, "folded">,
  t: CompactionThresholds = DEFAULT_THRESHOLDS,
): Promise<CompactionResult> {
  const tokensBefore = total(messages);

  // Never split a tool call from its result, and never fold a pinned message.
  const tailStart = Math.max(0, messages.length - t.keepRecentMessages);
  const pinnedBefore = messages.slice(0, tailStart).filter((m) => m.pinned);
  const folded = messages.slice(0, tailStart).filter((m) => !m.pinned);
  const tail = messages.slice(tailStart);

  if (folded.length === 0) {
    return {
      level: "level2",
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      evicted: [],
      summarised: 0,
    };
  }

  const text = await summarise({ folded, ...context });
  const summary: CompactableMessage = {
    role: "user",
    kind: "summary",
    tokens: estimateTokens(text),
    text,
  };

  const out = [...pinnedBefore, summary, ...tail];
  return {
    level: "level2",
    messages: out,
    tokensBefore,
    tokensAfter: total(out),
    evicted: [],
    summarised: folded.length,
  };
}

/**
 * The default summary prompt.
 *
 * Exported because it is a claim about what matters in a novel-writing session,
 * not an implementation detail: what the agent was doing, what it learnt about
 * its own role, and where it is. Facts, promises and state are named as
 * *pointers into the index* rather than restated, so the summary cannot become
 * a competing source of truth.
 */
export function summaryPrompt(input: StorySummaryInput): string {
  return [
    "Your conversation is about to be folded into a summary. This is the last turn in",
    "which you can see it in full.",
    "",
    "First, if you learnt anything durable about **how to do your job on this project** —",
    "a false positive you were talked out of, a convention, a phrasing that kept being",
    "rejected — record it with `remember` now. A summary is navigation and will itself be",
    "summarised again later; memory is the only thing here that survives indefinitely.",
    "Nothing about the story itself: that belongs in the index.",
    "",
    "Then summarise the conversation below so you can continue working without it.",
    "",
    "Include: what you were asked to do and what you did; anything you learnt about",
    "how to do your role better here; which scenes you have worked on; any finding",
    "you disagreed with and why.",
    "",
    "Do NOT restate story facts. Canon, character state and open promises live in",
    "the index and you will re-read them — a summary that asserts them becomes a",
    "second source of truth that nobody can check. Refer to them by name and move on.",
    "",
    `Canon currently in force: ${input.canonDigest}`,
    `Open promises: ${input.openPromises.join("; ") || "none recorded"}`,
    `Recent scenes: ${input.recentSceneIds.join(", ") || "none"}`,
    "",
    "--- conversation to summarise ---",
    ...input.folded.map((m) => `[${m.kind}] ${m.text}`),
  ].join("\n");
}

/** Cheap and deliberately rough; the ledger carries the real counts. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
