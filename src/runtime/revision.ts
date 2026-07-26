/**
 * The revision phase: what happens after the last scene is drafted.
 *
 * Two gaps close here, and they are the same gap seen from two sides.
 *
 * The global verifier produces revision tasks for the defects a scene gate is
 * structurally blind to — unpaid promises, abilities established and never
 * used. Until now nothing consumed them, which meant the layer existed on
 * paper and changed no prose. A checker whose findings nobody acts on is a
 * measurement, not a mechanism.
 *
 * And the plan was written before any of the prose existed. Our own writer
 * prompt tells the writer it may propose a deviation, because "a plan written
 * before the prose existed does not always survive contact with it" — but a
 * proposal needs somewhere to go. The orchestrator revises the plan; this is
 * where the consequences land.
 *
 * The discipline that makes this safe: a revision **re-opens a committed scene
 * as a new transaction**. It goes through the same gate, the same atomic
 * commit, the same ledger. Revision is not a privileged back door into the
 * index — that would undo the one guarantee the whole design is built on.
 */

import type { Finding } from "../transaction/types.ts";
import type {
  DeclaredPayoff,
  DeclaredPromise,
  SceneDelta,
} from "../verification/deterministic.ts";
import {
  type EstablishedCapability,
  type PlotContract,
  type RevisionTask,
  verifyGlobal,
} from "../verification/global.ts";
import { renderRepairBrief } from "../verification/finding.ts";

/** Build the contract ledger from everything the committed scenes declared. */
export function contractsFrom(
  deltas: readonly SceneDelta[],
): readonly PlotContract[] {
  const paid = new Map<string, DeclaredPayoff & { scene: string }>();
  for (const delta of deltas) {
    for (const payoff of delta.paysOff ?? []) {
      // First payoff wins: a promise kept twice is kept.
      if (!paid.has(payoff.contractId)) {
        paid.set(payoff.contractId, { ...payoff, scene: delta.sceneId });
      }
    }
  }

  const contracts: PlotContract[] = [];
  for (const delta of deltas) {
    for (const promise of delta.promises ?? []) {
      const payoff = paid.get(promise.id);
      contracts.push({
        id: promise.id,
        promise: promise.promise,
        introducedIn: delta.sceneId,
        quote: promise.quote,
        dueBy: promise.dueByScene,
        ...(payoff ? { paidBy: { scene: payoff.scene, quote: payoff.quote } } : {}),
      });
    }
  }
  return contracts;
}

/**
 * Capabilities are inferred from claims rather than declared separately.
 *
 * A separate declaration would be a second thing for the writer to remember and
 * therefore a second thing to forget. Any claim whose attribute reads like an
 * ability is treated as establishing one, and a later scene that mentions it in
 * prose counts as exercising it. Deliberately loose: this layer only ever emits
 * warnings and revision suggestions, so a false positive costs a look, not a
 * blocked commit.
 */
export function capabilitiesFrom(
  deltas: readonly SceneDelta[],
  proseByScene: ReadonlyMap<string, string>,
): readonly EstablishedCapability[] {
  const out: EstablishedCapability[] = [];
  for (const delta of deltas) {
    for (const claim of delta.claims) {
      if (!/(abilit|skill|can_|power|craft|training|talent)/i.test(claim.attribute)) {
        continue;
      }
      const needle = claim.value.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const exercisedIn = [...proseByScene.entries()]
        .filter(
          ([scene, prose]) =>
            scene !== delta.sceneId &&
            needle.some((w) => prose.toLowerCase().includes(w)),
        )
        .map(([scene]) => scene);
      out.push({
        id: `cap-${claim.entity}-${claim.attribute}`,
        entity: claim.entity,
        capability: claim.value,
        establishedIn: delta.sceneId,
        quote: claim.quote,
        exercisedIn,
      });
    }
  }
  return out;
}

export interface RevisionPlan {
  readonly findings: readonly Finding[];
  readonly tasks: readonly RevisionTask[];
  readonly coverage: ReturnType<typeof verifyGlobal>["coverage"];
}

export function planRevisions(input: {
  readonly scenes: readonly string[];
  readonly deltas: readonly SceneDelta[];
  readonly proseByScene: ReadonlyMap<string, string>;
}): RevisionPlan {
  const result = verifyGlobal({
    scenes: input.scenes,
    contracts: contractsFrom(input.deltas),
    capabilities: capabilitiesFrom(input.deltas, input.proseByScene),
  });
  return { findings: result.findings, tasks: result.revisions, coverage: result.coverage };
}

/**
 * The brief for one revision, addressed to the writer.
 *
 * Two things it must say that a scene-time repair brief does not. The prose is
 * already committed and read by whatever came after it, so a revision may not
 * contradict later scenes — that is a new defect traded for an old one. And the
 * fix usually belongs across a span, not at the deadline: a payoff dropped in
 * at the last moment with no preparation reads worse than the abandonment it
 * was meant to repair.
 */
export function renderRevisionBrief(
  task: RevisionTask,
  proseByScene: ReadonlyMap<string, string>,
): string {
  const span = task.targetScenes;
  return [
    `Revision of committed prose. ${task.rationale}.`,
    "",
    renderRepairBrief([task.finding]),
    "",
    `Scenes in scope: ${span.join(", ")}.`,
    "",
    "Two constraints that do not apply to a scene-time repair:",
    "  - Everything after this span is already written. Your revision must not",
    "    contradict it; if the only honest fix would, say so instead of doing it.",
    "  - Prefer preparation spread across the span over a single insertion at the",
    "    end. A payoff that arrives with no groundwork reads worse than the",
    "    abandonment it repairs.",
    "",
    "Current text of the scenes in scope:",
    ...span.map((s) => `\n### ${s}\n${proseByScene.get(s) ?? "(missing)"}`),
  ].join("\n");
}

export type { DeclaredPromise, RevisionTask };
