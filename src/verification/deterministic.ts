/**
 * Layer 1 — deterministic scene checks.
 *
 * Runs before any model is called, for two reasons. It is free, so anything it
 * can settle should never cost a token. And it is *certain*: an LLM verifier
 * shares the writer's blind spots, so the checks that do not need judgement
 * must not be delegated to one.
 *
 * What it can decide: whether the proposed state delta is well-formed, whether
 * it references things that exist, and whether a claim in the delta directly
 * contradicts a fact already in canon. That last one is a genuine
 * contradiction pair — both sides are written down — so it may block a commit.
 *
 * What it cannot decide is everything requiring a reading of the prose. Those
 * go to layer 2, and the negative inferences go to the global layer.
 */

import { type Finding, makeFinding } from "./finding.ts";
import { type DeclaredVoice, findPersonDrift } from "./person.ts";
import {
  type OrthographyConvention,
  findOrthographyDrift,
  findScriptDrift,
  renderConvention,
} from "./orthography.ts";
import { paths } from "../index/tree.ts";

/** A fact already in canon, as the context packet supplied it. */
export interface CanonFact {
  readonly id: string;
  /** Subject the fact is about: a character, location, object id. */
  readonly entity: string;
  /** Which property of it, e.g. "eye_colour", "age", "location". */
  readonly attribute: string;
  /** The established value, compared case- and whitespace-insensitively. */
  readonly value: string;
  /** Where it was established. */
  readonly source: string;
  readonly span?: string;
}

/** One assertion the writer proposes to add to canon from this scene. */
export interface ProposedClaim {
  readonly entity: string;
  readonly attribute: string;
  readonly value: string;
  /** Verbatim prose the claim was extracted from. Required: see below. */
  readonly quote: string;
  /**
   * Set when the writer means to overwrite canon on purpose — a character dyes
   * their hair, a place is renamed. Without this the same edit is a defect;
   * with it, it is a story event. v2 had no way to say this, so intentional
   * change and error were indistinguishable.
   */
  readonly supersedes?: { readonly factId: string; readonly reason: string };
}

/**
 * A promise the scene makes to the reader, recorded when it is made.
 *
 * Recording at introduction rather than reconstructing later is the whole
 * trick: by the end of a novel an abandoned promise is invisible precisely
 * because nothing refers to it, so nothing can be found by searching. A ledger
 * written forwards can be checked backwards.
 */
export interface DeclaredPromise {
  readonly id: string;
  readonly promise: string;
  /** Verbatim prose that made it. */
  readonly quote: string;
  /** Scene by which the reader will feel cheated; null means before the end. */
  readonly dueByScene: string | null;
}

export interface DeclaredPayoff {
  readonly contractId: string;
  readonly quote: string;
}

export interface SceneDelta {
  readonly sceneId: string;
  readonly claims: readonly ProposedClaim[];
  /** Entity ids the scene says are present. */
  readonly presentEntities: readonly string[];
  readonly promises?: readonly DeclaredPromise[];
  readonly paysOff?: readonly DeclaredPayoff[];
}

export interface DeterministicInput {
  readonly delta: SceneDelta;
  readonly canon: readonly CanonFact[];
  /** Every entity id the index knows about, for reference integrity. */
  readonly knownEntities: ReadonlySet<string>;
  /**
   * The staged prose and the person the plan declared for the whole book.
   *
   * Optional so the many call sites that check a delta alone are unaffected, but
   * supplying it is the difference between catching the largest single class of
   * error this system produces and not: `perspective_confusions` was seven of
   * the nine errors in the first 20,000-word manuscript, and the model verifier
   * reported none of them. See `person.ts`.
   */
  readonly prose?: string;
  readonly voice?: DeclaredVoice;
  /**
   * The spelling and quotation convention the committed scenes established.
   *
   * The same shape of defect as the person, one layer down, and the one that took
   * its place once the person was fixed: `style_shifts` is the largest subtype
   * across every manuscript on the fixed harness, 30 of 87 kept instances, and on
   * `task-literary-yesteryear` five of its six were `memorised`/`memorized`,
   * `labour`/`labor`, `realised`/`realized`, `practised`/`practiced`,
   * `flavour`/`flavor`. The writer resets per scene, so eight scenes each chose.
   * Absent on the first scene, which is what establishes it. See `orthography.ts`.
   */
  readonly convention?: OrthographyConvention;
}

