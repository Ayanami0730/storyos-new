/**
 * The scene transaction, as steps that can be driven from either side.
 *
 * This file exists because of one measurement. In the first run where all five
 * agents were live, the orchestrator made **eight messages in the entire run**
 * and delegated to nobody: it planned, and then the engine called the builder,
 * the writer, the verifier and the index-manager in a fixed order. The
 * orchestrator's own prompt describes a loop — "open a transaction, have
 * context built, have the scene drafted, send both to the verifier" — that it
 * had no tools to perform. It was a role description for a job the code was
 * doing.
 *
 * Making it real is not a matter of handing an LLM the loop. The state machine,
 * the atomicity of the commit and the rule that only index-manager produces
 * COMMITTED are the guarantees the design is built on, and none of them can
 * depend on a model choosing the right next call. So the loop is broken into
 * **steps that refuse to run out of order**, and both drivers use the same
 * steps:
 *
 *   - `runScene` drives them deterministically. This is what tests use, and it
 *     is the fallback when the orchestrator leaves a scene half-finished.
 *   - `orchestratorTools` exposes them as `call_context_builder`, `call_writer`,
 *     `call_verifier` and `call_index_manager`. A call in the wrong state comes
 *     back as a refusal naming the state and the legal next step, so a model
 *     that guesses is corrected rather than obeyed.
 *
 * The delegation names are not decoration. `call_index_manager` *is* the
 * commit, because index-manager is the only actor that may produce COMMITTED —
 * the tool surface and the invariant are the same statement.
 *
 * Each step returns a **report**: what was measured (paths written, items
 * added, findings raised) followed by the callee's own closing words. Measured
 * facts first, because a subagent's account of its work is a claim and the
 * paths are evidence.
 */

import { buildContextPacket } from "../context/packet.ts";
import type { ContextPacket } from "../context/types.ts";
import { PacketBuildError } from "../context/types.ts";
import {
  type CommitResult,
  type FileWrite,
  CanonicalIndex,
  CommitRefused,
} from "../index/commit.ts";
import { SceneTransaction } from "../transaction/machine.ts";
import type { Finding, SceneState } from "../transaction/types.ts";
import { verifyDeterministic } from "../verification/deterministic.ts";
import { blocking, renderRepairBrief, unchangedAcrossRound } from "../verification/finding.ts";
import { type ArtifactStore, artifactPaths, renderAudit } from "./artifacts.ts";
import { type ContextGap, FOLLOW_UP_ROUNDS, renderGaps } from "./packet-builder.ts";
import {
  type Draft,
  type SceneCollaborators,
  type SceneOutcome,
  type SceneRequest,
  VerificationUnavailable,
} from "./scene-loop.ts";

/** Which delegation a step corresponds to, for the report and the refusal text. */
export type StepName = "context" | "draft" | "verify" | "commit" | "abandon";

export interface StepReport {
  /** False when the step refused; the transaction is unchanged in that case. */
  readonly ok: boolean;
  readonly step: StepName;
  readonly state: SceneState;
  /** What the orchestrator reads back. */
  readonly text: string;
  /** Artefacts this step produced, so the next call can point at them. */
  readonly paths: readonly string[];
}

export interface DirectorDeps {
  readonly collaborators: SceneCollaborators;
  readonly index: CanonicalIndex;
  /** Omit to run without artefacts on disk, which is right for unit tests. */
  readonly artifacts?: ArtifactStore;
  readonly now?: () => Date;
}

function report(
  step: StepName,
  state: SceneState,
  text: string,
  paths: readonly string[] = [],
  ok = true,
): StepReport {
  return { ok, step, state, text, paths };
}

/**
 * One scene, from open to terminal.
 *
 * Constructed per scene rather than reused, because the transaction is the
 * scene: a director that could be reopened would be a state machine with a
 * back door.
 */
export class SceneDirector {
  readonly #request: SceneRequest;
  readonly #deps: DirectorDeps;
  readonly #tx: SceneTransaction;

