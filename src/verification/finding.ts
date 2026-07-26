/**
 * What the verifier hands back, and why it has this shape.
 *
 * v2's finding was a severity plus a sentence of prose. A writer given that can
 * only rewrite the whole scene, which is how nine consecutive drafts of one
 * scene ended up with identical prose digests
 * (`docs/06-v2-repair-loop-failure-taxonomy.md`). A repair loop whose feedback
 * does not localise the defect is a lottery, and bounding the number of rounds
 * only bounds how long the lottery runs.
 *
 * So a finding carries what ConStory's own judge emits — `exact_quote`,
 * `location`, `contradiction_pair`, `contradiction_location`, `error_element`,
 * `error_category`, `context` — plus one field their format has no reason to
 * carry and we cannot work without: **where the fix belongs**. Their checker
 * reads a finished story and only reports; ours must tell a writer whether to
 * change this scene or whether the canon is what is wrong.
 */

import {
  type ErrorCategory,
  type EvidenceTier,
  isBlockingSubtype,
  subtypeSpec,
} from "./taxonomy.ts";

/**
 * A span of text, quoted verbatim so the writer can find it and so a human
 * auditing the run can check the verifier was not hallucinating.
 */
export interface Evidence {
  /** Verbatim. Never a paraphrase — a paraphrase cannot be located or audited. */
  readonly quote: string;
  /** Where it lives: a scene id, or a canonical index path. */
  readonly source: string;
  /** Line span within that source, e.g. "L44-L60". */
  readonly span?: string;
}

/**
 * Where the repair belongs. The distinction is load-bearing: if the draft is
 * right and a canon fact is stale, rewriting the draft destroys good prose and
 * leaves the real defect in place. v2 had no way to express this, so every
 * finding pushed the writer.
 */
export type EditLocus =
  /** The new prose is wrong; the writer fixes this scene. */
  | { readonly kind: "draft"; readonly quote: string }
  /** The prose is right and canonical state is stale; index-manager's problem. */
  | { readonly kind: "canon"; readonly path: string; readonly reason: string }
  /** Neither is wrong on its own; a human or the orchestrator must choose. */
  | { readonly kind: "unresolved"; readonly question: string };

export type Severity = "warning" | "error" | "fatal";

export interface Finding {
  /**
   * Stable across rounds: same defect in the same place yields the same id, so
   * a finding that survives a repair round is detectable and the loop can stop
   * instead of spinning.
   */
  readonly id: string;
  readonly subtype: string;
  readonly category: ErrorCategory;
  readonly tier: EvidenceTier;
  /** Which layer found it: "schema", "reference", "continuity", "llm", "global". */
  readonly validator: string;
  readonly severity: Severity;
  /** Why this is a defect, in one or two sentences. */
  readonly reasoning: string;
  /** The offending passage. */
  readonly evidence: Evidence;
  /** The other half of a contradiction pair, when the subtype has one. */
  readonly contradicts?: Evidence;
  /**
   * What to actually change, in the writer's terms.
   *
   * Diagnosis is not instruction, and the writer cannot go and look. It has no
   * shell, no index access and no memory of the scene beyond its own draft — so
   * a finding that only says *what is wrong* leaves it guessing at *what would
   * be right*, and guessing is how three repair rounds produce three drafts with
   * the same defect in different words. That is exactly what happened to the one
   * scene this system has dropped.
   */
  readonly suggestion?: string;
  readonly editLocus: EditLocus;
}

export class FindingError extends Error {}

/**
 * Build a finding, refusing the shapes that make a finding unactionable.
 *
 * Three refusals, each one a v2 failure mode:
 *  - an explicit-pair subtype without both sides: the writer cannot see what it
 *    contradicts, so it can only guess;
 *  - a blocking severity on a subtype that cannot legitimately block;
 *  - empty evidence, which is a sentence of prose wearing a schema.
 */
