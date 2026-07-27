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

import type { AgentRole } from "../transaction/types.ts";
import { DEFAULT_PROFILE } from "../runtime/budget.ts";

export interface CompactionThresholds {
  readonly contextWindow: number;
  readonly maxOutput: number;
  /** Fraction of the effective budget at which level 1 fires. */
  readonly level1Fraction: number;
  /**
   * Fraction at which level 2 fires.
   *
   * Proportional as well as absolute because the two answer different questions.
   * The reserve below asks "is there still room for one more turn"; this asks
   * "has this session drifted far enough that a verbatim transcript is no longer
   * the best use of the window". On a 256k ceiling the reserve alone would only
   * fire at 95% full, which is late enough that the summary is written under
   * pressure over material that should have been folded long before.
   *
   * The shape is Popia's: prepare early, apply late, two proportional tiers
   * (0.65 / 0.80 there against a 32k window). The brief asked for the same thing
   * in the same words — "达到80%第一次，就会压缩工具，第二次就会做summary".
   */
  readonly level2Fraction: number;
  /** Tokens below the effective budget at which level 2 fires. */
  readonly level2Reserve: number;
  /** Tokens below the effective budget at which no new turn is allowed. */
  readonly blockReserve: number;
  /** Most recent tool results kept verbatim through level 1. */
  readonly keepRecentToolResults: number;
  /**
   * Evictable tool payload above which level 1 runs regardless of headroom.
   *
   * Set where the arithmetic stops being marginal rather than by taste: a turn
   * re-sends its whole prompt once per tool call, and a builder turn makes
   * twenty to forty of them, so 20k of stale payload is 400k–800k tokens of
   * re-sending. Level 1 is lossless, so the only cost of dropping it early is a
   * re-read that mostly never happens.
   */
  readonly level1PayloadTokens: number;
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
    level2Fraction: 0.85,
    level2Reserve: 13_000,
    blockReserve: 3_000,
    keepRecentToolResults: 10,
    keepRecentMessages: 12,
    level1PayloadTokens: 20_000,
  };
}

export const DEFAULT_THRESHOLDS: CompactionThresholds = thresholdsFor(DEFAULT_PROFILE);

export function effectiveBudget(t: CompactionThresholds): number {
  return t.contextWindow - Math.min(t.maxOutput, 20_000);
}

/**
 * Evictable tool payload currently sitting in a transcript.
 *
 * Separate from the overflow thresholds because it answers a different
 * question, and the difference is the single largest cost in the system.
 *
 * The overflow thresholds ask *will this session run out of room*. The measured
 * bill does not work that way: a turn's cost is roughly its context size
 * multiplied by the number of tool calls in it, because every tool call is
 * another model call that re-sends the whole prompt. On the run that made this
 * obvious, the context-builder's transcript grew 37k → 55k → 154k → 190k across
 * four scenes while it made 44, 18, 30 and 19 tool calls — and billed 1.2M,
 * 0.95M, 3.6M and 3.6M tokens. It was **81% of the entire run** and never came
 * close to the 165k overflow trigger until the very end.
 *
 * So carrying 25k of stale grep output is not "25k of headroom used". It is 25k
 * re-sent twenty or thirty more times before the turn ends. Level 1 is lossless
 * — handles and digests stay, and everything an agent read is in the index and
 * re-readable — so there is no reason to wait for pressure before dropping it.
 */
export function evictablePayloadTokens(
  messages: readonly CompactableMessage[],
  t: CompactionThresholds,
): number {
  const toolIndices = messages.flatMap((m, i) => (m.kind === "toolResult" ? [i] : []));
  const keepFrom = toolIndices.length - t.keepRecentToolResults;
  return toolIndices
    .slice(0, Math.max(0, keepFrom))
    .filter((i) => !messages[i]!.pinned)
    .reduce((n, i) => n + messages[i]!.tokens, 0);
}

export type CompactionLevel = "none" | "level1" | "level2" | "block";

