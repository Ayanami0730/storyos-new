/**
 * The second verification axis: defects that the graders penalise and ConStory's
 * taxonomy cannot express.
 *
 * ## Why this exists
 *
 * Every finding the verifier could raise until now was one of ConStory's nineteen
 * consistency subtypes. That vocabulary is right for one of the two numbers we are
 * scored on and orthogonal to the other, and the measurement says so plainly:
 *
 *  - On `lbw081`, three arms produced S_q of 4.00, 3.17 and 3.33 against a frontier
 *    field at 4.63–4.90. The whole of our deficit is in quality, not length — S_l
 *    was 98.1, the highest in the table, on the fewest words.
 *  - The worst single defect found by reading a finished manuscript was that the
 *    story **had no ending**: the final scene was a confrontation that named nobody
 *    and closed on *"Not yet. There is enough for a warrant."* Every layer passed
 *    it. The verifier checks a scene against the index, and an unresolved ending
 *    contradicts nothing, so there was no subtype it could have been reported as.
 *  - Reading the same manuscript, the scenes restate each other. Verbatim overlap
 *    is near zero, so no textual check sees it, and it is not a contradiction — it
 *    is the same information delivered again, which is what makes a long story feel
 *    padded.
 *
 * None of those three is a consistency error. All three are directly named in the
 * rubrics we are graded by. A gate that cannot express them is a gate that spends
 * its rounds on the axis we already win.
 *
 * ## Where the checks come from
 *
 * Each check below carries `judgedAs`: the scored dimension that penalises it,
 * quoted from the grader's own wording. That field is not documentation, it is the
 * derivation — the point of the axis is that it is *distilled from the scoring*
 * rather than invented from taste, and a check nobody scores has no business
 * costing a repair round.
 *
 * The two sources, both frozen elsewhere in the project:
 *
 *  - **LongBench-Write**, six dimensions scored 1–5 by the judge in
 *    `experiments/longbench-write/judge.txt`: Relevance, Accuracy, Coherence,
 *    Clarity, Breadth and Depth, Reading Experience. This is Table 2's quality
 *    half, and \bar S = (20·S_q + S_l)/2, so one point of S_q is ten of \bar S.
 *  - **LongStoryEval**, whose composite we take as Table 1's quality column.
 *    `docs/08-evaluation-decisions.md` freezes the composite to five of its eight
 *    dimensions — Writing and Language, Themes, Emotional Impact, Enjoyment and
 *    Engagement, Expectation Fulfillment — with Plot, Characters, World-Building
 *    and Overall deliberately excluded so quality is not double-counting the
 *    consistency column. So a craft check justified only by "Plot and Structure"
 *    is justified by a dimension our own protocol does not score, and is marked
 *    accordingly.
 *
 * ## Why only five of these may block
 *
 * The expensive lesson of this repository is that a verifier which raises findings
 * the writer cannot act on makes the book worse: eleven fabricated findings scored
 * 8.4 points below five real ones, because the writer has no index access and
 * cannot tell the two apart, so it spent its rounds damaging prose that was fine.
 * Craft is more subjective than consistency, so the risk is higher here, not lower.
 *
 * Two structural defences, both enforced in code rather than asked for in a prompt:
 *
 *  - **A blocking craft finding must carry a pair.** Either two quotes (this draft
 *    against the earlier scene it repeats, or against itself) or a named
 *    *state pair* — what is true when the scene opens and what is true when it
 *    closes. "This scene is boring" cannot be evidenced and therefore cannot block;
 *    "nothing is different at the end, the opening state and closing state are both
 *    X" can.
 *  - **A cap per round** (`MAX_BLOCKING_CRAFT`). Craft must never crowd out a
 *    consistency repair, because consistency is a metric of record and craft is a
 *    hypothesis about one.
 *
 * Everything else is a warning: it reaches the writer, costs no round, and is
 * counted so the axis can be evaluated from run data.
 */

/** What the verifier must produce before a craft finding is accepted. */
export type CraftEvidence =
  /** Two verbatim quotes: the passage and the passage it repeats or contradicts. */
  | "pair"
  /** What is true at the scene's open, and what is true at its close. */
  | "state-pair"
  /** One verbatim quote from the draft. Warnings only. */
  | "quote";

