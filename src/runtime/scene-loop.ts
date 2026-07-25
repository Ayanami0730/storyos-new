/**
 * The scene transaction, driven end to end.
 *
 * Everything before this file was a part: a state machine that refuses illegal
 * moves, a packet builder that fails on a missing constraint, three layers of
 * verification, an atomic commit. This is where they become a loop that can
 * finish a scene — and where the decisions the parts deliberately left open
 * have to be made.
 *
 * Three of those decisions are worth stating, because each is a place a
 * plausible implementation would go wrong.
 *
 * **A repair round that changes nothing ends the loop early.** The budget
 * bounds how long a repair loop runs; it does not stop it spending every round
 * on a defect the writer cannot see how to fix. If the same finding survives a
 * rewrite, we stop and escalate rather than buying two more identical drafts.
 *
 * **A stale base rebuilds context; it never retries the commit.** Retrying
 * against a moved base is exactly the race that makes "prose and state land
 * together" unprovable, and it is cheap to get wrong because the retry usually
 * succeeds.
 *
 * **The engine never edits a proposal.** Every repair goes back to the writer.
 * v2 had helpers that "preserved" parts of the writer's patch and produced nine
 * consecutive drafts with identical prose digests.
 */

import { buildContextPacket } from "../context/packet.ts";
import type { ContextItem, ContextPacket, PacketRequest } from "../context/types.ts";
import { PacketBuildError } from "../context/types.ts";
import { type CommitResult, CanonicalIndex, CommitRefused } from "../index/commit.ts";
import { SceneTransaction } from "../transaction/machine.ts";
import type { Finding, SceneState } from "../transaction/types.ts";
import {
  type CanonFact,
  type SceneDelta,
  verifyDeterministic,
} from "../verification/deterministic.ts";
import { blocking, renderRepairBrief, unchangedAcrossRound } from "../verification/finding.ts";

/** What the writer returns for one attempt. */
export interface Draft {
  readonly prose: string;
  readonly delta: SceneDelta;
}

/**
 * The two model-backed steps, behind an interface.
 *
 * Kept abstract so the loop's control flow is testable without the network —
 * the interesting failures here are ordering and budget, not token generation.
 */
export interface SceneCollaborators {
  /** Draft, or redraft in response to findings. */
  draft(input: {
    readonly packet: ContextPacket;
    readonly attempt: number;
    /** Empty on the first attempt. */
    readonly repairBrief: string;
  }): Promise<Draft>;
  /**
   * The LLM verification track. Runs only after the deterministic layer is
   * satisfied, because a model should never be asked to find what a comparison
   * already settled.
   */
  review(input: {
    readonly packet: ContextPacket;
    readonly draft: Draft;
  }): Promise<readonly Finding[]>;
}

export interface SceneRequest {
  readonly txid: string;
  readonly sceneId: string;
  readonly packet: PacketRequest;
  readonly available: readonly ContextItem[];
  readonly canon: readonly CanonFact[];
  readonly knownEntities: ReadonlySet<string>;
  readonly maxRepairs: number;
  /** Where the prose lands, relative to the index root. */
  readonly prosePath: string;
}

export type SceneOutcome =
  | {
      readonly status: "COMMITTED";
      readonly commit: CommitResult;
      readonly attempts: number;
      readonly history: readonly SceneState[];
      readonly findings: readonly Finding[];
    }
  | {
      readonly status: "REJECTED" | "ABORTED";
      /** Why it stopped, in words a human reading the run log can act on. */
      readonly reason: string;
      readonly attempts: number;
      readonly history: readonly SceneState[];
      readonly findings: readonly Finding[];
    }
  | {
      readonly status: "STALE_BASE";
      readonly reason: string;
      readonly newBaseCommitId: string;
      readonly attempts: number;
      readonly history: readonly SceneState[];
      readonly findings: readonly Finding[];
    };

