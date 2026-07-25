/**
 * Context packet vocabulary.
 *
 * A packet is what the writer sees. Two rules govern it:
 *
 *  - Assembly is priority-ordered, never similarity-ranked. P0/P1 material
 *    cannot be displaced by something that merely looks more relevant.
 *  - A missing hard-required id fails the build. v2's failure mode was letting
 *    the writer "reasonably infer" absent state, which is how ungranted
 *    knowledge entered the prose and then cost a repair round to remove.
 */

/**
 * P0 hard constraints — scene card, world rules, reveal limits, base revision.
 * P1 present entities' state and beliefs.
 * P2 direct dependencies — previous scene prose, triggered contracts.
 * P3 remote recall.
 * P4 optional background.
 */
export const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Tiers that may never be dropped to fit a budget. */
export const MANDATORY_PRIORITIES: readonly Priority[] = ["P0", "P1"];

export interface ContextItem {
  readonly id: string;
  readonly priority: Priority;
  /** Provenance: where in the canonical index this came from. */
  readonly source: string;
  readonly content: string;
}

export interface PacketRequest {
  readonly sceneId: string;
  readonly baseCommitId: string;
  /**
   * Ids the scene cannot be written without. Every one must resolve to an
   * available item or the build fails.
   */
  readonly hardRequiredIds: readonly string[];
  /** Word budget for the assembled packet. */
  readonly budgetWords: number;
}

export interface CoverageReport {
  readonly sceneId: string;
  readonly baseCommitId: string;
  readonly budgetWords: number;
  readonly usedWords: number;
  readonly includedIds: readonly string[];
  /** Items left out for budget reasons, with the tier they belonged to. */
  readonly excluded: readonly { readonly id: string; readonly priority: Priority }[];
  /** Per-tier accounting so a reader can see what got squeezed. */
  readonly byPriority: Readonly<Record<Priority, { included: number; excluded: number; words: number }>>;
  /** True when every optional tier fitted as well; useful as a quality signal. */
  readonly complete: boolean;
}

export interface ContextPacket {
  readonly request: PacketRequest;
  readonly items: readonly ContextItem[];
  readonly coverage: CoverageReport;
  readonly rendered: string;
}

export class PacketBuildError extends Error {
  readonly missingIds: readonly string[];
  readonly overflowPriorities: readonly Priority[];

  constructor(
    message: string,
    detail: {
      readonly missingIds?: readonly string[];
      readonly overflowPriorities?: readonly Priority[];
    } = {},
  ) {
    super(message);
    this.name = "PacketBuildError";
    this.missingIds = detail.missingIds ?? [];
    this.overflowPriorities = detail.overflowPriorities ?? [];
  }
}
