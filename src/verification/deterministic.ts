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
}

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
}

export interface DeterministicResult {
  readonly findings: readonly Finding[];
  readonly coverage: CoverageStats;
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

    findings.push(
      makeFinding({
        subtype: subtypeForAttribute(claim.attribute),
        validator: "continuity",
        severity: "error",
        reasoning: `${claim.entity}'s ${claim.attribute} was established as "${existing.value}" and this scene asserts "${claim.value}" without declaring the change deliberate`,
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

  return {
    findings,
    coverage: {
      claims: delta.claims.length,
      claimsCheckedAgainstCanon: checked,
      canonFactsInScope: canon.length,
      presentEntities: delta.presentEntities.length,
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