export async function runScene(
  request: SceneRequest,
  deps: {
    readonly collaborators: SceneCollaborators;
    readonly index: CanonicalIndex;
    readonly now?: () => Date;
  },
): Promise<SceneOutcome> {
  const { collaborators, index } = deps;
  const tx = new SceneTransaction({
    txid: request.txid,
    sceneId: request.sceneId,
    baseCommitId: request.packet.baseCommitId,
    maxRepairs: request.maxRepairs,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const finish = (
    status: "REJECTED" | "ABORTED",
    reason: string,
    findings: readonly Finding[] = [],
  ): SceneOutcome => ({
    status,
    reason,
    attempts: tx.attempt + 1,
    history: tx.snapshot().history.map((h) => h.to),
    findings,
  });

  // 1. Context. A build failure is terminal for this attempt on purpose: the
  //    cure is to fix the index or the scene card, not to try again.
  let packet: ContextPacket;
  try {
    packet = buildContextPacket(request.packet, request.available);
  } catch (error) {
    if (error instanceof PacketBuildError) {
      tx.transition("ABORTED", "orchestrator");
      return finish(
        "ABORTED",
        `context build failed: ${error.message}. ` +
          (error.missingIds.length > 0
            ? `Supply ${error.missingIds.join(", ")} or remove them from the scene card; ` +
              `do not let the writer infer them.`
            : "Reduce the scene's mandatory material or raise the budget."),
      );
    }
    throw error;
  }
  tx.transition("CONTEXT_BUILT", "context-builder", { artifact: packet.rendered });

  let repairBrief = "";
  let previousFindings: readonly Finding[] = [];
  let lastDraft: Draft | null = null;
  // Counted here rather than read off the machine: the machine increments on
  // the REPAIR_REQUIRED -> DRAFTED edge, which happens *after* the writer has
  // already been asked, so reading it here would tell the writer it is on
  // attempt 0 during every repair round.
  let attempt = 0;

  for (;;) {
    // 2. Draft and declare. Both, always: prose whose state change was never
    //    recorded will be contradicted by the next scene.
    const draft = await collaborators.draft({ packet, attempt, repairBrief });
    lastDraft = draft;
    tx.transition("DRAFTED", "writer", { artifact: draft.prose });
    tx.transition("STATE_DELTA_PROPOSED", "writer", {
      artifact: JSON.stringify(draft.delta),
    });
    tx.transition("VALIDATING", "orchestrator");

    // 3. Cheapest and most certain first. The deterministic layer costs nothing
    //    and cannot be talked out of a contradiction; only what it cannot
    //    settle goes to a model.
    const deterministic = verifyDeterministic({
      delta: draft.delta,
      canon: request.canon,
      knownEntities: request.knownEntities,
    });

    let findings: readonly Finding[] = deterministic.findings;
    if (blocking(findings).length === 0) {
      findings = [...findings, ...(await collaborators.review({ packet, draft }))];
    }

    const blockers = blocking(findings);
    if (blockers.length === 0) {
      tx.transition("APPROVED", "verifier", { findings });
      break;
    }

    // 4. Would another round help? A finding that survived a rewrite is
    //    evidence that it would not.
    const persistent = unchangedAcrossRound(previousFindings, blockers);
    if (persistent.length > 0) {
      tx.transition("REJECTED", "verifier", { findings });
      return finish(
        "REJECTED",
        `${persistent.length} finding(s) survived a rewrite unchanged ` +
          `(${persistent.map((f) => f.id).join(", ")}). Another round would buy the ` +
          `same draft again; the defect needs a decision, not a retry.`,
        findings,
      );
    }

    if (tx.repairBudgetRemaining <= 0) {
      tx.transition("REJECTED", "verifier", { findings });
      return finish(
        "REJECTED",
        `repair budget of ${request.maxRepairs} exhausted with ${blockers.length} ` +
          `blocking finding(s) outstanding`,
        findings,
      );
    }

    tx.transition("REPAIR_REQUIRED", "verifier", { findings });
    previousFindings = blockers;
    repairBrief = renderRepairBrief(findings);
    attempt += 1;
  }

  // 5. Commit. index-manager is the only actor that can produce COMMITTED, and
  //    the prose and the delta go in one call or neither does.
  tx.transition("COMMITTING", "orchestrator");
  const findings = tx.snapshot().findings;
  try {
    const commit = await index.commit({
      txid: request.txid,
      sceneId: request.sceneId,
      baseCommitId: tx.baseCommitId,
      actor: "index-manager",
      prose: { relPath: request.prosePath, content: lastDraft!.prose },
      stateDelta: [
        {
          relPath: `index/story/continuity/deltas/${request.sceneId}.json`,
          content: JSON.stringify(lastDraft!.delta, null, 2),
        },
      ],
    });
    tx.transition("COMMITTED", "index-manager");
    return {
      status: "COMMITTED",
      commit,
      attempts: tx.attempt + 1,
      history: tx.snapshot().history.map((h) => h.to),
      findings,
    };
  } catch (error) {
    if (error instanceof CommitRefused && error.code === "STALE_BASE") {
      const head = await index.head();
      tx.markStaleBase(head);
      return {
        status: "STALE_BASE",
        reason:
          `HEAD moved to ${head} while this scene was being written, so the delta was ` +
          `computed against a world that no longer exists. Rebuild the packet against ` +
          `the new base; do not retry the commit.`,
        newBaseCommitId: head,
        attempts: tx.attempt + 1,
        history: tx.snapshot().history.map((h) => h.to),
        findings,
      };
    }
    if (error instanceof CommitRefused) {
      tx.transition("ABORTED", "orchestrator");
      return finish("ABORTED", `commit refused (${error.code}): ${error.message}`, findings);
    }
    throw error;
  }
}