export function levelFor(usedTokens: number, t: CompactionThresholds): CompactionLevel {
  const E = effectiveBudget(t);
  if (usedTokens >= E - t.blockReserve) return "block";
  // Whichever comes first: the proportional tier catches a session that has
  // drifted, the reserve catches one that is about to run out of room.
  if (usedTokens >= Math.min(E * t.level2Fraction, E - t.level2Reserve)) return "level2";
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
  /**
   * Set by level 1 on the messages whose payload it replaced.
   *
   * Explicit rather than inferred, because inferring it is a bug we shipped.
   * The caller used to decide "did this change?" by joining every block's
   * `.text` and comparing — and a `toolCall` block has no `.text`, so an
   * assistant message that made a tool call never matched itself. Every such
   * message was therefore rewritten into a plain text block, its `tool_calls`
   * destroyed, and the provider rejected the next request with *"messages with
   * role 'tool' must be a response to a preceding message with 'tool_calls'"*.
   *
   * It survived for weeks because compaction had never actually run. The first
   * time it did, it broke the context-builder on the very next turn.
   */
  readonly evicted?: boolean;
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
    return { ...m, text: pointer, tokens: estimateTokens(pointer), evicted: true };
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
  /**
   * Whose conversation this is, so the summary can be told what *this* role must
   * not lose.
   *
   * One prompt for five roles was asking each of them to decide for itself what
   * mattered, which is the decision a summary is least able to make: it is written
   * under length pressure, and under pressure a model compresses whatever is
   * longest rather than whatever is load-bearing. What is load-bearing differs
   * completely by role — the context-builder's is a map of where things live in this
   * book's index, the verifier's is the list of false positives it has been talked
   * out of, the orchestrator's is why it revised the plan and which scenes are
   * carrying known defects — and none of those is inferable from the generic
   * instruction.
   *
   * Optional so the older call sites and the tests keep working; when absent the
   * prompt is the generic one it always was.
   */
  readonly role?: AgentRole;
}

/**
 * What each role must carry across a fold, and what it may drop.
 *
 * The pairing is the point. "Keep everything important" is not actionable under
 * length pressure; "keep this, and the prose of committed scenes is in the
 * manuscript so drop it" is. Every `drop` here names something the role can re-read
 * from the index on demand, which is the same argument the shared contract makes
 * about memory: the conversation is a working surface and the index is the record.
 *
 * This matters most for the orchestrator now, and that is not a reason to skip the
 * rest. Four of the five roles reset between scenes, so their conversations rarely
 * reach a fold at all — but the orchestrator is resident by design and its context
 * grew to 62k over seventeen scenes, which is roughly 124k at the 34-scene tier and
 * more than that at 80,000 words. It is the one role for which the fold is on the
 * critical path to a long book. The other four still fold under `--resident-all`,
 * which is the arm that measures what residency was worth.
 */