/**
 * How many person-drift findings one scene may raise.
 *
 * A scene that slips in nine sentences is one defect with nine symptoms, and the
 * writer needs the instruction once. Two, so the repair brief can show the
 * pattern rather than a single line that might read as a one-off.
 */
const MAX_PERSON_DRIFT_FINDINGS = 2;

const normalise = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/** A canon fact as the other half of a contradiction pair. */
const asEvidence = (fact: CanonFact) => ({
  quote: fact.value,
  source: fact.source,
  ...(fact.span ? { span: fact.span } : {}),
});

/**
 * Coverage, reported alongside the findings.
 *
 * v2 capped audit extraction at five claims and three knowledge uses per scene,
 * so its gate inspected a sample of what it was meant to protect while
 * reporting as if it had inspected everything
 * (`docs/03-v2-postmortem.md`). We impose no cap; instead every run states how
 * much was checked, so the coverage→EID relationship can be *measured* rather
 * than assumed.
 */
export interface CoverageStats {
  readonly claims: number;
  readonly claimsCheckedAgainstCanon: number;
  readonly canonFactsInScope: number;
  readonly presentEntities: number;
  /**
   * Changes absorbed because the attribute is one that changes.
   *
   * Reported rather than merely skipped: this is the count of findings the check
   * *would* have raised before, and every one of them was a false positive that
   * could block a commit. If it climbs to where it dwarfs the real contradictions,
   * the attribute list is the thing to look at.
   */
  readonly volatileChanges: number;
}

export interface DeterministicResult {
  readonly findings: readonly Finding[];
  readonly coverage: CoverageStats;
}

/**
 * What the layer covered when it could not run at all.
 *
 * Zeroes rather than omission: the coverage numbers exist so the relationship
 * between how much was checked and how many defects survived can be measured, and
 * a missing row would quietly average as if the scene had been checked.
 */
export function emptyCoverage(): CoverageStats {
  return {
    claims: 0,
    claimsCheckedAgainstCanon: 0,
    canonFactsInScope: 0,
    presentEntities: 0,
    volatileChanges: 0,
  };
}