  #packet: ContextPacket | null = null;
  #lastDraft: Draft | null = null;
  #findings: readonly Finding[] = [];
  #previousFindings: readonly Finding[] = [];
  #repairBrief = "";
  /**
   * Counted here rather than read off the machine: the machine increments on
   * the REPAIR_REQUIRED -> DRAFTED edge, which happens after the writer has
   * already been asked, so reading it there would tell the writer it is on
   * attempt 0 during every repair round.
   */
  #attempt = 0;
  #derived: readonly FileWrite[] = [];
  #commit: CommitResult | null = null;
  #terminal: { status: "REJECTED" | "ABORTED"; reason: string } | null = null;
  #staleBase: string | null = null;
  #warnings: string[] = [];
  #lastAuditPath: string | null = null;
  #packetPath: string | null = null;
  #gaps: readonly ContextGap[] = [];
  /** True when the model verification layer never ran for this scene. */
  #unverified = false;

  constructor(request: SceneRequest, deps: DirectorDeps) {
    this.#request = request;
    this.#deps = deps;
    this.#tx = new SceneTransaction({
      txid: request.txid,
      sceneId: request.sceneId,
      baseCommitId: request.packet.baseCommitId,
      maxRepairs: request.maxRepairs,
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  get state(): SceneState {
    return this.#tx.state;
  }

  get sceneId(): string {
    return this.#request.sceneId;
  }

  isTerminal(): boolean {
    return this.#tx.isTerminal();
  }

  /** The packet path, once built, so a caller can point the writer at it. */
  get packetPath(): string | null {
    return this.#packetPath;
  }

  /**
   * The step that is legal right now, in words.
   *
   * Every refusal names it. An agent told only "no" retries the same call; an
   * agent told what is legal instead makes the next call correctly, and the
   * difference is a whole turn per mistake.
   */
  nextStep(): string {
    switch (this.state) {
      case "OPEN":
      case "STALE_BASE":
        return "call_context_builder";
      case "CONTEXT_BUILT":
      case "REPAIR_REQUIRED":
        return "call_writer";
      case "DRAFTED":
      case "STATE_DELTA_PROPOSED":
        return "call_verifier";
      case "APPROVED":
        return "call_index_manager";
      default:
        return "nothing — this scene is finished";
    }
  }

  #refuse(step: StepName, why: string): StepReport {
    return report(
      step,
      this.state,
      `refused: ${why}. The scene is in ${this.state}; the legal next call is ` +
        `${this.nextStep()}.`,
      [],
      false,
    );
  }

  /** Assemble the packet, optionally enriched by the resident builder. */
  async buildContext(note?: string): Promise<StepReport> {
    if (this.state !== "OPEN" && this.state !== "STALE_BASE") {
      return this.#refuse("context", "context has already been built for this scene");
    }

    let packet: ContextPacket;
    try {
      packet = buildContextPacket(this.#request.packet, this.#request.available);
    } catch (error) {
      if (error instanceof PacketBuildError) {
        // Terminal on purpose: the cure is to fix the index or the scene card,
        // not to try the same build again.
        this.#tx.transition("ABORTED", "orchestrator");
        this.#terminal = {
          status: "ABORTED",
          reason:
            `context build failed: ${error.message}. ` +
            (error.missingIds.length > 0
              ? `Supply ${error.missingIds.join(", ")} or remove them from the scene card; ` +
                `do not let the writer infer them.`
              : "Reduce the scene's mandatory material or raise the budget."),
        };
        return report("context", this.state, this.#terminal.reason, [], false);
      }
      throw error;
    }

    // The builder sees the assembled skeleton rather than the raw item list, so
    // it can add only what is not already covered. A failure degrades to the
    // skeleton: a scene written from a thinner packet is a worse scene, and a
    // scene not written at all is no scene.
    let added = 0;
    let builderSays = "";
    if (this.#deps.collaborators.build) {
      try {
        const built = await this.#deps.collaborators.build({
          sceneId: this.#request.sceneId,
          skeleton: packet,
          ...(note ? { note } : {}),
        });
        added = built.items.length;
        this.#gaps = built.gaps;
        if (built.items.length > 0) {
          packet = buildContextPacket(this.#request.packet, [
            ...this.#request.available,
            ...built.items,
          ]);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#warnings.push(`context-builder failed: ${message}`);
        builderSays = `The builder failed (${message}); the skeleton was used unchanged.`;
      }
    }

    this.#packet = packet;
    this.#tx.transition("CONTEXT_BUILT", "context-builder", { artifact: packet.rendered });