const ROLE_RETENTION: Readonly<Record<AgentRole, { keep: readonly string[]; drop: string }>> = {
  orchestrator: {
    keep: [
      "every plan revision you made and the reason you made it — an unexplained change is " +
        "indistinguishable from drift, and you are the only record of why",
      "which committed scenes carry unresolved findings, and what the defect was: later " +
        "scenes are being written against them",
      "which scenes you abandoned and why",
      "what you have already tried on a scene that is fighting you, so you do not spend a " +
        "third round on a fix that failed twice",
    ],
    drop:
      "the text of briefs you wrote and step reports you have already acted on. The " +
      "artefacts they produced are on disk and the paths are in the reports.",
  },
  "context-builder": {
    keep: [
      "where things live in *this* book's index — which directories are populated, which " +
        "entity files are thin, where the relation records actually are. That map is the " +
        "most expensive thing you have built and it is not written down anywhere else",
      "which searches came back empty, so you do not pay for them again and do not mistake " +
        "a second empty result for new information",
      "the item ids you have already used, since a collision costs a rename",
    ],
    drop:
      "the contents of files you read and pasted. You can read them again, and a summary " +
      "holding stale copies of index files is the second source of truth this system exists " +
      "to avoid.",
  },
  writer: {
    keep: [
      "the voice decisions already made and the ones you were pulled up on — the narrative " +
        "person and tense are declared in your packet, but the register, the sentence rhythm " +
        "and the things this narrator does not say are yours and are nowhere else",
      "the craft habits a checker has flagged more than once",
      "any finding you disputed and the reason, so you argue it the same way twice",
    ],
    drop:
      "the prose of scenes already committed. It is in the manuscript, the packet gives you " +
      "the tail of it, and a remembered version that has drifted from the committed one is " +
      "worse than not remembering it.",
  },
  verifier: {
    keep: [
      "every false positive you were talked out of, and what made it one. This is the single " +
        "most valuable thing in your history: a run whose findings the writer could not act " +
        "on scored below one with fewer, better ones",
      "the subtypes you have caught yourself over-reporting on this book",
      "which files answered which category well here, so the next check goes straight there",
    ],
    drop:
      "the drafts you have already judged and the findings you already filed. The findings " +
      "are in `continuity/findings.jsonl` and the drafts are committed prose.",
  },
  "index-manager": {
    keep: [
      "the attribute vocabulary this book has settled on, so the same property does not " +
        "acquire two names and stop being comparable",
      "which partitions a given kind of scene turns out to touch, and any convention you " +
        "adopted for entity ids",
      "anything a tool rejected and the shape it wanted instead",
    ],
    drop:
      "the prose and the declared delta of scenes you have already folded. Both are " +
      "committed and addressable by path.",
  },
};

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
  // The tail is kept even at the hard block: Popia's chat memory degrades rather
  // than refusing — "如果预算不够放任何近期消息，至少保留最后 1-2 条" — and the same
  // applies here for a stronger reason. A refusal at this point aborts a scene
  // mid-transaction, which costs everything spent on it, while an over-long
  // request costs one provider error we can see and retry.
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
/** What this role in particular must not lose, and what it can safely drop. */
function roleSection(role: AgentRole | undefined): readonly string[] {
  if (!role) return [];
  const spec = ROLE_RETENTION[role];
  return [
    `## As the ${role}, these are the parts of your history that are not recoverable`,
    "",
    "Everything else in this conversation you can get back by reading the index. These you",
    "cannot, so if room is short they are the last things to go:",
    "",
    ...spec.keep.map((k) => `- ${k}`),
    "",
    `Safe to drop: ${spec.drop}`,
    "",
  ];
}

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
    // Popia's summary prompt names what may never be compressed, and the reason
    // generalises: a summary written under pressure compresses whatever is
    // longest, which is usually the narrative thread rather than the profiles.
    "If you are short of room, compress your own reasoning and any tool output first.",
    "NEVER compress: where the story currently stands, what the open threads are, or",
    "what you were part-way through doing. Those are the parts a summary exists for;",
    "everything else you can re-read.",
    "",
    ...roleSection(input.role),
    `Canon currently in force: ${input.canonDigest}`,
    `Open promises: ${input.openPromises.join("; ") || "none recorded"}`,
    `Recent scenes: ${input.recentSceneIds.join(", ") || "none"}`,
    "",
    "--- conversation to summarise ---",
    ...input.folded.map((m) => `[${m.kind}] ${m.text}`),
  ].join("\n");
}

/**
 * Cheap and deliberately rough; the ledger carries the real counts.
 *
 * Weighted per script rather than a flat `length / 4`, because a flat divisor
 * fails in one specific direction and Popia's chat memory service has already
 * paid for the lesson: it underestimates, so a threshold computed from it is
 * never crossed, so compaction never fires and nobody sees an error. Their
 * comment records the fix and the reason —
 *
 *   "本函数对 ASCII 使用 3.2 chars/token（兼顾散文和 JSON 混合场景），对非 ASCII
 *    使用 1.2 chars/token。相比旧版（4.0 / 1.0）更贴近实际，避免因低估导致 summary
 *    阈值永远不触发。"
 *   — onlyside/internal/utils/token_estimator.go
 *
 * We are in the same mixed regime: English prose plus JSON tool payloads plus
 * occasional CJK. 3.2 and 1.2 chars per token, in integer arithmetic to keep the
 * function exact and cheap.
 */
export function estimateTokens(text: string): number {
  let weight = 0;
  for (const ch of text) weight += ch.codePointAt(0)! <= 0x7f ? 10 : 27;
  return Math.max(text.length > 0 ? 1 : 0, Math.floor(weight / 32));
}