export interface CraftCheck {
  readonly id: string;
  /**
   * The scored dimensions that penalise this, in the grader's own words.
   *
   * The derivation, and the filter: a check that cannot name one does not belong
   * on this list.
   */
  readonly judgedAs: readonly string[];
  /** What the verifier looks for, phrased as a test it can apply to the draft. */
  readonly lookFor: string;
  readonly evidence: CraftEvidence;
  /** Only these may be raised as `error`, and only with their evidence. */
  readonly canBlock: boolean;
  /** Meaningless anywhere but the last scene of the story. */
  readonly finalSceneOnly?: boolean;
}

/**
 * At most this many craft findings may block one round.
 *
 * Consistency findings are uncapped: they are the metric of record and they carry
 * a quoted pair by construction. Craft is capped because it is the newer and softer
 * axis, and because a round spent on the third-most-important craft defect is a
 * round not spent on a contradiction that will be counted against us.
 */
export const MAX_BLOCKING_CRAFT = 2;

export const CRAFT_CHECKS: readonly CraftCheck[] = [
  {
    id: "off_brief",
    judgedAs: [
      "LongBench-Write Relevance — \"content highly relevant and fully applicable to the user's request\"",
      "LongStoryEval Expectation Fulfillment — \"how effectively the story meets the readers' expectations based on the premise and genres\"",
    ],
    lookFor:
      "the scene does something other than what its card said it would, or drifts off what " +
      "the task actually asked for — a required element of the premise handled as background, " +
      "or a scene that services a thread the task never mentioned",
    evidence: "state-pair",
    canBlock: true,
  },
  {
    id: "restates_prior_scene",
    judgedAs: [
      "LongBench-Write Breadth and Depth — \"seriously lacking breadth and depth with minimal information\"",
      "LongBench-Write Reading Experience — \"boring and hard to understand\"",
    ],
    lookFor:
      "the scene delivers information, a realisation or a beat the reader already has. Not " +
      "the same words — the same content: a suspicion re-voiced, a relationship re-explained, " +
      "a clue re-found. This is what makes a long story feel padded rather than long, and " +
      "verbatim overlap does not detect it",
    evidence: "pair",
    canBlock: true,
  },
  {
    id: "nothing_changes",
    judgedAs: [
      "LongBench-Write Coherence — \"disorganized structure with no coherence\"",
      "LongBench-Write Breadth and Depth",
    ],
    lookFor:
      "the situation at the end of the scene is the situation at the start. Nobody knows " +
      "something new, owes something new, has lost something or has decided. Name the state " +
      "at the open and the state at the close; if you cannot name a difference, that is the " +
      "finding",
    evidence: "state-pair",
    canBlock: true,
  },
  {
    id: "internal_incoherence",
    judgedAs: [
      "LongBench-Write Accuracy — \"content with numerous errors and highly misleading\"",
      "LongBench-Write Coherence",
    ],
    lookFor:
      "the scene contradicts itself, with both halves inside this draft — a detail stated one " +
      "way early and another way late, a character reacting to something they have not been " +
      "told in this scene, a sequence that cannot have happened in the order given. This " +
      "needs no index at all, which is why it is inexcusable to miss",
    evidence: "pair",
    canBlock: true,
  },
  {
    id: "ending_not_delivered",
    judgedAs: [
      "LongBench-Write Accuracy and Relevance",
      "LongStoryEval Expectation Fulfillment",
    ],
    lookFor:
      "the last scene stops instead of ending. The question the premise poses is not answered " +
      "on the page: who, how, and — in a mystery — how the impossibility was possible. An " +
      "arrangement of clues from which a reader could deduce the answer is not the answer. " +
      "Name the question the premise poses and quote where the draft answers it; if you " +
      "cannot quote that, the ending is not delivered",
    evidence: "state-pair",
    canBlock: true,
    finalSceneOnly: true,
  },
  {
    id: "summary_not_scene",
    judgedAs: [
      "LongBench-Write Reading Experience",
      "LongStoryEval Writing and Language — \"the writing style's ability to engage and captivate readers\"",
    ],
    lookFor:
      "events reported rather than dramatised — a paragraph that says an argument happened " +
      "instead of letting it happen. Compression is legitimate and necessary; a scene whose " +
      "central beat is summarised is not compressed, it is skipped",
    evidence: "quote",
    canBlock: false,
  },
  {
    id: "thin_for_its_length",
    judgedAs: ["LongBench-Write Breadth and Depth"],
    lookFor:
      "the scene is near its word target and carries one beat's worth of content, padded with " +
      "restatement, weather, or interiority that repeats itself. The grader penalises this " +
      "and the length score does not reward it",
    evidence: "quote",
    canBlock: false,
  },
  {
    id: "costless_conflict",
    judgedAs: [
      "LongStoryEval Emotional Impact — \"the story's ability to evoke strong and deep emotional impact\"",
    ],
    lookFor:
      "a conflict resolved without costing anybody anything specific. Partial and temporary " +
      "resolutions are fine; free ones read as unearned",
    evidence: "quote",
    canBlock: false,
  },
  {
    id: "theme_stated",
    judgedAs: [
      "LongStoryEval Themes — \"how well the themes are explored throughout the story\"",
    ],
    lookFor:
      "a sentence that explains what the story means, rather than a choice that tests it. " +
      "Quote the sentence — it is almost always removable without loss",
    evidence: "quote",
    canBlock: false,
  },
  {
    id: "flat_diction",
    judgedAs: [
      "LongStoryEval Writing and Language",
      "LongBench-Write Clarity — \"confusing expression with minimal details\"",
    ],
    lookFor:
      "constructions repeating within the scene, filter verbs standing in for perception " +
      "(\"she felt that\", \"he realised that\"), abstraction where a concrete detail belongs, " +
      "or sentence rhythm that does not move with the tension",
    evidence: "quote",
    canBlock: false,
  },
  {
    id: "inert_open_or_close",
    judgedAs: [
      "LongBench-Write Reading Experience",
      "LongStoryEval Enjoyment and Engagement",
    ],
    lookFor:
      "the scene opens on setting or mood rather than a situation already in motion, or closes " +
      "on a mood rather than a specific next beat — an unanswered question, a door about to " +
      "open. In a long story this is what decides whether the reader turns over",
    evidence: "quote",
    canBlock: false,
  },
  {
    id: "genre_promise_unmet",
    judgedAs: [
      "LongStoryEval Expectation Fulfillment",
      "LongBench-Write Relevance",
    ],
    lookFor:
      "the scene declines the obligation its genre carries — a horror scene with nothing at " +
      "stake, a romance scene with no charge between the two people, a mystery scene that " +
      "advances no inference. Breaking a genre promise deliberately is legitimate; it has to " +
      "be visibly deliberate",
    evidence: "quote",
    canBlock: false,
  },
];

