/**
 * Layer 3 — the global pass, over a finished span.
 *
 * This layer exists because of a structural fact about the taxonomy we are
 * scored against: five of ConStory's nineteen subtypes are *negative
 * inferences*. The defect is that something which should have happened did not
 * — a promise never paid off, an established ability never used where it
 * plainly applies, an effect with no set-up. There is no second passage to
 * point at, so the scene gate cannot see them, and no scene can be blocked for
 * them either: at scene 12 an unpaid promise is an open loop, not an error.
 *
 * `abandoned_plot_elements` sits in ConStory's largest category. A system with
 * an excellent scene gate and no global pass pays the gate's full cost and
 * still scores no better than a bare model on it. That is the whole argument
 * for this file.
 *
 * Two consequences shape the design. First, **this layer never blocks a
 * commit** — it emits revision tasks against an already-committed span.
 * Second, the promise ledger makes part of it deterministic: a promise
 * recorded at its introduction, with the scene by which it must pay off, is
 * checkable without a model. Only the residue needs judgement.
 */

import { type Finding, makeFinding } from "./finding.ts";

/**
 * A narrative promise, recorded when it is made rather than reconstructed
 * afterwards. Reconstruction is what makes payoff auditing hard: by the end of
 * a novel, an abandoned promise is invisible precisely because nothing refers
 * to it. Recording at introduction inverts that.
 */
export interface PlotContract {
  readonly id: string;
  /** What was promised, in the terms the text set up. */
  readonly promise: string;
  readonly introducedIn: string;
  /** Verbatim prose that made the promise. */
  readonly quote: string;
  /**
   * The scene by which the reader will feel cheated if nothing has happened.
   * Null means "before the story ends", resolved against the final scene.
   */
  readonly dueBy: string | null;
  /** Set once something pays it off; the scene and the prose that did it. */
  readonly paidBy?: { readonly scene: string; readonly quote: string };
  /**
   * Deliberately left open — a sequel hook, an ambiguity the author wants. A
   * promise the author chose not to keep is not a defect, and a checker that
   * cannot express that will flag every open ending.
   */
  readonly deliberatelyOpen?: string;
}

/** An ability, resource or piece of knowledge the text established. */
export interface EstablishedCapability {
  readonly id: string;
  readonly entity: string;
  readonly capability: string;
  readonly establishedIn: string;
  readonly quote: string;
  /** Scenes where the text shows it being used or explicitly unavailable. */
  readonly exercisedIn: readonly string[];
  /** Why it cannot be used, if the text took it away. */
  readonly revokedBy?: { readonly scene: string; readonly reason: string };
}

export interface GlobalPassInput {
  /** Scenes in narrative order; the span being audited. */
  readonly scenes: readonly string[];
  readonly contracts: readonly PlotContract[];
  readonly capabilities: readonly EstablishedCapability[];
}

/**
 * Work to be scheduled, not a gate decision. Carries the finding that motivated
 * it so a human reading the revision queue can see the evidence.
 */
export interface RevisionTask {
  readonly id: string;
  /** Where the repair should land — usually a span, not one scene. */
  readonly targetScenes: readonly string[];
  readonly rationale: string;
  readonly finding: Finding;
}

export interface GlobalPassResult {
  readonly findings: readonly Finding[];
  readonly revisions: readonly RevisionTask[];
  readonly coverage: {
    readonly scenes: number;
    readonly contractsChecked: number;
    readonly contractsOpen: number;
    readonly capabilitiesChecked: number;
  };
}

/**
 * The deterministic half of the global pass: promise payoff and capability use.
 *
 * The LLM half — `causeless_effects`, `skill_power_fluctuations`,
 * `social_norms_violations` — needs a reading of the prose and is a separate
 * call; this function is what does not.
 */
export function verifyGlobal(input: GlobalPassInput): GlobalPassResult {
  const { scenes, contracts, capabilities } = input;
  if (scenes.length === 0) {
    throw new Error("a global pass needs at least one scene of span");
  }
  const order = new Map(scenes.map((s, i) => [s, i]));
  const lastScene = scenes[scenes.length - 1]!;
  const findings: Finding[] = [];
  const revisions: RevisionTask[] = [];

  let open = 0;

  for (const contract of contracts) {
    if (contract.paidBy) continue;
    if (contract.deliberatelyOpen) continue;
    open += 1;

    const dueScene = contract.dueBy ?? lastScene;
    const duePosition = order.get(dueScene);
    // A contract due outside the audited span is simply not yet judgeable.
    if (duePosition === undefined) continue;
    if (duePosition > order.get(lastScene)!) continue;

    const finding = makeFinding({
      subtype: "abandoned_plot_elements",
      validator: "global",
      // Warning is not a softening: at this point the span is already
      // committed, so severity cannot gate anything. It ranks revision work.
      severity: "warning",
      reasoning: `${contract.promise} was set up in ${contract.introducedIn} and should have paid off by ${dueScene}; nothing in the span does`,
      evidence: { quote: contract.quote, source: contract.introducedIn },
      editLocus: {
        kind: "unresolved",
        question: `pay off "${contract.promise}", or mark it deliberately open with a reason`,
      },
    });
    findings.push(finding);
    revisions.push({
      id: `rev-${contract.id}`,
      // The repair spans from the promise to its deadline: a payoff dropped in
      // at the end without preparation reads worse than the abandonment.
      targetScenes: scenes.slice(
        order.get(contract.introducedIn) ?? 0,
        duePosition + 1,
      ),
      rationale: `unpaid promise from ${contract.introducedIn}`,
      finding,
    });
  }

  for (const cap of capabilities) {
    if (cap.revokedBy) continue;
    if (cap.exercisedIn.length > 0) continue;
    const established = order.get(cap.establishedIn);
    if (established === undefined) continue;
    // Established in the final scene: there was no later scene in which to use
    // it, so silence is not evidence of anything.
    if (established >= scenes.length - 1) continue;

    const finding = makeFinding({
      subtype: "forgotten_abilities",
      validator: "global",
      severity: "warning",
      reasoning: `${cap.entity}'s ${cap.capability} was established in ${cap.establishedIn} and never used or removed anywhere in the span`,
      evidence: { quote: cap.quote, source: cap.establishedIn },
      editLocus: {
        kind: "unresolved",
        question: `use ${cap.capability}, explain why it does not apply, or revoke it in the text`,
      },
    });
    findings.push(finding);
    revisions.push({
      id: `rev-${cap.id}`,
      targetScenes: scenes.slice(established + 1),
      rationale: `unused established capability from ${cap.establishedIn}`,
      finding,
    });
  }

  return {
    findings,
    revisions,
    coverage: {
      scenes: scenes.length,
      contractsChecked: contracts.length,
      contractsOpen: open,
      capabilitiesChecked: capabilities.length,
    },
  };
}
