/**
 * How much a scene is allowed to spend on asking, checking and repairing —
 * decided per scene from where it sits in the story.
 *
 * Until now these were three constants: three follow-up questions, two repair
 * rounds, one previous scene of recall, the same for scene 1 and scene 40. A
 * constant is the right shape only if the risk it guards against is constant,
 * and the project's own motivation experiment says it is not.
 *
 * ## What the measurement actually says
 *
 * `experiments/degradation` ran a bare long-context baseline over four premises
 * at five target lengths and scored every output with ConStory's five-category
 * checker. Detected consistency-error *instances* rise with the length of the
 * finished text — Pearson r = 0.711 over the sixteen-cell set, and the per-premise
 * correlations were 0.993, 0.665, 0.984 and 0.967, all four positive. Mean error
 * instances per length tier went 7.25 → 8.25 → 22.0 → 36.0. Timeline/plot and
 * factual detail together account for 54.8% of them, which are precisely the two
 * classes that depend on material written earlier.
 *
 * Two honesty constraints come with that number and both matter here.
 *
 * The official CED metric does **not** rise with length (r = -0.377); it is
 * length-normalised over nineteen *binary* subtypes, so a long text saturates
 * its numerator while its denominator keeps growing. The claim this schedule
 * rests on is the absolute error burden, not CED, and writing it the other way
 * round would be citing the experiment for the opposite of its finding.
 *
 * And the experiment varies *total length across runs*, not *position within one
 * run*. That a later scene carries more risk than an earlier one is an inference
 * from it — a well-motivated one, since what both have in common is the volume of
 * prior text a passage must stay consistent with, but an inference. So every
 * scene's allocation is recorded in the summary next to that scene's findings,
 * which is what makes the schedule falsifiable from our own runs instead of
 * merely plausible.
 *
 * ## Why it is an allocation and not an increase
 *
 * The opening tier gets *less* than the old constants did: one repair round where
 * the flag defaulted to two. Spending the same everywhere means overpaying where
 * defects are rare to afford a ceiling that is too low where they are not, and
 * moving that spend is the whole point. A run that finishes with its endgame
 * allowance unspent has lost nothing; a run that ran out of rounds on scene 12 of
 * 14 has lost the ending.
 */

/** Where in the story a scene sits, coarsely enough to act on. */
export type AllocationTier = "opening" | "middle" | "endgame";

export interface TierPolicy {
  readonly tier: AllocationTier;
  /** Upper bound, exclusive, of the story fraction this tier covers. */
  readonly until: number;
  /** Questions the writer may put to the context-builder before drafting. */
  readonly followUpRounds: number;
  /** Verifier→writer repair rounds before the scene lands as it stands. */
  readonly repairRounds: number;
  /**
   * Previous scenes whose prose goes into the packet at P2.
   *
   * The third lever, and the one the brief asked for first — *"需要更多
   * context"*. One scene of recall is enough to open a chapter and not enough to
   * land an ending, because an ending has to be consistent with everything, and
   * the summarised beat list carries intent rather than the detail a
   * contradiction lives in.
   */
  readonly recentScenes: number;
}

/**
 * The schedule, from the brief: *"前 30% 有 1 次，30%-60% 有最多 3 次，60-100 有 5 次上限"*.
 *
 * The two loops move together on purpose. A writer that may ask more questions
 * and still gets one repair round has been given a better first draft and no way
 * to fix the draft it produced; a writer with five repair rounds and one question
 * spends them rediscovering what it could have asked. They are two halves of the
 * same loop — ask, be told, draft, be checked, repair — so they scale as one.
 */
export const SCHEDULE: readonly TierPolicy[] = [
  { tier: "opening", until: 0.3, followUpRounds: 1, repairRounds: 1, recentScenes: 1 },
  { tier: "middle", until: 0.6, followUpRounds: 3, repairRounds: 3, recentScenes: 2 },
  { tier: "endgame", until: Infinity, followUpRounds: 5, repairRounds: 5, recentScenes: 3 },
];

export interface SceneAllocation {
  readonly tier: AllocationTier;
  /** 0–1, where this scene sits in the story. */
  readonly position: number;
  readonly followUpRounds: number;
  readonly repairRounds: number;
  readonly recentScenes: number;
  /** Whether a fixed override replaced the schedule, for the ablation arm. */
  readonly pinned: boolean;
  /** Why this scene has this allowance, in words the orchestrator can act on. */
  readonly rationale: string;
}