export function verifyDeterministic(input: DeterministicInput): DeterministicResult {
  const { delta, canon, knownEntities } = input;
  const findings: Finding[] = [];

  // Index canon by entity+attribute so a claim is compared only against the
  // fact it actually addresses.
  const canonIndex = new Map<string, CanonFact>();
  for (const fact of canon) {
    canonIndex.set(`${fact.entity}\u0000${fact.attribute}`, fact);
  }
  const supersededIds = new Set(
    delta.claims.flatMap((c) => (c.supersedes ? [c.supersedes.factId] : [])),
  );

  let checked = 0;
  /** Claims whose value changed on an attribute that is supposed to change. */
  let volatile = 0;

  for (const claim of delta.claims) {
    // Reference integrity. An unknown entity is fatal rather than an error:
    // committing it would put a dangling id into canonical state, and every
    // later check against that id would silently pass.
    if (!knownEntities.has(claim.entity)) {
      findings.push(
        makeFinding({
          subtype: "nomenclature_confusions",
          validator: "reference",
          severity: "fatal",
          reasoning: `the delta asserts something about "${claim.entity}", which is not an entity in the index; committing it would create a dangling reference`,
          evidence: { quote: claim.quote, source: delta.sceneId },
          contradicts: {
            quote: `known entities: ${[...knownEntities].slice(0, 12).join(", ")}${knownEntities.size > 12 ? ", …" : ""}`,
            source: "index/story/bible",
          },
          editLocus: {
            kind: "unresolved",
            question: `is "${claim.entity}" a new entity that should be created, or a misspelling of an existing one?`,
          },
        }),
      );
      continue;
    }

    const existing = canonIndex.get(`${claim.entity}\u0000${claim.attribute}`);
    if (!existing) continue;
    checked += 1;

    if (normalise(existing.value) === normalise(claim.value)) continue;

    /**
     * A value that changed because time passed is not a contradiction.
     *
     * Measured on `runs-070/lbw070` s-002. Two children walk from a house to the
     * street. The writer recorded `char-eloise.location = loc-main-street`, canon
     * held `loc-eloise-house` from the previous scene, and this check raised
     * `geographical_contradictions` at severity `error` — twice, once per child,
     * with the *same finding id* because both quote the same sentence. Attempt 2
     * produced the same two, so the stall detector fired and the scene committed
     * carrying two recorded defects. Neither was a defect. The characters walked.
     *
     * Three things are wrong with treating that as a contradiction, and they
     * compound:
     *
     * It punishes what the writer was told to do. `agents/writer/AGENT.md` gives
     * `location: lighthouse` as the model example of a standing property — "ask
     * what the event *left behind*, and record that". Recording it then produces a
     * blocking finding whose only remedy is a `supersedes` declaration for every
     * step anybody takes.
     *
     * It misuses the subtype. ConStory's `geographical_contradictions` is "a place
     * whose properties, or whose position relative to other places, drifts between
     * scenes" — a property of *places*, not a person being in different places at
     * different times. The subtype for a person in two places is
     * `simultaneity_contradictions`, and that needs a shared time, which no
     * value comparison can establish.
     *
     * And it costs the scarcest thing in the loop. A false positive spends a repair
     * round and the writer, which cannot look anything up, spends it damaging prose
     * that was correct — the failure that already cost this project 8.4 points once.
     *
     * So a volatile attribute's change is absorbed silently: the later value wins,
     * which is what `absorb` already does, and the dossier shows the verifier the
     * move so it can still ask whether the prose accounts for it. What remains
     * blocking is a change to something intrinsic — eye colour, a name, an age — for
     * which "it changed" really does need a reason.
     */
    if (isVolatileAttribute(claim.attribute)) {
      volatile += 1;
      continue;
    }

    // The values differ. Whether that is a defect depends entirely on whether
    // the writer said it was deliberate.
    if (claim.supersedes?.factId === existing.id) continue;

    if (claim.supersedes && claim.supersedes.factId !== existing.id) {
      findings.push(
        makeFinding({
          subtype: "nomenclature_confusions",
          validator: "reference",
          severity: "error",
          reasoning: `the claim declares it supersedes ${claim.supersedes.factId}, but the fact it actually contradicts is ${existing.id}`,
          evidence: { quote: claim.quote, source: delta.sceneId },
          contradicts: asEvidence(existing),
          editLocus: {
            kind: "unresolved",
            question: `did you mean to supersede ${existing.id} instead of ${claim.supersedes.factId}?`,
          },
        }),
      );
      continue;
    }

    /**
     * A value that is a sentence cannot be compared by string equality.
     *
     * Measured on `runs-r1/lbw079`. Canon held
     * `char-narrator.keeps_written_records = "timestamps and records events in
     * notebook"`; the scene declared `"records timestamps and findings in
     * notebook"`. Those are the same fact in different words, and this check
     * reported it as a blocking `quantitative_mismatches` — a subtype about counts,
     * reached only because the attribute matched none of the patterns and that is
     * the fallback.
     *
     * The distinction that matters is not which subtype but what kind of value it
     * is. The checks ConStory's taxonomy is built around compare *atomic* facts —
     * an eye colour, an age, a count, a place — where two different strings really
     * are two different claims. A value that is a phrase describing behaviour has
     * no canonical wording, so the writer restating it produces a diff on every
     * scene it appears in, and each one costs a repair round the writer cannot
     * usefully spend: it has no way to know which phrasing canon prefers.
     *
     * So a prose-shaped value degrades to a warning and is handed to the verifier,
     * which can read both and say whether the *meaning* moved. Atomic values keep
     * their teeth. The boundary is deliberately crude — four words — because the
     * cost of being wrong is asymmetric: too strict spends a repair round on a
     * synonym, too loose lets one factual change through to a layer that is still
     * looking at it.
     */
    const proseShaped =
      existing.value.trim().split(/\s+/).length >= 4 ||
      claim.value.trim().split(/\s+/).length >= 4;

    findings.push(
      makeFinding({
        subtype: subtypeForAttribute(claim.attribute),
        validator: "continuity",
        severity: proseShaped ? "warning" : "error",
        reasoning: proseShaped
          ? `${claim.entity}'s ${claim.attribute} reads "${existing.value}" in canon and ` +
            `"${claim.value}" here. Both are phrases rather than atomic values, so this may ` +
            `be the same fact reworded rather than a change — read them and say which. If ` +
            `the meaning is the same, nothing needs repairing and the wording in canon stands`
          : `${claim.entity}'s ${claim.attribute} was established as "${existing.value}" and this scene asserts "${claim.value}" without declaring the change deliberate`,
        evidence: { quote: claim.quote, source: delta.sceneId },
        contradicts: asEvidence(existing),
        // Deliberately "unresolved": the machine knows the two disagree, it
        // does not know which is right. Guessing "the draft is wrong" is what
        // made v2 delete good prose to protect a stale fact.
        editLocus: {
          kind: "unresolved",
          question: `is "${claim.value}" a mistake, or a deliberate change that should supersede ${existing.id}?`,
        },
      }),
    );
  }

  for (const entity of delta.presentEntities) {
    if (knownEntities.has(entity)) continue;
    findings.push(
      makeFinding({
        subtype: "nomenclature_confusions",
        validator: "reference",
        severity: "fatal",
        reasoning: `the scene lists "${entity}" as present, but no such entity exists in the index`,
        evidence: { quote: entity, source: delta.sceneId },
        contradicts: { quote: "not present in index/story/bible", source: "index/story/bible" },
        editLocus: {
          kind: "unresolved",
          question: `should "${entity}" be created, or is it a misspelling?`,
        },
      }),
    );
  }

  // The narrative person, against the one constraint that was decided before any
  // prose existed. Last because it reads the draft rather than the delta, and
  // because a scene with a dangling entity reference has a worse problem.
  if (input.prose && input.voice) {
    const drifts = findPersonDrift(input.prose, input.voice);
    for (const drift of drifts.slice(0, MAX_PERSON_DRIFT_FINDINGS)) {
      findings.push(
        makeFinding({
          subtype: "perspective_confusions",
          validator: "voice",
          severity: "error",
          reasoning:
            `${drift.why}. The narration this book was planned in is ` +
            `"${input.voice.person}", decided before the first scene and not a ` +
            `per-scene choice` +
            (drifts.length > MAX_PERSON_DRIFT_FINDINGS
              ? `. ${drifts.length} sentences in this scene do it, so treat it as the ` +
                `scene's register rather than as this one line`
              : ""),
          evidence: { quote: drift.quote, source: delta.sceneId },
          contradicts: {
            quote: `Narration: ${input.voice.person}, ${input.voice.tense} tense.`,
            source: paths.voice(),
          },
          editLocus: { kind: "draft", quote: drift.quote },
        }),
      );
    }
  }

  // The spelling convention, against what the committed scenes established. Same
  // argument as the person above and the same cap: a scene that uses four
  // wrong-system spellings is one habit, not four defects.
  if (input.prose && input.convention) {
    // The script first, because a scene in the wrong language makes every
    // spelling finding beneath it meaningless — and because it is one decision,
    // reported once, where the spellings are a habit reported twice.
    const scriptDrift = findScriptDrift(input.prose, input.convention);
    if (scriptDrift) {
      findings.push(
        makeFinding({
          subtype: "style_shifts",
          validator: "voice",
          severity: "error",
          mechanical: true,
          reasoning: scriptDrift.why,
          evidence: { quote: scriptDrift.quote, source: delta.sceneId },
          contradicts: {
            quote: renderConvention(input.convention),
            source: paths.voice(),
          },
          editLocus: { kind: "draft", quote: scriptDrift.quote },
        }),
      );
    }
    const drifts = findOrthographyDrift(input.prose, input.convention);
    for (const drift of drifts.slice(0, MAX_PERSON_DRIFT_FINDINGS)) {
      findings.push(
        makeFinding({
          subtype: "style_shifts",
          validator: "voice",
          severity: "error",
          // `style_shifts` is a `stylistic` subtype, which the taxonomy holds
          // non-blocking because a stylistic *judgement* is too soft to refuse
          // prose over. A spelling pair is a comparison, so it may block; see the
          // field's own note. Without this the construction throws, and the throw
          // lands after `verify()` has moved the scene to VALIDATING — which is
          // how two of the first five runs on 0.9.10 lost three quarters of their
          // scenes to a state the state machine could not leave.
          mechanical: true,
          reasoning:
            `${drift.why}` +
            (drifts.length > MAX_PERSON_DRIFT_FINDINGS
              ? `. ${drifts.length} words in this scene are in the other system, so fix the ` +
                `habit rather than this one word`
              : ""),
          evidence: { quote: drift.quote, source: delta.sceneId },
          contradicts: {
            quote: renderConvention(input.convention),
            source: paths.voice(),
          },
          editLocus: { kind: "draft", quote: drift.quote },
        }),
      );
    }
  }

  return {
    findings,
    coverage: {
      claims: delta.claims.length,
      claimsCheckedAgainstCanon: checked,
      canonFactsInScope: canon.length,
      presentEntities: delta.presentEntities.length,
      volatileChanges: volatile,
      // Note the absence of a cap. Coverage is reported, never truncated.
    },
  };
}