export function makeFinding(input: {
  readonly subtype: string;
  readonly validator: string;
  readonly severity: Severity;
  readonly reasoning: string;
  readonly evidence: Evidence;
  readonly contradicts?: Evidence;
  readonly suggestion?: string;
  readonly editLocus: EditLocus;
}): Finding {
  const spec = subtypeSpec(input.subtype);

  if (!input.evidence.quote.trim()) {
    throw new FindingError(
      `${input.subtype}: evidence.quote must be verbatim text, not empty`,
    );
  }
  if (!input.reasoning.trim()) {
    throw new FindingError(`${input.subtype}: reasoning must say why this is a defect`);
  }
  if (spec.tier === "explicit-pair" && !input.contradicts) {
    throw new FindingError(
      `${input.subtype} is a contradiction pair; report the passage it contradicts or do not report it`,
    );
  }
  if (input.severity !== "warning" && !isBlockingSubtype(input.subtype)) {
    throw new FindingError(
      `${input.subtype} is ${spec.tier}; it may only be a warning, because at scene time it is not yet an error`,
    );
  }

  return {
    id: findingId(input.subtype, input.evidence, input.contradicts),
    subtype: input.subtype,
    category: spec.category,
    tier: spec.tier,
    validator: input.validator,
    severity: input.severity,
    reasoning: input.reasoning.trim(),
    evidence: input.evidence,
    ...(input.contradicts ? { contradicts: input.contradicts } : {}),
    ...(input.suggestion?.trim() ? { suggestion: input.suggestion.trim() } : {}),
    editLocus: input.editLocus,
  };
}

/**
 * Identity is subtype plus the quoted spans, normalised for whitespace. Not the
 * reasoning: an LLM rephrases its explanation between rounds while pointing at
 * the same defect, and treating that as a new finding is what hides a livelock.
 */
function findingId(
  subtype: string,
  evidence: Evidence,
  contradicts: Evidence | undefined,
): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const parts = [subtype, norm(evidence.quote), contradicts ? norm(contradicts.quote) : ""];
  let hash = 0x811c9dc5;
  for (const ch of parts.join("\u0000")) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `f-${hash.toString(16).padStart(8, "0")}`;
}

/** Findings that must be repaired before the scene may be committed. */
export function blocking(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter((f) => f.severity !== "warning");
}

/**
 * Findings that survived a repair round unchanged.
 *
 * The signal a bounded loop needs: if the writer produced a new draft and the
 * same finding is still there, another round is unlikely to help and the
 * orchestrator should escalate rather than spend the remaining budget.
 */
export function unchangedAcrossRound(
  before: readonly Finding[],
  after: readonly Finding[],
): readonly Finding[] {
  const seen = new Set(before.map((f) => f.id));
  return after.filter((f) => seen.has(f.id));
}

/**
 * The repair brief the writer actually receives.
 *
 * Ordered by severity then category so the writer fixes hard contradictions
 * before stylistic notes, and every item states both sides and the locus. A
 * finding whose locus is canon is deliberately included and marked: the writer
 * must know not to bend the prose around a fact that is itself being corrected.
 */
export function renderRepairBrief(findings: readonly Finding[]): string {
  if (findings.length === 0) return "No findings.";
  const rank: Record<Severity, number> = { fatal: 0, error: 1, warning: 2 };
  const ordered = [...findings].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.category.localeCompare(b.category),
  );

  const lines: string[] = [];
  for (const f of ordered) {
    lines.push(`[${f.severity}] ${f.subtype}  (${f.id}, found by ${f.validator})`);
    lines.push(`  why: ${f.reasoning}`);
    lines.push(`  in your draft: "${f.evidence.quote}"  <${locate(f.evidence)}>`);
    if (f.contradicts) {
      lines.push(
        `  contradicts: "${f.contradicts.quote}"  <${locate(f.contradicts)}>`,
      );
    }
    if (f.suggestion) lines.push(`  do this: ${f.suggestion}`);
    switch (f.editLocus.kind) {
      case "draft":
        lines.push(`  fix here: "${f.editLocus.quote}"`);
        break;
      case "canon":
        lines.push(
          `  do NOT change the prose: ${f.editLocus.path} is stale (${f.editLocus.reason}). index-manager will correct it.`,
        );
        break;
      case "unresolved":
        lines.push(`  needs a decision: ${f.editLocus.question}`);
        break;
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function locate(e: Evidence): string {
  return e.span ? `${e.source} ${e.span}` : e.source;
}