if (new Set(CRAFT_CHECKS.map((c) => c.id)).size !== CRAFT_CHECKS.length) {
  throw new Error("craft check ids must be unique — the id is what the finding is counted in");
}

const BY_ID = new Map(CRAFT_CHECKS.map((c) => [c.id, c]));

export function isCraftId(id: string): boolean {
  return BY_ID.has(id);
}

export function craftCheck(id: string): CraftCheck {
  const check = BY_ID.get(id);
  if (!check) throw new Error(`unknown craft check: ${id}`);
  return check;
}

export function blockingCraftIds(): readonly string[] {
  return CRAFT_CHECKS.filter((c) => c.canBlock).map((c) => c.id);
}

/**
 * The craft checklist as the verifier reads it, with the grader's wording attached.
 *
 * The provenance is included rather than stripped for the same reason the tier
 * rationale is given to the orchestrator: an agent told "check whether the scene
 * repeats itself" treats it as one item of taste among many, and an agent told
 * which scored dimension penalises it knows what the check is *for*. It also
 * bounds the axis honestly — the verifier can see that this is a finite list
 * derived from two rubrics, not an invitation to report everything it dislikes.
 */
export function renderCraftChecklist(options: { readonly finalScene: boolean }): string {
  const lines: string[] = [];
  for (const check of CRAFT_CHECKS) {
    if (check.finalSceneOnly && !options.finalScene) continue;
    const mark = check.canBlock ? "can block" : "warning only";
    lines.push(`- **${check.id}** (${mark}) — ${check.lookFor}.`);
    lines.push(`    penalised by: ${check.judgedAs.join("; ")}`);
  }
  return lines.join("\n");
}
