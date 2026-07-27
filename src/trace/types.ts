/**
 * The trace bundle: one file that contains a whole run.
 *
 * Reading a finished run used to mean opening five transcripts, a summary, a
 * ledger and a dozen artefact files side by side while keeping the scene id in
 * your head. This is that work done once, at ingest, into a shape a web page
 * can render without knowing anything about our directory layout.
 *
 * Two properties are deliberate.
 *
 * **Self-contained.** A bundle embeds the artefact *text*, not paths into a run
 * directory that may be deleted. The paths are still recorded, because
 * provenance matters, but nothing needs them to be readable.
 *
 * **Version-stamped.** Every bundle carries the harness version that produced
 * it. Four of this version's fixes changed measured numbers by large factors,
 * so a trace whose version is unknown cannot be compared with anything.
 */

/** A block of prose with an optional Chinese translation beside it. */
export interface Bilingual {
  readonly en: string;
  /** Present once the ingest translation pass has run. */
  readonly zh?: string;
}

/** One model call, exactly as the ledger recorded it. */
export interface TraceCall {
  readonly role: string;
  readonly model: string;
  readonly txid: string;
  readonly at: string;
  readonly durationMs: number;
  readonly toolCalls: number;
  /** Prompt size of the last model call in the turn — the context as sent. */
  readonly contextTokens: number;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly reasoning: number;
    /** input + output: what a comparison may use. */
    readonly billable: number;
    /** Everything the provider reported, cache reads included. */
    readonly total: number;
  };
  readonly stopReason?: string;
  readonly errorMessage?: string;
  /** USD at published list price, not a bill. */
  readonly usd: number;
}

/** A tool the agent actually called, and how often, within one transaction. */
export interface ToolTally {
  readonly role: string;
  readonly tool: string;
  readonly count: number;
}

/** One artefact a step produced, with its text carried inline. */
export interface TraceArtifact {
  readonly kind: "packet" | "draft" | "delta" | "audit" | "orchestrator-log" | "prose";
  readonly path: string;
  readonly bytes: number;
  readonly body: Bilingual;
}

/**
 * One block of what actually moved between an agent and its model.
 *
 * The per-call totals in `TraceCall` say a turn happened and what it cost; they
 * do not say what was asked or what came back, which is the only thing that
 * explains *why* a scene went the way it did. Reading a case previously meant
 * opening `runtime/transcripts/<role>/<run>.jsonl` by hand.
 */
export interface TraceMessage {
  /**
   * `prompt` is what the agent was given, `text` what it said, `toolCall` a tool
   * it invoked with its arguments, `toolResult` what came back. Kept as separate
   * kinds rather than one blob because the interesting failures are specifically
   * a tool called with bad arguments, or a refusal in a tool result that the
   * agent then ignored.
   */
  readonly kind: "prompt" | "text" | "toolCall" | "toolResult";
  readonly at: string;
  readonly toolName?: string;
  /** JSON arguments, for a `toolCall`. */
  readonly arguments?: string;
  readonly isError?: boolean;
  readonly body: Bilingual;
}

/**
 * One model round-trip, with everything that went in and came out of it.
 *
 * A round-trip is not the same unit as a *turn*. One `invoke` — one row in
 * `ledger.jsonl`, one entry in `TraceScene.calls` — runs a tool loop, and every
 * pass through that loop is another request to the provider. A four-scene run has
 * 29 turns and 315 round-trips, and both numbers are correct; the turn is what
 * cost accounting is grouped by, and the round-trip is what you read to see what
 * actually happened.
 */
export interface TraceStep {
  readonly index: number;
  readonly role: string;
  readonly model: string;
  /**
   * When the model answered, from the message's own epoch timestamp.
   *
   * Not the transcript sink's write time, which is what this used to carry: the
   * sink flushes a whole turn at once, so every round-trip in a turn shared one
   * timestamp and the trace showed forty calls happening in the same millisecond.
   */
  readonly at: string;
  /** Wall time from the previous message in this agent's session to this reply. */
  readonly durationMs: number;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly reasoning: number;
    readonly billable: number;
  };
  /** List-price estimate for this one round-trip. */
  readonly usd: number;
  readonly stopReason?: string;
  /** Which tools this turn called, in order, for a one-line summary of the step. */
  readonly toolsCalled: readonly string[];
  readonly messages: readonly TraceMessage[];
}

