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

import { type CraftCheck, MAX_BLOCKING_CRAFT, craftCheck } from "./craft.ts";
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

/**
 * Which of the two things we are scored on this finding belongs to.
 *
 * Kept on the finding rather than inferred from the subtype because the two are
 * counted differently and must never be pooled. `consistency` findings are
 * ConStory subtypes and feed EID, the metric of record for Table 1's second
 * column; a craft finding counted among them would inflate an error density with
 * something that is not an error in that taxonomy. Everything that aggregates
 * findings has to filter on this field.
 */
export type FindingAxis = "consistency" | "craft";

export interface Finding {
  /**
   * Stable across rounds: same defect in the same place yields the same id, so
   * a finding that survives a repair round is detectable and the loop can stop
   * instead of spinning.
   */
  readonly id: string;
  readonly subtype: string;
  readonly axis: FindingAxis;
  readonly category: ErrorCategory | "craft";
  readonly tier: EvidenceTier | "craft";
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
  /**
   * The canonical facts the writer needs in order to carry out the repair.
   *
   * The writer has no shell, no index and no `read_index` — that exception is
   * deliberate (measured: it issued four shell commands in a whole run and asked
   * the builder nothing), and it means the verifier is the *only* participant that
   * can put a fact in front of it. Until now the only channel was
   * `contradicts.quote`, which carries the one passage being contradicted and
   * nothing else, so a finding like "Kerr cannot know this yet" arrived without the
   * one thing needed to fix it: what Kerr does know as of this scene, and where
   * that is recorded.
   *
   * Quoted with its source, so the writer can put the corrected fact on the page
   * without inventing it — the failure mode the whole index exists to prevent.
   */
  readonly canonContext?: string;
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
  readonly canonContext?: string;
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
  /**
   * A pair whose other side is an absence is not a pair.
   *
   * Measured: a verifier raised eleven findings on one run of `lbw081` in the shape
   * "`objects/obj-note.yaml` has no `first_seen` entry" and "the relation query
   * returns nothing for these two", labelled as contradiction pairs with the empty
   * result standing in for the contradicting passage. Every one of them described a
   * scene establishing a fact for the first time, which is what a scene is for. The
   * run scored *worse* than one with five real findings, because the writer cannot
   * tell a spurious finding from a real one — it has no index access — so it spent
   * its repair rounds writing provenance into prose that was fine.
   *
   * The prompt says this too. The check is here because a prompt is advice and this
   * is the one shape that cannot be a contradiction: if the other side is empty,
   * nothing is being contradicted.
   */
  if (spec.tier === "explicit-pair" && !input.contradicts!.quote.trim()) {
    throw new FindingError(
      `${input.subtype}: contradicts.quote is empty. An absence is not the other half of ` +
        `a contradiction — a missing key, an empty file or a query that returned nothing ` +
        `describes a fact this scene is establishing for the first time, which is what a ` +
        `scene is for. Quote the passage that actually says something different, or report ` +
        `nothing.`,
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
    axis: "consistency",
    category: spec.category,
    tier: spec.tier,
    validator: input.validator,
    severity: input.severity,
    reasoning: input.reasoning.trim(),
    evidence: input.evidence,
    ...(input.contradicts ? { contradicts: input.contradicts } : {}),
    ...(input.suggestion?.trim() ? { suggestion: input.suggestion.trim() } : {}),
    ...(input.canonContext?.trim() ? { canonContext: input.canonContext.trim() } : {}),
    editLocus: input.editLocus,
  };
}

/**
 * Build a craft finding, refusing the shapes that make one unfalsifiable.
 *
 * The refusals are the whole reason this is a separate constructor rather than a
 * flag on the one above. A consistency finding is disciplined by its taxonomy: the
 * subtype fixes what evidence is required and whether it may block. Craft has no
 * such external discipline — a model asked to judge prose can always produce a
 * sentence of disapproval — so the discipline has to be here:
 *
 *  - **`error` only for a check that may block.** The list is short and every
 *    member of it is objective enough to be argued about with quotes.
 *  - **A blocking craft finding must carry its evidence in the shape the check
 *    demands.** `pair` means two verbatim quotes; `state-pair` means the scene's
 *    opening state and closing state, or the question the premise poses and where
 *    the draft answers it. Both are things a reader could check. "The prose is
 *    flat" is not, which is exactly why `flat_diction` cannot block.
 *  - **A suggestion is mandatory.** A craft warning with no instruction is a
 *    complaint, and the writer's only options against one are to ignore it or to
 *    damage the scene guessing at what was meant. The second is what cost this
 *    project 8.4 points once already.
 */
export function makeCraftFinding(input: {
  readonly checkId: string;
  readonly severity: Severity;
  readonly reasoning: string;
  readonly evidence: Evidence;
  /** The passage repeated or contradicted; required for `pair` checks. */
  readonly contradicts?: Evidence;
  /** For `state-pair` checks: "open: … / close: …" or "question: … / answer: …". */
  readonly statePair?: { readonly before: string; readonly after: string };
  readonly suggestion: string;
  readonly canonContext?: string;
}): Finding {
  const check: CraftCheck = craftCheck(input.checkId);

  if (!input.evidence.quote.trim()) {
    throw new FindingError(`${check.id}: evidence.quote must be a verbatim passage, not empty`);
  }
  if (!input.reasoning.trim()) {
    throw new FindingError(`${check.id}: reasoning must say why this is a defect`);
  }
  if (!input.suggestion.trim()) {
    throw new FindingError(
      `${check.id}: suggestion is required. The writer cannot look anything up, so a craft ` +
        `finding without an instruction is a complaint it can only respond to by guessing — ` +
        `and a guessed craft repair damages prose that was working.`,
    );
  }
  if (input.severity !== "warning" && !check.canBlock) {
    throw new FindingError(
      `${check.id} may only be a warning. It is a judgement about quality that a reader ` +
        `could reasonably disagree with, so it reaches the writer without costing a repair ` +
        `round. The checks that may block are the ones whose evidence is checkable.`,
    );
  }
  if (input.severity !== "warning" && check.evidence === "pair" && !input.contradicts?.quote.trim()) {
    throw new FindingError(
      `${check.id} blocks only with both sides quoted: this draft's passage and the earlier ` +
        `passage it repeats or contradicts. Without the second quote the writer cannot tell ` +
        `what to cut, and neither can a reader auditing this run.`,
    );
  }
  if (
    input.severity !== "warning" &&
    check.evidence === "state-pair" &&
    !(input.statePair?.before.trim() && input.statePair?.after.trim())
  ) {
    throw new FindingError(
      `${check.id} blocks only with a named state pair — what is true when the scene opens ` +
        `and what is true when it closes (or, for an ending, the question the premise poses ` +
        `and where the draft answers it). If you cannot name both, you have an impression ` +
        `rather than a finding: report it as a warning.`,
    );
  }

  const statePair = input.statePair
    ? `open/question: ${input.statePair.before.trim()} → close/answer: ${input.statePair.after.trim()}`
    : "";

  return {
    // The state pair participates in identity so a rewrite that genuinely moves
    // the scene produces a different finding, and one that does not produces the
    // same id — which is what the livelock detector reads.
    id: findingId(check.id, input.evidence, input.contradicts ?? (statePair ? { quote: statePair, source: "state" } : undefined)),
    subtype: check.id,
    axis: "craft",
    category: "craft",
    tier: "craft",
    validator: "craft",
    severity: input.severity,
    reasoning: [input.reasoning.trim(), statePair].filter(Boolean).join("\n  "),
    evidence: input.evidence,
    ...(input.contradicts ? { contradicts: input.contradicts } : {}),
    suggestion: input.suggestion.trim(),
    ...(input.canonContext?.trim() ? { canonContext: input.canonContext.trim() } : {}),
    editLocus: { kind: "draft", quote: input.evidence.quote },
  };
}

/**
 * Demote craft blockers beyond the cap to warnings, worst-first by report order.
 *
 * Applied where the findings leave the verifier rather than where they are built,
 * because the cap is a property of a round: any one craft finding may legitimately
 * block, and it is the third one in the same round that is the problem. A round
 * spent on the third-most-important craft defect is a round not spent on a
 * contradiction, and contradictions are counted against us by name.
 *
 * Demoted rather than dropped. The observation was still made, the writer still
 * sees it, and the summary can still count how often the cap bound — which is the
 * only way to find out whether the cap is set anywhere near right.
 */
export function capCraftBlockers(findings: readonly Finding[]): {
  readonly findings: readonly Finding[];
  readonly demoted: number;
} {
  let allowed = MAX_BLOCKING_CRAFT;
  let demoted = 0;
  const out = findings.map((f) => {
    if (f.axis !== "craft" || f.severity === "warning") return f;
    if (allowed > 0) {
      allowed -= 1;
      return f;
    }
    demoted += 1;
    return { ...f, severity: "warning" as Severity };
  });
  return { findings: out, demoted };
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
 * The same *class* of defect surviving a round, even though the quote moved.
 *
 * `unchangedAcrossRound` compares finding ids, and an id is the subtype plus the
 * quoted spans. That catches a writer who changed nothing and misses the failure
 * that actually happens: the writer rewrites the passage, the defect stays, and
 * the verifier quotes the new wording — so the id changes and a livelock looks
 * like progress.
 *
 * Measured on the one scene this system has dropped. `lbw081` s-001 produced
 * five blocking findings over three rounds, every one of them
 * `causal_logic_violations` about the same door and the same key, with five
 * different ids because the prose moved each time. The verifier could see it and
 * said so in round two — *"the writer failed to address the previous finding's
 * instruction"* — while the code saw three unrelated defects and kept paying.
 *
 * This matters more now than it did then. Raising the endgame repair allowance to
 * five rounds multiplies the cost of an undetected livelock by two and a half, so
 * the wider ceiling is only affordable alongside a detector that can see this.
 */
export function recurringSubtypes(
  before: readonly Finding[],
  after: readonly Finding[],
): readonly string[] {
  const previous = new Set(blocking(before).map((f) => f.subtype));
  return [...new Set(blocking(after).map((f) => f.subtype))].filter((s) => previous.has(s));
}

/**
 * Whether the last round bought anything.
 *
 * Recurrence alone is not enough to stop: a writer that takes three blocking
 * findings down to one is converging, and the surviving one may well be the next
 * round's fix. What says the loop is stuck is recurrence *without* the count
 * falling — the same class of problem, no fewer of them, after a rewrite.
 */
export function stalled(
  before: readonly Finding[],
  after: readonly Finding[],
): { readonly stalled: boolean; readonly subtypes: readonly string[] } {
  const subtypes = recurringSubtypes(before, after);
  const wasBlocking = blocking(before).length;
  const isBlocking = blocking(after).length;
  return {
    stalled: subtypes.length > 0 && wasBlocking > 0 && isBlocking >= wasBlocking,
    subtypes,
  };
}

/**
 * The repair brief the writer actually receives.
 *
 * Ordered by severity then category so the writer fixes hard contradictions
 * before stylistic notes, and every item states both sides and the locus. A
 * finding whose locus is canon is deliberately included and marked: the writer
 * must know not to bend the prose around a fact that is itself being corrected.
 */
export function renderRepairBrief(
  findings: readonly Finding[],
  options: {
    /**
     * Defect classes the previous round also raised.
     *
     * Said out loud because the writer has no way to know it: each repair round
     * arrives as a fresh brief, so a writer on its third attempt at one problem
     * cannot tell that from a first attempt at a third problem, and it responds
     * by producing another variation on the fix that already failed.
     */
    readonly recurring?: readonly string[];
  } = {},
): string {
  if (findings.length === 0) return "No findings.";
  const rank: Record<Severity, number> = { fatal: 0, error: 1, warning: 2 };
  // Consistency before craft at equal severity. Both are worth fixing, and only
  // one of them is counted by name in a metric of record — so if the writer runs
  // out of attention partway down the list, the cheaper thing to lose is the craft
  // note.
  const axisRank = (f: Finding) => (f.axis === "craft" ? 1 : 0);
  const ordered = [...findings].sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      axisRank(a) - axisRank(b) ||
      a.category.localeCompare(b.category),
  );

  const lines: string[] = [];
  if (options.recurring && options.recurring.length > 0) {
    lines.push(
      `The previous round raised ${options.recurring.join(", ")} as well, and your rewrite did ` +
        `not clear it. Do not produce another variation of the same fix — that is the failure ` +
        `mode, and it has cost this system a whole scene before.`,
      `If making this consistent requires a fact nobody has established — how a mechanism ` +
        `works, what was really agreed, which of two accounts is true — then it is not a ` +
        `prose defect and you cannot fix it by rewriting. Say so plainly in your reply and ` +
        `state what needs deciding. That is a useful answer; a third guess is not.`,
      "",
    );
  }
  for (const f of ordered) {
    lines.push(
      `[${f.severity}] ${f.subtype}  (${f.id}, ${f.axis}, found by ${f.validator})`,
    );
    lines.push(`  why: ${f.reasoning}`);
    lines.push(`  in your draft: "${f.evidence.quote}"  <${locate(f.evidence)}>`);
    if (f.contradicts) {
      lines.push(
        `  ${f.axis === "craft" ? "already delivered here" : "contradicts"}: ` +
          `"${f.contradicts.quote}"  <${locate(f.contradicts)}>`,
      );
    }
    if (f.suggestion) lines.push(`  do this: ${f.suggestion}`);
    // The one channel through which a fact can reach the writer at all. Placed
    // after the instruction because it is what makes the instruction performable:
    // "say what Kerr actually knows" is only actionable next to what he knows.
    if (f.canonContext) {
      lines.push(`  what the index says (you cannot look this up yourself):`);
      for (const line of f.canonContext.split("\n")) lines.push(`    ${line}`);
    }
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