/**
 * Attributes that name what an entity *did* rather than what is *true of* it.
 *
 * Canon holds standing properties, and the contradiction check works by asking
 * whether a later scene gives the same property a different value. An event
 * recorded as a property breaks that: in `runs/v2-generous` the writer filed
 * `char-mira.action = "asked Elin to show her the ledger"` in one scene and
 * `"climbed the lighthouse stairs"` in the next, and the checker correctly
 * reported that a property had silently changed. Both statements were true and
 * neither contradicted the other; the scene was rejected anyway.
 *
 * Rejecting the shape at the tool boundary costs the writer one turn. Letting
 * it through costs a scene, and does so in a way that reads like a real
 * continuity failure — the most expensive kind of false positive we can emit.
 */
const EVENT_SHAPED = /^(last_|current_|recent_)?(action|activity|event|deed|movement|behaviour|behavior|does|did|doing|says|said|goes|went)s?$/;

export function isEventShapedAttribute(attribute: string): boolean {
  return EVENT_SHAPED.test(attribute.trim().toLowerCase().replace(/[\s-]+/g, "_"));
}

/**
 * Attributes whose whole purpose is to change as the story runs.
 *
 * The distinction this list draws is between a property an entity *has* and a
 * property that records *where the story has got to*. A character's eye colour
 * changing needs a reason; a character's location changing is a character walking.
 * Only the first kind can be contradicted by a later value.
 *
 * Knowledge is on the list and it is the entry most worth justifying, because it
 * looks like the one thing a continuity checker exists to catch. It is the
 * opposite: a character learning something is the mechanism of nearly every plot,
 * so `knows_about_the_ledger: false → true` is the story working. The real defect
 * — a character *acting* on something they were never told — is not visible as a
 * value change at all; it is visible only in the prose, which is why
 * `knowledge_contradictions` is the verifier's job and why the dossier hands it
 * each character's beliefs. The reverse direction, a character forgetting, is a
 * genuine `memory_contradictions`, and it is also not detectable here: canon holds
 * the current value, and nothing distinguishes "forgot" from "the writer recorded
 * the earlier state again" without reading the scene.
 *
 * Kept as a list of stems rather than a general rule because the failure mode of
 * getting it wrong is asymmetric. Too narrow costs a false positive, which spends a
 * repair round; too broad costs a missed contradiction, which is one error in a
 * book. The stems here are the ones the writer's own instructions recommend.
 */
