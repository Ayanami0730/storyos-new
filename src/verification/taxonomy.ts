/**
 * ConStory's five categories and nineteen subtypes, plus the property that
 * actually decides our architecture: *what evidence a subtype needs*.
 *
 * We adopt their taxonomy because it is what we are scored against
 * (`storyos/benchmarks/constory/taxonomy.py` mirrors the same nineteen names).
 * We do not adopt their aggregation: their CED collapses each subtype's record
 * list to a boolean, so five naming errors and one score identically. We count
 * instances (EID) — see `docs/08-evaluation-decisions.md` §1.
 *
 * The tier below is ours, not theirs, and it is the reason the verifier has
 * three layers instead of one:
 *
 *  - `explicit-pair` — the defect is two passages that contradict each other.
 *    Both sides exist in text, so a scene-level check can find it as soon as
 *    the second side is written, and it can block a commit.
 *
 *  - `negative-inference` — the defect is that something which *should* have
 *    happened did not: a promise never paid off, an established ability never
 *    used when it obviously applies, an effect with no set-up. There is no
 *    second passage to point at. A scene-level gate is structurally blind to
 *    these, and a scene cannot be blocked for them either: at scene 12 an
 *    unpaid promise is not yet an error, it is an open loop. They can only be
 *    judged over a finished span, and can only produce revision work.
 *
 *  - `stylistic` — a property of the prose itself, judged locally, with no
 *    cross-scene evidence at all. Cheap per scene, but the most subjective;
 *    never a hard block.
 *
 * Getting this wrong is expensive in a specific way: `abandoned_plot_elements`
 * sits in ConStory's largest category, and a scene-only gate cannot see it, so
 * a system with an excellent gate would still score no better than a bare model
 * on it while paying the gate's full cost.
 */

