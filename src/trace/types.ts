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