export interface TraceScene {
  readonly sceneId: string;
  readonly txid: string;
  readonly chapter: string;
  readonly intent: Bilingual;
  readonly presentEntities: readonly string[];
  readonly targetWords: number;
  readonly status: string;
  readonly attempts: number;
  /**
   * What this scene was allowed to spend, and where in the story that came from.
   *
   * In the trace rather than only in the summary because it is the thing a reader
   * needs in order to interpret the rest of the scene card: three attempts on an
   * endgame scene and three on an opening scene mean opposite things, since one
   * had rounds to spare and the other was at its ceiling.
   */
  readonly allocation?: {
    readonly tier: string;
    readonly position: number;
    readonly repairRounds: number;
    readonly followUpRounds: number;
    readonly recentScenes: number;
    readonly pinned: boolean;
    readonly rationale: Bilingual;
  };
  /** Steps the orchestrator drove itself; the rest the engine finished. */
  readonly stepsByOrchestrator: number;
  readonly stepsRescuedByEngine: number;
  readonly wallMs: number;
  readonly calls: readonly TraceCall[];
  /**
   * Every model call in this scene with its full input and output, in the order
   * they happened across all five roles.
   *
   * Empty unless the run was ingested with `--deep`: the bodies are the bulk of a
   * bundle and translating them costs real money, so a reader who wants one case
   * in full asks for that case in full.
   */
  readonly steps?: readonly TraceStep[];
  readonly tools: readonly ToolTally[];
  readonly artifacts: readonly TraceArtifact[];
  /** Every finding raised against this scene, blocking or not. */
  readonly findings: readonly {
    readonly subtype: string;
    readonly severity: string;
    readonly validator: string;
    readonly reasoning: Bilingual;
    readonly quote: string;
    readonly contradicts?: string;
  }[];
  /** Why it did not commit, when it did not. */
  readonly failureReason?: Bilingual;
  /** Gaps the builder recorded as absent from the index. */
  readonly gaps: readonly { readonly need: Bilingual; readonly searched: string }[];
}

/** A lesson an agent wrote for itself. */
export interface TraceMemory {
  readonly role: string;
  readonly topic: string;
  readonly title: string;
  readonly hook: string;
  readonly scope: string;
  readonly source: string;
  readonly body: Bilingual;
}

/**
 * One file in the project as the run left it.
 *
 * The partition *counts* in `index` say the index was filled; they do not let
 * anyone check what it was filled with, which is the claim the whole design rests
 * on. So the final state travels with the trace as files a reader can open.
 *
 * `runtime/transcripts/` is excluded: it is the largest thing in the tree and it
 * is already present, structured, as `TraceScene.steps`.
 */
export interface TraceFile {
  /** Relative to the project root, e.g. `characters/char-mira/profile.yaml`. */
  readonly path: string;
  readonly bytes: number;
  /**
   * Contents. `zh` is filled only for prose — a translated YAML is not a YAML, and
   * a structured file is mostly identifiers a translation would only damage.
   */
  readonly body: Bilingual;
}

export interface TraceBundle {
  readonly runId: string;
  readonly harnessVersion: string;
  /**
   * True when the version was supplied at ingest rather than recorded by the
   * run. Set only for runs that finished before the summary carried a version;
   * a silently backfilled version is the field a later reader trusts most and
   * can least check.
   */
  readonly versionAssertedByIngest?: boolean;
  readonly harnessVersionNote: Bilingual;
  readonly startedAt: string;
  /** The benchmark task, when the run was scored against one. */
  readonly task: {
    readonly id: string;
    readonly benchmark: string;
    readonly prompt: Bilingual;
    readonly requiredWords: number;
    readonly language: string;
    readonly type: string;
  } | null;
  readonly plan: {
    readonly logline: Bilingual;
    readonly worldRules: readonly Bilingual[];
    readonly entities: readonly { readonly id: string; readonly sketch: Bilingual }[];
  };
  readonly scenes: readonly TraceScene[];
  readonly headline: Readonly<Record<string, unknown>>;
  /** Judge result, when the run was scored. */
  readonly score: {
    readonly judgeModel: string;
    readonly sLength: number;
    readonly sQualityRaw: number;
    readonly sBar: number;
    readonly responseWords: number;
    readonly requiredWords: number;
    readonly dimensions: Readonly<Record<string, number>>;
    /** Same task, same judge, other systems — for context, not for a claim. */
    readonly baselines: readonly {
      readonly system: string;
      readonly sBar: number;
      readonly sLength: number;
      readonly sQualityRaw: number;
      readonly words: number;
    }[];
  } | null;
  readonly cost: {
    readonly totalUsd: number;
    readonly note: string;
    readonly byModel: readonly {
      readonly model: string;
      readonly calls: number;
      readonly usd: number;
      readonly inputUsd: number;
      readonly cachedUsd: number;
      readonly outputUsd: number;
    }[];
  };
  readonly index: {
    readonly partitions: Readonly<Record<string, number>>;
    readonly references: Readonly<Record<string, number>>;
    readonly dangling: readonly unknown[];
    readonly readsByRole: Readonly<Record<string, number>>;
  };
  /**
   * The project tree as the run left it, for reading rather than counting.
   * Present only on a deep ingest.
   */
  readonly files?: readonly TraceFile[];
  readonly memory: readonly TraceMemory[];
  readonly skills: Readonly<Record<string, readonly string[]>>;
  /** The finished manuscript. */
  readonly manuscript: Bilingual;
  readonly revisionPlan: Bilingual;
  /** Progress lines, in order, so the run can be replayed as it happened. */
  readonly log: readonly string[];
  /** How the write gate was enforced, and whether that was demonstrated. */
  readonly sandbox: Readonly<Record<string, unknown>>;
  readonly translation: {
    readonly model: string;
    readonly at: string;
    readonly sections: number;
    /**
     * The name table every unit was pinned to.
     *
     * Recorded because it is the one thing that makes a parallel translation
     * internally consistent, and because a reader who disagrees with a
     * rendering should be able to see what was decided rather than guess.
     */
    readonly glossary: string;
  } | null;
}
