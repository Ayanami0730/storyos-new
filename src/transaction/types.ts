/**
 * Scene transaction vocabulary.
 *
 * A scene is the atomic unit of narrative progress. Either its prose and its
 * state delta both land in the canonical index, or neither does.
 */

export const SCENE_STATES = [
  "OPEN",
  "CONTEXT_BUILT",
  "DRAFTED",
  "STATE_DELTA_PROPOSED",
  "VALIDATING",
  "REPAIR_REQUIRED",
  "APPROVED",
  "REJECTED",
  "COMMITTING",
  "STALE_BASE",
  "COMMITTED",
  "ABORTED",
] as const;

export type SceneState = (typeof SCENE_STATES)[number];

/** States from which no further transition is legal. */
export const TERMINAL_STATES = new Set<SceneState>([
  "COMMITTED",
  "REJECTED",
  "ABORTED",
]);

export type AgentRole =
  | "orchestrator"
  | "index-manager"
  | "context-builder"
  | "writer"
  | "verifier";

/**
 * Who is allowed to drive each transition.
 *
 * The load-bearing entry is COMMITTING -> COMMITTED: only `index-manager`. The
 * verifier's APPROVED is an opinion; it is not a commit. v2 blurred this and the
 * write path ended up spread across modules.
 */
export interface Transition {
  readonly from: SceneState;
  readonly to: SceneState;
  readonly actor: AgentRole;
}

export const TRANSITIONS: readonly Transition[] = [
  { from: "OPEN", to: "CONTEXT_BUILT", actor: "context-builder" },
  { from: "CONTEXT_BUILT", to: "DRAFTED", actor: "writer" },
  { from: "DRAFTED", to: "STATE_DELTA_PROPOSED", actor: "writer" },
  { from: "STATE_DELTA_PROPOSED", to: "VALIDATING", actor: "orchestrator" },
  { from: "VALIDATING", to: "REPAIR_REQUIRED", actor: "verifier" },
  { from: "VALIDATING", to: "APPROVED", actor: "verifier" },
  { from: "VALIDATING", to: "REJECTED", actor: "verifier" },
  // A repair round re-enters drafting; the writer rewrites, it is never the
  // engine that edits the draft (v2's preservation helpers caused nine
  // consecutive drafts with an identical prose digest).
  { from: "REPAIR_REQUIRED", to: "DRAFTED", actor: "writer" },
  { from: "APPROVED", to: "COMMITTING", actor: "orchestrator" },
  { from: "COMMITTING", to: "COMMITTED", actor: "index-manager" },
  { from: "COMMITTING", to: "STALE_BASE", actor: "index-manager" },
  // A stale base means the packet was built against a commit that has since
  // moved; the only cure is to rebuild context, not to retry the commit.
  { from: "STALE_BASE", to: "CONTEXT_BUILT", actor: "context-builder" },
  // Abort is reachable from any non-terminal state; enumerated in isLegal().
] as const;

export interface SceneArtifacts {
  readonly contextPacket?: string;
  readonly sceneDraft?: string;
  readonly proposedStateDelta?: string;
  readonly validationFindings?: string;
}

/**
 * The transaction speaks the verifier's vocabulary rather than its own.
 *
 * An earlier version of this file declared a local `{validator, severity,
 * message, id}`, which is all a state machine strictly needs. It was also all
 * the writer ever received, and a writer told only "severity: error,
 * contradicts canon" can do nothing but rewrite the scene — the mechanism
 * behind v2's nine consecutive drafts with identical prose digests. The richer
 * type is defined in `verification/finding.ts` with the reasoning.
 */
import type { Finding } from "../verification/finding.ts";

export type { Finding };

export interface SceneTransactionSnapshot {
  readonly txid: string;
  readonly sceneId: string;
  readonly state: SceneState;
  /** Commit the context packet was built against. */
  readonly baseCommitId: string;
  /** 0 for the first draft; a repair round increments it. */
  readonly attempt: number;
  readonly maxRepairs: number;
  readonly artifacts: SceneArtifacts;
  readonly findings: readonly Finding[];
  readonly history: readonly {
    readonly from: SceneState;
    readonly to: SceneState;
    readonly actor: AgentRole;
    readonly at: string;
  }[];
}

export class IllegalTransitionError extends Error {
  readonly from: SceneState;
  readonly to: SceneState;
  readonly actor: AgentRole;

  constructor(from: SceneState, to: SceneState, actor: AgentRole, reason: string) {
    super(`illegal transition ${from} -> ${to} by ${actor}: ${reason}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
    this.actor = actor;
  }
}
