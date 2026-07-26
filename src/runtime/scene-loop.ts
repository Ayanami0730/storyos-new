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
import type { ContextGap } from "./packet-builder.ts";
import { type DirectorDeps, SceneDirector } from "./scene-director.ts";

/** What a context build produced: material found, and material known to be absent. */
export interface BuildResult {
  readonly items: readonly ContextItem[];
  readonly gaps: readonly ContextGap[];
}

/** What the writer returns for one attempt. */
export interface Draft {
  readonly prose: string;
  readonly delta: SceneDelta;
}

/**
 * The model verification layer could not be run at all.
 *
 * Distinct from "the verifier found nothing", and the distinction is the whole
 * point. This failure is the most dangerous one the system has because it fails
 * *open* and looks like success: an empty reply leaves the findings buffer
 * empty, an empty buffer has no blockers, and no blockers is an approval. On the
 * first orchestrator-driven run the verifier returned zero output tokens twice
 * and the scene was recorded as "APPROVED, 0 findings".
 *
 * Raising it as a distinct error lets the scene still commit — the deterministic
 * layer did run, and throwing away sound prose over a provider failure is the
 * worse trade — while making the run say out loud that its findings count is not
 * a quality result.
 */
export class VerificationUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationUnavailable";
  }
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
  }): Promise<BuildResult>;

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
    /**
     * What the builder searched for and could not find.
     *
     * Carried to the writer because the alternative was measured and it does
     * not work: across three runs the writer asked zero follow-up questions
     * with the tool registered and its prompt describing it at length. A packet
     * presents itself as complete, so there was nothing to ask about — the gaps
     * only became apparent at the moment the writer filled one in.
     */
    readonly gaps?: readonly ContextGap[];
    /**
     * Words committed so far against the whole task's target.
     *
     * Passed structurally rather than left to the orchestrator to mention,
     * because a number relayed through a prompt is a number that gets dropped —
     * and this is the one the benchmark weights at half the score. The writer
     * cannot see the manuscript, so without this it writes every scene to the
     * same length whether the book is running short or long.
     */
    readonly words?: { readonly committed: number; readonly target: number };
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
      /**
       * True when the model verification layer never ran, so this scene passed
       * on the deterministic layer alone. Counted per run, because a run with
       * any of these must not report its findings count as a quality result.
       */
      readonly unverified: boolean;
      /**
       * Blocking findings the repair loop could not resolve before the scene was
       * committed anyway.
       *
       * Non-empty means the gate objected and was overruled — deliberately,
       * because deleting the scene costs more than the defect does. Counted per
       * run, because a manuscript with these is not a clean one.
       */
      readonly unresolvedFindings: readonly Finding[];
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
