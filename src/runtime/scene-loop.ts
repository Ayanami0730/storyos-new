/**
 * The scene transaction's vocabulary, and the deterministic driver for it.
 *
 * Everything before this file was a part: a state machine that refuses illegal
 * moves, a packet builder that fails on a missing constraint, three layers of
 * verification, an atomic commit. `SceneDirector` turns them into steps that
 * refuse to run out of order; this is the driver that walks those steps in the
 * obvious sequence, with no model deciding anything.
 *
 * It is used in two places. Tests drive it, because the interesting failures in
 * a control flow are ordering and budget rather than token generation. And the
 * engine drives it to finish a scene the orchestrator left half-done, so an
 * orchestrator that loses the thread degrades to the old behaviour instead of
 * losing the scene.
 *
 * Three decisions live in the director and are worth stating here, because each
 * is a place a plausible implementation would go wrong.
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

import type { ContextItem, ContextPacket, PacketRequest } from "../context/types.ts";
import type { CommitResult, FileWrite } from "../index/commit.ts";
import { CanonicalIndex } from "../index/commit.ts";
import type { Finding, SceneState } from "../transaction/types.ts";
import type { CanonFact, SceneDelta } from "../verification/deterministic.ts";
import { type DirectorDeps, SceneDirector } from "./scene-director.ts";

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
  /**
   * Enrich the deterministic skeleton by searching the index.
   *
   * Optional so the loop's control flow can be tested without it, and so a run
   * can be configured without a builder to measure what the builder is worth.
   * Returns P2–P4 material only; the skeleton's hard constraints are not its to
   * change.
   */
  build?(input: {
    readonly sceneId: string;
    readonly skeleton: ContextPacket;
    /**
     * What the orchestrator asked for, in its own words.
     *
     * Present only when the orchestrator drove this step. It is an addition to
     * the standing brief, never a replacement: the parts of a brief that make a
     * step correct — quote the material, refuse to invent, name the file — are
     * not the orchestrator's to relax.
     */
    readonly note?: string;
  }): Promise<readonly ContextItem[]>;

  /** Draft, or redraft in response to findings. */
  draft(input: {
    readonly packet: ContextPacket;
    readonly attempt: number;
    /** Empty on the first attempt. */
    readonly repairBrief: string;
    /** Where the packet is on disk, so the writer can re-read it after a follow-up. */
    readonly packetPath?: string | null;
    /** Where the last audit is, on a repair round. */
    readonly auditPath?: string | null;
    readonly note?: string;
  }): Promise<Draft>;

  /**
   * Fold an approved scene into every partition it touched, returning the files
   * to write.
   *
   * Runs after approval and before the commit, so the prose and everything
   * derived from it land in one transaction. Committing first and backfilling
   * afterwards is what produces an index that lags its own manuscript, and it
   * fails in the direction hardest to notice: the prose looks right until a
   * later scene reads a partition that never updated.
   */
  backfill?(input: {
    readonly sceneId: string;
    readonly draft: Draft;
    readonly packet: ContextPacket;
    readonly note?: string;
  }): Promise<readonly FileWrite[]>;
  /**
   * The LLM verification track. Runs only after the deterministic layer is
   * satisfied, because a model should never be asked to find what a comparison
   * already settled.
   */
  review(input: {
    readonly packet: ContextPacket;
    readonly draft: Draft;
    readonly note?: string;
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
  /** Where the declared delta lands. Defaults under `continuity/`. */
  readonly deltaPath?: string;
}

export type SceneOutcome =
  | {
      readonly status: "COMMITTED";
      readonly commit: CommitResult;
      readonly attempts: number;
      readonly history: readonly SceneState[];
      readonly findings: readonly Finding[];
      /** Partitions this scene wrote, for the audit of what the index gained. */
      readonly derivedPaths: readonly string[];
      /** Non-fatal problems worth reporting rather than hiding. */
      readonly warnings: readonly string[];
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

/**
 * Walk the director's steps in order until the scene is finished.
 *
 * The loop is deliberately dull: build, then draft-and-verify until the
 * verifier stops asking for repairs, then commit. Every judgement it could
 * make — is another round worth it, has this finding already survived a
 * rewrite, may this commit proceed — belongs to the director and is refused
 * there, so a second driver cannot make a different decision than this one.
 */
export async function runScene(
  request: SceneRequest,
  deps: DirectorDeps,
): Promise<SceneOutcome> {
  const director = new SceneDirector(request, deps);

  await director.buildContext();
  while (!director.isTerminal() && director.state !== "APPROVED") {
    const drafted = await director.draft();
    if (!drafted.ok) break;
    const verified = await director.verify();
    if (!verified.ok) break;
  }
  if (director.state === "APPROVED") await director.commit();

  return director.outcome();
}

export { SceneDirector } from "./scene-director.ts";
export type { DirectorDeps, StepReport } from "./scene-director.ts";