/**
 * A scene's position, measured at its midpoint.
 *
 * `(i - 0.5) / total` rather than `i / total` or `(i - 1) / total`, because those
 * two put an endpoint exactly on a boundary: the first scene of any story would
 * sit at position 0, which claims it carries no accumulated risk, and the last
 * would sit at 1.0. The midpoint also divides evenly — with ten scenes it puts
 * three in `opening`, three in `middle` and four in `endgame`, which is the
 * 30/30/40 split the schedule is written as.
 */
export function positionOf(sceneIndex: number, total: number): number {
  if (total <= 0) return 1;
  const clamped = Math.min(Math.max(sceneIndex, 1), total);
  return (clamped - 0.5) / total;
}

export function tierFor(position: number): TierPolicy {
  return SCHEDULE.find((p) => position < p.until) ?? SCHEDULE[SCHEDULE.length - 1]!;
}

/**
 * What scene `sceneIndex` of `total` may spend.
 *
 * `pinnedRepairs` is the ablation arm rather than a convenience. "Does allocating
 * by position beat allocating uniformly" is only answerable if a run can be
 * configured to allocate uniformly, and the honest comparison needs the uniform
 * arm to exist in the same code rather than in a previous version of it.
 */
export function allocate(input: {
  readonly sceneIndex: number;
  readonly total: number;
  readonly pinnedRepairs?: number | null;
}): SceneAllocation {
  const position = positionOf(input.sceneIndex, input.total);
  const policy = tierFor(position);
  const pinned = typeof input.pinnedRepairs === "number";

  return {
    tier: policy.tier,
    position: Number(position.toFixed(3)),
    followUpRounds: pinned ? input.pinnedRepairs! : policy.followUpRounds,
    repairRounds: pinned ? input.pinnedRepairs! : policy.repairRounds,
    recentScenes: pinned ? 1 : policy.recentScenes,
    pinned,
    rationale: pinned
      ? `every scene pinned to ${input.pinnedRepairs} round(s) and one scene of recall ` +
        `(--max-repairs was given a number, so the position schedule is off; this is the ` +
        `uniform-allocation arm)`
      : RATIONALE[policy.tier],
  };
}

/**
 * Why each tier gets what it gets, addressed to the agent spending it.
 *
 * Written as a reason rather than a number because a number alone gets treated
 * as a quota. An orchestrator told "you have five repair rounds" spends five; one
 * told why the fifth exists spends it when the ending needs it.
 */
const RATIONALE: Readonly<Record<AllocationTier, string>> = {
  opening:
    "opening third: almost nothing has been established yet, so there is little for this " +
    "scene to contradict and little for the writer to have to look up. The allowance is " +
    "deliberately tight — rounds not spent here are what pay for the endgame, where the same " +
    "round buys much more",
  middle:
    "middle third: enough is on the page now that this scene has to agree with it, and the " +
    "material a contradiction would live in is no longer all in front of you. Ask before " +
    "drafting rather than repairing afterwards; a question costs a fraction of a repair round",
  endgame:
    "final 40%: this is where the measured degradation is. Consistency errors accumulate " +
    "against the volume of prose already written, and timeline and factual detail — the two " +
    "classes that depend most on earlier text — are over half of them. Payoffs land here, " +
    "which means this scene has to be consistent with everything before it rather than with " +
    "its neighbour. The full allowance exists for exactly this and is not worth saving",
};

/** The allowance as the orchestrator sees it, with the reason attached. */
export function renderAllocation(allocation: SceneAllocation): string {
  return [
    `Allowance for this scene (${allocation.tier}, position ${allocation.position} of the ` +
      `story): ${allocation.repairRounds} repair round(s), ${allocation.followUpRounds} ` +
      `follow-up question(s) for the writer, ${allocation.recentScenes} previous scene(s) of ` +
      `prose in the packet.`,
    `Why: ${allocation.rationale}.`,
    `It is a ceiling, not a quota. Spending a repair round on a defect the writer cannot see ` +
      `how to fix buys the same draft again — a finding that survives a rewrite unchanged ` +
      `ends the loop whatever the allowance says.`,
  ].join("\n");
}

/**
 * Which allocation the resident tools are working under right now.
 *
 * The same seam as `SceneToolBus` and `SceneStage`, for the same reason: the
 * writer's `ask_context_builder` is registered once at construction because the
 * writer is resident, so its round limit cannot be a value captured then. It has
 * to be a question asked at call time, or scene 40 would be policed by scene 1's
 * allowance.
 */
export class AllocationState {
  #current: SceneAllocation = allocate({ sceneIndex: 1, total: 1 });

  open(allocation: SceneAllocation): void {
    this.#current = allocation;
  }

  get current(): SceneAllocation {
    return this.#current;
  }

  get followUpRounds(): number {
    return this.#current.followUpRounds;
  }
}