const VOLATILE = [
  "location",
  "position",
  "place",
  "whereabouts",
  "present",
  "holds",
  "holding",
  "carries",
  "carrying",
  "possesses",
  "possessed_by",
  "wearing",
  "mood",
  "emotional_state",
  "state",
  "status",
  "condition",
  "injury",
  "injured",
  "health",
  "alive",
  "knows",
  "knows_about",
  "knowledge",
  "aware",
  "aware_of",
  "believes",
  "suspects",
  "trusts",
  "goal",
  "intent",
  "plan",
] as const;

export function isVolatileAttribute(attribute: string): boolean {
  const a = attribute.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return VOLATILE.some((stem) => a === stem || a.startsWith(`${stem}_`) || a.endsWith(`_${stem}`));
}

/**
 * Map a contradicted attribute onto ConStory's subtype, so our findings and our
 * score share a vocabulary. Unmapped attributes fall back to the factual bucket
 * rather than inventing a subtype the scorer does not know.
 */
function subtypeForAttribute(attribute: string): string {
  const a = attribute.toLowerCase();
  if (/(hair|eye|scar|height|build|clothing|appearance)/.test(a)) {
    return "appearance_mismatches";
  }
  if (/(name|alias|title|spelling)/.test(a)) return "nomenclature_confusions";
  if (/(age|count|number|distance|price|quantity|year)/.test(a)) {
    return "quantitative_mismatches";
  }
  if (/(location|position|place|region|city)/.test(a)) {
    return "geographical_contradictions";
  }
  if (/(knows|knowledge|aware|informed)/.test(a)) return "knowledge_contradictions";
  if (/(remember|memory|recall)/.test(a)) return "memory_contradictions";
  if (/(rule|law|magic|physics|technology)/.test(a)) return "core_rules_violations";
  return "quantitative_mismatches";
}