export const ERROR_CATEGORIES = [
  "timeline_plot_logic",
  "characterization",
  "world_building_setting",
  "factual_detail",
  "narrative_style",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** Which verification layer can see a subtype at all. */
export type EvidenceTier = "explicit-pair" | "negative-inference" | "stylistic";

export interface SubtypeSpec {
  readonly subtype: string;
  readonly category: ErrorCategory;
  readonly tier: EvidenceTier;
  /** One line, phrased as what the checker looks for. Feeds the LLM prompt. */
  readonly lookFor: string;
}

export const SUBTYPES: readonly SubtypeSpec[] = [
  {
    subtype: "absolute_time_contradictions",
    category: "timeline_plot_logic",
    tier: "explicit-pair",
    lookFor:
      "two statements that place the same event at incompatible dates, seasons or times of day",
  },
  {
    subtype: "duration_timeline_contradictions",
    category: "timeline_plot_logic",
    tier: "explicit-pair",
    lookFor:
      "an elapsed span that cannot hold the events assigned to it, or that contradicts a stated duration",
  },
  {
    subtype: "simultaneity_contradictions",
    category: "timeline_plot_logic",
    tier: "explicit-pair",
    lookFor: "one character or object present in two places at the same time",
  },
  {
    subtype: "causeless_effects",
    category: "timeline_plot_logic",
    tier: "negative-inference",
    lookFor:
      "an ability, object or piece of knowledge that appears in use with no earlier scene granting it",
  },
  {
    subtype: "causal_logic_violations",
    category: "timeline_plot_logic",
    tier: "explicit-pair",
    lookFor:
      "a consequence that does not follow from its stated cause, or that reverses an established mechanism",
  },
  {
    subtype: "abandoned_plot_elements",
    category: "timeline_plot_logic",
    tier: "negative-inference",
    lookFor:
      "a question, threat, goal or relationship introduced with weight and then never resolved or referenced again",
  },
  {
    subtype: "memory_contradictions",
    category: "characterization",
    tier: "explicit-pair",
    lookFor:
      "a character forgetting an experience or relationship the text established, or recalling one it never did",
  },
  {
    subtype: "knowledge_contradictions",
    category: "characterization",
    tier: "explicit-pair",
    lookFor:
      "a character acting on information they were never given, or ignorant of information they were",
  },
  {
    subtype: "skill_power_fluctuations",
    category: "characterization",
    tier: "negative-inference",
    lookFor:
      "a competence that varies between scenes without the text accounting for the change",
  },
  {
    subtype: "forgotten_abilities",
    category: "characterization",
    tier: "negative-inference",
    lookFor:
      "an established ability that would obviously resolve the current problem and is neither used nor explained away",
  },
  {
    subtype: "core_rules_violations",
    category: "world_building_setting",
    tier: "explicit-pair",
    lookFor:
      "an action that breaks a magic, physical or technological rule the text itself laid down",
  },
  {
    subtype: "social_norms_violations",
    category: "world_building_setting",
    tier: "negative-inference",
    lookFor:
      "an established law, hierarchy or taboo violated with none of the consequences the text promised",
  },
  {
    subtype: "geographical_contradictions",
    category: "world_building_setting",
    tier: "explicit-pair",
    lookFor:
      "a place whose properties, or whose position relative to other places, drifts between scenes",
  },
  {
    subtype: "appearance_mismatches",
    category: "factual_detail",
    tier: "explicit-pair",
    lookFor: "hair, eye colour, scars, height, clothing or other physical detail that changes",
  },
  {
    subtype: "nomenclature_confusions",
    category: "factual_detail",
    tier: "explicit-pair",
    lookFor: "a name spelled differently, or applied to the wrong entity",
  },
  {
    subtype: "quantitative_mismatches",
    category: "factual_detail",
    tier: "explicit-pair",
    lookFor: "ages, dates, counts, distances or prices that do not add up across passages",
  },
  {
    subtype: "perspective_confusions",
    category: "narrative_style",
    tier: "stylistic",
    lookFor: "narrative person or focal character switching without a transition",
  },
  {
    subtype: "tone_inconsistencies",
    category: "narrative_style",
    tier: "stylistic",
    lookFor: "register shifting in a way the scene does not motivate",
  },
  {
    subtype: "style_shifts",
    category: "narrative_style",
    tier: "stylistic",
    lookFor: "sentence rhythm, diction or density departing from the established voice",
  },
] as const;

if (new Set(SUBTYPES.map((s) => s.subtype)).size !== 19) {
  throw new Error("the ConStory taxonomy must carry nineteen unique subtypes");
}

export type ErrorSubtype = (typeof SUBTYPES)[number]["subtype"];

const BY_SUBTYPE = new Map(SUBTYPES.map((s) => [s.subtype, s]));

export function subtypeSpec(subtype: string): SubtypeSpec {
  const spec = BY_SUBTYPE.get(subtype);
  if (!spec) throw new Error(`unknown error subtype: ${subtype}`);
  return spec;
}

export function subtypesForTier(tier: EvidenceTier): readonly SubtypeSpec[] {
  return SUBTYPES.filter((s) => s.tier === tier);
}

export function subtypesForCategory(category: ErrorCategory): readonly SubtypeSpec[] {
  return SUBTYPES.filter((s) => s.category === category);
}

/**
 * Can a scene-level gate block a commit for this subtype?
 *
 * Only for explicit contradiction pairs. A negative inference is not yet an
 * error when the scene is written — an unpaid promise at scene 12 is an open
 * loop — and a stylistic judgement is too soft to refuse prose over.
 */
export function isBlockingSubtype(subtype: string): boolean {
  return subtypeSpec(subtype).tier === "explicit-pair";
}

/**
 * Exemptions copied in spirit from ConStory's own checker prompts, which spend
 * a section telling the model that metaphor, irony, unreliable narration,
 * stream of consciousness and deliberate dramatic effect are not defects, and
 * to prefer the literary reading when in doubt.
 *
 * We need this more than they do, not less: their checker reads a finished
 * story by a third party, ours inspects prose it just helped produce, on every
 * scene, and a verifier that flags its own deliberate ambiguity as a
 * contradiction will burn the entire repair budget on false positives.
 */
export const LITERARY_EXEMPTIONS: readonly string[] = [
  "metaphor, simile and figurative language are not factual claims",
  "irony, sarcasm and understatement mean the opposite of their surface",
  "an unreliable or limited narrator may state things the story contradicts on purpose",
  "a character may lie, misremember or be mistaken; that is characterisation, not a defect",
  "dream, hallucination, hypothetical and counterfactual passages do not assert fact",
  "stream of consciousness may break grammar, tense and chronology deliberately",
  "foreshadowing and deliberate withholding are not abandoned plot elements",
  "a stated time may be approximate when a character is estimating",
  "when a passage admits both a literary and a defective reading, choose the literary one",
] as const;
