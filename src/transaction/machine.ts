/**
 * The scene transaction state machine.
 *
 * Enforces four invariants that v2 failed to hold (see docs/03-v2-postmortem.md
 * and docs/06-v2-repair-loop-failure-taxonomy.md):
 *
 *  1. Only `index-manager` can produce COMMITTED. APPROVED is the verifier's
 *     opinion, nothing more.
 *  2. Prose and state delta are committed together or not at all — COMMITTING
 *     requires both artifacts to be present.
 *  3. The engine never edits an agent's proposal. A repair round returns to the
 *     writer, which produces a fresh draft.
 *  4. The repair budget is bounded and counted in one place.
 */

import {
  type AgentRole,
  type Finding,
  type SceneArtifacts,
  type SceneState,
  type SceneTransactionSnapshot,
  IllegalTransitionError,
  TERMINAL_STATES,
  TRANSITIONS,
} from "./types.ts";

export interface SceneTransactionInit {
  readonly txid: string;
  readonly sceneId: string;
  readonly baseCommitId: string;
  /** Total writer attempts allowed is maxRepairs + 1. */
  readonly maxRepairs: number;
  readonly now?: () => Date;
}

const ARTIFACT_FOR_STATE: Partial<Record<SceneState, keyof SceneArtifacts>> = {
  CONTEXT_BUILT: "contextPacket",
  DRAFTED: "sceneDraft",
  STATE_DELTA_PROPOSED: "proposedStateDelta",
};

export class SceneTransaction {
  #state: SceneState = "OPEN";
  #attempt = 0;
  #baseCommitId: string;
  #artifacts: SceneArtifacts = {};
  #findings: Finding[] = [];
  #history: SceneTransactionSnapshot["history"][number][] = [];
  readonly #now: () => Date;
  readonly #init: SceneTransactionInit;

  constructor(init: SceneTransactionInit) {
    if (!Number.isInteger(init.maxRepairs) || init.maxRepairs < 0) {
      throw new RangeError("maxRepairs must be a non-negative integer");
    }
    this.#init = init;
    this.#baseCommitId = init.baseCommitId;
    this.#now = init.now ?? (() => new Date());
  }

  get state(): SceneState {
    return this.#state;
  }

  get attempt(): number {
    return this.#attempt;
  }

  get baseCommitId(): string {
    return this.#baseCommitId;
  }

  /** Writer attempts already spent, against the budget of maxRepairs + 1. */
  get repairBudgetRemaining(): number {
    return this.#init.maxRepairs + 1 - (this.#attempt + 1);
  }

  isTerminal(): boolean {
    return TERMINAL_STATES.has(this.#state);
  }

  /**
   * Why a transition would be refused, or null if it is allowed. Exposed so
   * callers can branch without catching exceptions.
   */
  refusalReason(to: SceneState, actor: AgentRole): string | null {
    if (this.isTerminal()) {
      return `${this.#state} is terminal`;
    }
    if (to === "ABORTED") {
      return actor === "orchestrator"
        ? null
        : "only the orchestrator may abort a transaction";
    }
    const edge = TRANSITIONS.find(
      (t) => t.from === this.#state && t.to === to,
    );
    if (!edge) {
      return `no edge from ${this.#state} to ${to}`;
    }
    if (edge.actor !== actor) {
      return `${to} is reachable only by ${edge.actor}`;
    }
    if (to === "DRAFTED" && this.#state === "REPAIR_REQUIRED") {
      if (this.repairBudgetRemaining <= 0) {
        return "repair budget exhausted";
      }
    }
    if (to === "COMMITTING") {
      const missing = (["sceneDraft", "proposedStateDelta"] as const).filter(
        (k) => !this.#artifacts[k],
      );
      if (missing.length > 0) {
        // Invariant 2: refuse rather than commit prose without its state delta.
        return `cannot commit without ${missing.join(" and ")}`;
      }
    }
    return null;
  }

  canTransition(to: SceneState, actor: AgentRole): boolean {
    return this.refusalReason(to, actor) === null;
  }

  /**
   * Apply a transition. `artifact` is required for the states that produce one,
   * so a state can never claim an artifact it does not have.
   */
  transition(
    to: SceneState,
    actor: AgentRole,
    options: { readonly artifact?: string; readonly findings?: readonly Finding[] } = {},
  ): this {
    const reason = this.refusalReason(to, actor);
    if (reason !== null) {
      throw new IllegalTransitionError(this.#state, to, actor, reason);
    }

    const artifactKey = ARTIFACT_FOR_STATE[to];
    if (artifactKey) {
      if (options.artifact === undefined) {
        throw new IllegalTransitionError(
          this.#state,
          to,
          actor,
          `${to} requires the ${artifactKey} artifact`,
        );
      }
      this.#artifacts = { ...this.#artifacts, [artifactKey]: options.artifact };
    }

    if (to === "DRAFTED" && this.#state === "REPAIR_REQUIRED") {
      this.#attempt += 1;
      // Findings belong to the attempt that produced them; a new draft starts
      // with a clean slate so a stale finding can never block a fresh commit.
      this.#findings = [];
    }

    if (options.findings) {
      this.#findings = [...options.findings];
      this.#artifacts = {
        ...this.#artifacts,
        validationFindings: JSON.stringify(options.findings),
      };
    }

    this.#history.push({
      from: this.#state,
      to,
      actor,
      at: this.#now().toISOString(),
    });
    this.#state = to;
    return this;
  }

  /**
   * The base commit moved under us. Callers must rebuild the context packet;
   * retrying the commit against a moved base is exactly the race that makes
   * "prose and state land together" unprovable.
   */
  markStaleBase(newBaseCommitId: string): this {
    this.transition("STALE_BASE", "index-manager");
    this.#baseCommitId = newBaseCommitId;
    // Drop the packet outright: it describes a base that no longer exists, and
    // a present-but-stale packet is worse than an absent one.
    const { contextPacket: _dropped, ...rest } = this.#artifacts;
    this.#artifacts = rest;
    return this;
  }

  /** Findings that are blocking, i.e. anything above a warning. */
  blockingFindings(): readonly Finding[] {
    return this.#findings.filter((f) => f.severity !== "warning");
  }

  snapshot(): SceneTransactionSnapshot {
    return {
      txid: this.#init.txid,
      sceneId: this.#init.sceneId,
      state: this.#state,
      baseCommitId: this.#baseCommitId,
      attempt: this.#attempt,
      maxRepairs: this.#init.maxRepairs,
      artifacts: { ...this.#artifacts },
      findings: [...this.#findings],
      history: [...this.#history],
    };
  }
}