    // On disk before anyone is told about it, so the path in the report is a
    // path that resolves.
    if (this.#deps.artifacts) {
      this.#packetPath = await this.#deps.artifacts.write(
        artifactPaths.packet(this.#request.sceneId),
        `# Context packet — ${this.#request.sceneId}\n\n${packet.rendered}\n` +
          `${renderGaps(this.#gaps, FOLLOW_UP_ROUNDS)}\n`,
      );
    }

    return report(
      "context",
      this.state,
      [
        `context built for ${this.#request.sceneId}: ${packet.items.length} item(s), ` +
          `${packet.coverage.usedWords} words, coverage ${
            packet.coverage.complete ? "complete" : "partial"
          }.`,
        `The builder added ${added} item(s) beyond the deterministic skeleton, and recorded ` +
          `${this.#gaps.length} gap(s) it could not fill from the index.`,
        this.#packetPath ? `Packet: ${this.#packetPath}` : "",
        builderSays,
      ]
        .filter(Boolean)
        .join("\n"),
      this.#packetPath ? [this.#packetPath] : [],
    );
  }

  /** Draft, or redraft against the last audit. */
  async draft(note?: string): Promise<StepReport> {
    if (this.state !== "CONTEXT_BUILT" && this.state !== "REPAIR_REQUIRED") {
      return this.#refuse(
        "draft",
        this.state === "OPEN"
          ? "the writer has no packet yet"
          : "there is nothing for the writer to do in this state",
      );
    }
    if (this.state === "REPAIR_REQUIRED" && this.#tx.repairBudgetRemaining <= 0) {
      return this.#refuse("draft", "the repair budget for this scene is spent");
    }

    let draft: Draft;
    try {
      draft = await this.#deps.collaborators.draft({
        packet: this.#packet!,
        attempt: this.#attempt,
        repairBrief: this.#repairBrief,
        packetPath: this.#packetPath,
        auditPath: this.#lastAuditPath,
        gaps: this.#gaps,
        ...(note ? { note } : {}),
      });
    } catch (error) {
      // A collaborator that never produced an artefact ends this scene, not the
      // run. Recorded like a rejection: the failure rate is a result we want,
      // and a harness that halts on the first misbehaving turn produces none.
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.#tx.transition("ABORTED", "orchestrator");
      this.#terminal = { status: "ABORTED", reason: message };
      return report("draft", this.state, message, [], false);
    }

    this.#lastDraft = draft;
    this.#tx.transition("DRAFTED", "writer", { artifact: draft.prose });
    this.#tx.transition("STATE_DELTA_PROPOSED", "writer", {
      artifact: JSON.stringify(draft.delta),
    });

    const paths: string[] = [];
    if (this.#deps.artifacts) {
      paths.push(
        await this.#deps.artifacts.write(
          artifactPaths.draft(this.#request.sceneId),
          draft.prose,
        ),
        await this.#deps.artifacts.write(
          artifactPaths.draftDelta(this.#request.sceneId),
          `${JSON.stringify(draft.delta, null, 2)}\n`,
        ),
      );
    }

    const words = draft.prose.split(/\s+/).filter(Boolean).length;
    return report(
      "draft",
      this.state,
      [
        `${this.#request.sceneId} drafted (attempt ${this.#attempt + 1}): ${words} words, ` +
          `${draft.delta.claims.length} claim(s), ` +
          `${draft.delta.promises?.length ?? 0} promise(s) made, ` +
          `${draft.delta.paysOff?.length ?? 0} paid off.`,
        paths.length > 0 ? `Staged at ${paths[0]}.` : "",
        "Nothing is committed yet. Send it to the verifier.",
      ]
        .filter(Boolean)
        .join("\n"),
      paths,
    );
  }

  /**
   * Verify: deterministic first, then the model only on what it could not settle.
   *
   * The order is the point. The deterministic layer costs nothing and cannot be
   * talked out of a contradiction, so a model is never asked to find what a
   * comparison already found.
   */
  async verify(note?: string): Promise<StepReport> {
    if (this.state !== "STATE_DELTA_PROPOSED") {
      return this.#refuse(
        "verify",
        this.state === "APPROVED"
          ? "this draft has already been approved"
          : "there is no fresh draft to check",
      );
    }

    this.#tx.transition("VALIDATING", "orchestrator");

    const deterministic = verifyDeterministic({
      delta: this.#lastDraft!.delta,
      canon: this.#request.canon,
      knownEntities: this.#request.knownEntities,
    });

    let findings: readonly Finding[] = deterministic.findings;
    let unavailable: string | null = null;
    if (blocking(findings).length === 0) {
      try {
        findings = [
          ...findings,
          ...(await this.#deps.collaborators.review({
            packet: this.#packet!,
            draft: this.#lastDraft!,
            ...(note ? { note } : {}),
          })),
        ];
      } catch (error) {
        if (!(error instanceof VerificationUnavailable)) throw error;
        // The scene still commits: the deterministic layer ran, and discarding
        // sound prose over a provider failure is the worse trade. What must not
        // happen is that it passes quietly — a run whose verifier never spoke
        // reports "0 findings", which reads as a quality result and is not one.
        unavailable = error.message;
        this.#unverified = true;
        this.#warnings.push(`scene never reached the model verifier: ${error.message}`);
      }
    }
    this.#findings = findings;

    const blockers = blocking(findings);
    const warnings = findings.length - blockers.length;

    if (this.#deps.artifacts) {
      this.#lastAuditPath = await this.#deps.artifacts.write(
        artifactPaths.audit(this.#request.sceneId, this.#attempt + 1),
        renderAudit({
          sceneId: this.#request.sceneId,
          attempt: this.#attempt + 1,
          blocking: blockers.length,
          warnings,
          brief: renderRepairBrief(findings),
        }),
      );
    }
    const paths = this.#lastAuditPath ? [this.#lastAuditPath] : [];

    if (blockers.length === 0) {
      this.#tx.transition("APPROVED", "verifier", { findings });
      return report(
        "verify",
        this.state,
        (unavailable
          ? `${this.#request.sceneId} passed the deterministic layer, but the model ` +
            `verifier never ran: ${unavailable} Treat this as unchecked rather than clean. ` +
            `Committing is still the right move — the prose is sound as far as anything ` +
            `could tell — but say so in your account of the scene. `
          : `${this.#request.sceneId} APPROVED with ${warnings} warning(s). ` +
            `Warnings do not block and are not worth a repair round at scene time. `) +
          `Call call_index_manager to fold it into the index and commit.`,
        paths,
      );
    }

    // A finding that survived a rewrite is evidence that another round would
    // buy the same draft again.
    const persistent = unchangedAcrossRound(this.#previousFindings, blockers);
    if (persistent.length > 0) {
      this.#tx.transition("REJECTED", "verifier", { findings });
      this.#terminal = {
        status: "REJECTED",
        reason:
          `${persistent.length} finding(s) survived a rewrite unchanged ` +
          `(${persistent.map((f) => f.id).join(", ")}). Another round would buy the ` +
          `same draft again; the defect needs a decision, not a retry.`,
      };
      return report("verify", this.state, this.#terminal.reason, paths, false);
    }

    if (this.#tx.repairBudgetRemaining <= 0) {
      this.#tx.transition("REJECTED", "verifier", { findings });
      this.#terminal = {
        status: "REJECTED",
        reason:
          `repair budget of ${this.#request.maxRepairs} exhausted with ${blockers.length} ` +
          `blocking finding(s) outstanding`,
      };
      return report("verify", this.state, this.#terminal.reason, paths, false);
    }

    this.#tx.transition("REPAIR_REQUIRED", "verifier", { findings });
    this.#previousFindings = blockers;
    this.#repairBrief = renderRepairBrief(findings);
    this.#attempt += 1;
    return report(
      "verify",
      this.state,
      `${this.#request.sceneId} needs repair: ${blockers.length} blocking finding(s), ` +
        `${warnings} warning(s).` +
        (this.#lastAuditPath ? ` Audit written to ${this.#lastAuditPath}.` : "") +
        ` ${this.#tx.repairBudgetRemaining} repair round(s) left. Call call_writer to repair.`,
      paths,
    );
  }

  /**
   * Backfill every partition this scene touched, then commit it all as one unit.
   *
   * Backfill runs before the commit rather than after, so the prose and
   * everything derived from it are in the same transaction. Committing first
   * and folding afterwards produces an index that lags its own manuscript, and
   * it fails in the direction hardest to notice: the prose looks right until a
   * later scene reads a partition that never updated.
   */
  async commit(note?: string): Promise<StepReport> {
    if (this.state !== "APPROVED") {
      return this.#refuse("commit", "only an approved scene may be committed");
    }
    this.#tx.transition("COMMITTING", "orchestrator");

    let backfillNote = "";
    if (this.#deps.collaborators.backfill) {
      try {
        this.#derived = await this.#deps.collaborators.backfill({
          sceneId: this.#request.sceneId,
          draft: this.#lastDraft!,
          packet: this.#packet!,
          ...(note ? { note } : {}),
        });
      } catch (error) {
        // A backfill that fails does not lose the scene: the prose and the
        // declared delta still land, and the gap shows up in the reference
        // check rather than being silently absent.
        const message = error instanceof Error ? error.message : String(error);
        this.#warnings.push(`backfill failed: ${message}`);
        backfillNote = ` Backfill failed (${message}); prose and delta still committed.`;
      }
    }

    try {
      this.#commit = await this.#deps.index.commit({
        txid: this.#request.txid,
        sceneId: this.#request.sceneId,
        baseCommitId: this.#tx.baseCommitId,
        actor: "index-manager",
        prose: { relPath: this.#request.prosePath, content: this.#lastDraft!.prose },
        stateDelta: [
          {
            relPath:
              this.#request.deltaPath ?? `continuity/deltas/${this.#request.sceneId}.json`,
            content: JSON.stringify(this.#lastDraft!.delta, null, 2),
          },
        ],
        derived: this.#derived,
      });
      this.#tx.transition("COMMITTED", "index-manager");
      return report(
        "commit",
        this.state,
        `${this.#request.sceneId} COMMITTED as ${this.#commit.commitId}. ` +
          `${this.#commit.writtenPaths.length} file(s) written, including ` +
          `${this.#derived.length} backfilled partition file(s). Prose is at ` +
          `${this.#request.prosePath}.${backfillNote}`,
        this.#commit.writtenPaths,
      );
    } catch (error) {
      if (error instanceof CommitRefused && error.code === "STALE_BASE") {
        const head = await this.#deps.index.head();
        this.#tx.markStaleBase(head);
        this.#staleBase = head;
        return report(
          "commit",
          this.state,
          `HEAD moved to ${head} while ${this.#request.sceneId} was being written, so the ` +
            `delta was computed against a world that no longer exists. Rebuild the packet ` +
            `against the new base; do not retry the commit.`,
          [],
          false,
        );
      }
      if (error instanceof CommitRefused) {
        this.#tx.transition("ABORTED", "orchestrator");
        this.#terminal = {
          status: "ABORTED",
          reason: `commit refused (${error.code}): ${error.message}`,
        };
        return report("commit", this.state, this.#terminal.reason, [], false);
      }
      throw error;
    }
  }

  /** Give up on this scene deliberately. Only the orchestrator may. */
  abandon(reason: string): StepReport {
    if (this.isTerminal()) {
      return this.#refuse("abandon", "this scene is already finished");
    }
    this.#tx.transition("ABORTED", "orchestrator");
    this.#terminal = { status: "ABORTED", reason: `abandoned by the orchestrator: ${reason}` };
    return report("abandon", this.state, this.#terminal.reason);
  }

  /** The audit of the most recent attempt, for a caller that wants to quote it. */
  get lastAuditPath(): string | null {
    return this.#lastAuditPath;
  }

  outcome(): SceneOutcome {
    const attempts = this.#tx.attempt + 1;
    const history = this.#tx.snapshot().history.map((h) => h.to);

    if (this.state === "COMMITTED") {
      return {
        status: "COMMITTED",
        commit: this.#commit!,
        attempts,
        history,
        findings: this.#findings,
        derivedPaths: this.#derived.map((d) => d.relPath),
        warnings: [...this.#warnings],
        unverified: this.#unverified,
      };
    }
    if (this.state === "STALE_BASE") {
      return {
        status: "STALE_BASE",
        reason:
          `HEAD moved to ${this.#staleBase} while this scene was being written, so the ` +
          `delta was computed against a world that no longer exists. Rebuild the packet ` +
          `against the new base; do not retry the commit.`,
        newBaseCommitId: this.#staleBase!,
        attempts,
        history,
        findings: this.#findings,
      };
    }
    return {
      status: this.#terminal?.status ?? "ABORTED",
      reason:
        this.#terminal?.reason ??
        `the scene ended in ${this.state} without reaching a commit`,
      attempts,
      history,
      findings: this.#findings,
    };
  }
}
