/**
 * The evidence the verifier checks against, assembled instead of remembered.
 *
 * ## The defect this fixes
 *
 * The verifier's brief has told it to read the index since the first version. Over
 * a nineteen-scene run it issued **three** shell reads, against the
 * context-builder's forty-eight. An instruction to be thorough is not a procedure,
 * and the consequence was not merely thin checking — it was checking *from memory*,
 * which produced the most expensive class of false positive this project has
 * measured: eleven findings in the shape "`objects/obj-note.yaml` has no
 * `first_seen` entry", each labelled a contradiction pair with an *absence*
 * standing in for the other side. Every one described a scene establishing a fact
 * for the first time. That run scored 8.4 points below one with five real findings,
 * because the writer has no index access and cannot tell the two apart.
 *
 * The constructor now refuses an empty other side, and the brief says so at length.
 * Both are downstream of the real problem: the verifier was being asked what canon
 * says without being told, and a model asked to recall a file it has not read will
 * produce a plausible answer rather than an absence.
 *
 * So the other side of every pair it might raise is put in front of it, computed
 * from the same `CanonFact[]` the deterministic layer used. Three properties make
 * this worth its tokens:
 *
 *  - It is **deterministic**. No model produces it, so it cannot hallucinate.
 *  - It is **small**: one line per claim the draft actually makes, not the index.
 *  - It states the *verdict* per claim — established, unchanged, changed, or new —
 *    so "new" is labelled as normal rather than left as an absence to be
 *    misread. This is the same fact the eleven-finding run got backwards, said
 *    positively.
 *
 * ## What is deliberately not here
 *
 * The prose of earlier scenes, and the promise ledger. Both are already in the
 * packet the verifier receives, and duplicating them would grow every verifier
 * request by the amount that made a resident verifier 81% of a run's cost. The
 * dossier covers what the packet cannot: the *comparison* between what the draft
 * claims and what canon holds, which exists nowhere until it is computed.
 */

import {
  type CanonFact,
  type ProposedClaim,
  type SceneDelta,
  isVolatileAttribute,
} from "./deterministic.ts";
import type { Finding } from "./finding.ts";

const normalise = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

export type ClaimVerdict =
  /** Canon holds the same value. Nothing to check. */
  | "agrees"
  /** Canon holds a different value and the writer declared the change. */
  | "supersedes"
  /** Canon holds a different value and nobody declared anything. A real pair. */
  | "conflicts"
  /**
   * Canon holds a different value on an attribute that is supposed to change.
   *
   * A character walking from a house to the street, or learning something. The
   * deterministic layer used to report these as contradictions at severity `error`
   * — two per scene on `runs-070/lbw070` s-002, which stalled the repair loop and
   * committed a scene carrying two recorded defects that were not defects. It no
   * longer does, so the verifier is told instead: there is a real question here,
   * and it is whether the prose *shows* the change, not whether the value moved.
   */
  | "moved"
  /** Canon holds nothing for this entity and attribute. Normal, not a defect. */
  | "new";

export interface ClaimRow {
  readonly entity: string;
  readonly attribute: string;
  readonly claimed: string;
  readonly canon: string | null;
  readonly canonSource: string | null;
  readonly verdict: ClaimVerdict;
}

export function compareClaims(
  claims: readonly ProposedClaim[],
  canon: readonly CanonFact[],
): readonly ClaimRow[] {
  const byKey = new Map<string, CanonFact>();
  for (const fact of canon) byKey.set(`${fact.entity}\u0000${fact.attribute}`, fact);

  return claims.map((claim) => {
    const existing = byKey.get(`${claim.entity}\u0000${claim.attribute}`);
    const base = {
      entity: claim.entity,
      attribute: claim.attribute,
      claimed: claim.value,
      canon: existing?.value ?? null,
      canonSource: existing?.source ?? null,
    };
    if (!existing) return { ...base, verdict: "new" as ClaimVerdict };
    if (normalise(existing.value) === normalise(claim.value)) {
      return { ...base, verdict: "agrees" as ClaimVerdict };
    }
    if (claim.supersedes?.factId === existing.id) {
      return { ...base, verdict: "supersedes" as ClaimVerdict };
    }
    return {
      ...base,
      verdict: (isVolatileAttribute(claim.attribute) ? "moved" : "conflicts") as ClaimVerdict,
    };
  });
}

/**
 * The dossier, as the verifier reads it.
 *
 * `deterministic` is included because the verifier's own standing instructions
 * say *"Deterministic checks have already run before you are called — read their
 * findings; do not repeat them"* — and they were never passed to it. A prompt that
 * refers to information the agent does not receive does not merely fail to help;
 * it teaches the agent that its instructions describe a world it cannot see. When
 * the deterministic layer raises a blocking finding the model layer is skipped
 * entirely, so what reaches the verifier here is the non-blocking remainder: the
 * fatal reference errors and declared-change mismatches that did *not* stop the
 * scene, which are exactly the ones worth a second opinion.
 */
export function renderDossier(input: {
  readonly delta: SceneDelta;
  readonly canon: readonly CanonFact[];
  readonly knownEntities: ReadonlySet<string>;
  readonly deterministic: readonly Finding[];
  readonly words: { readonly draft: number; readonly sceneTarget: number | null };
}): string {
  const rows = compareClaims(input.delta.claims, input.canon);
  const counts = rows.reduce<Record<ClaimVerdict, number>>(
    (acc, row) => ({ ...acc, [row.verdict]: (acc[row.verdict] ?? 0) + 1 }),
    { agrees: 0, supersedes: 0, conflicts: 0, moved: 0, new: 0 },
  );

  const lines: string[] = [
    "## Evidence, computed for you",
    "",
    "Every claim this draft makes, checked against what canon already holds. This is not a",
    "summary of the index — it is the comparison itself, done deterministically, so you do not",
    "have to recall a file to know what it says.",
    "",
    `${rows.length} claim(s): ${counts.conflicts} conflict, ${counts.supersedes} declared ` +
      `change, ${counts.moved} moved on an attribute that changes, ${counts.agrees} agree with ` +
      `canon, ${counts.new} establish something for the first time.`,
    "",
  ];

  if (rows.length === 0) {
    lines.push(
      "The draft declared no claims at all. That is itself worth a look: a scene that changed",
      "nothing about the world either did not advance the story or failed to record what it did,",
      "and the second is how the next scene comes to contradict this one.",
      "",
    );
  }

  for (const row of rows) {
    switch (row.verdict) {
      case "new":
        lines.push(
          `- \`${row.entity}.${row.attribute}\` = "${row.claimed}" — **NEW**, canon holds ` +
            `nothing for this. This is a scene establishing a fact, which is what a scene is ` +
            `for. It is not a defect and there is no pair to report.`,
        );
        break;
      case "agrees":
        lines.push(
          `- \`${row.entity}.${row.attribute}\` = "${row.claimed}" — agrees with canon ` +
            `(${row.canonSource}). Nothing to check.`,
        );
        break;
      case "supersedes":
        lines.push(
          `- \`${row.entity}.${row.attribute}\`: canon says "${row.canon}" ` +
            `(${row.canonSource}), draft says "${row.claimed}", **declared as a deliberate ` +
            `change**. Your question is whether the prose actually shows the change happening ` +
            `— a declared supersede with nothing on the page is a retcon, not an event.`,
        );
        break;
      case "moved":
        lines.push(
          `- \`${row.entity}.${row.attribute}\`: canon says "${row.canon}" ` +
            `(${row.canonSource}), draft says "${row.claimed}". This attribute is one that ` +
            `changes as the story runs — somebody walked somewhere, learnt something, picked ` +
            `something up — so the change is **not** a contradiction and no declaration is ` +
            `needed. The question worth asking is whether the prose *shows* it happening: a ` +
            `character who is suddenly elsewhere with no journey, or who suddenly knows a ` +
            `thing nobody told them, is a real defect, and it is one only a reading finds.`,
        );
        break;
      case "conflicts":
        lines.push(
          `- \`${row.entity}.${row.attribute}\`: canon says "${row.canon}" ` +
            `(${row.canonSource}), draft says "${row.claimed}", **undeclared**. Both sides ` +
            `are written down, so this is a real contradiction pair — quote canon's side from ` +
            `here.`,
        );
        break;
    }
  }

  lines.push(
    "",
    `Entities the index knows (${input.knownEntities.size}): ` +
      `${[...input.knownEntities].sort().join(", ")}.`,
    "An entity on this list is established and may be referred to freely; the packet only",
    "carries state for the ones present in this scene, so absence from the packet means",
    "nothing.",
    "",
  );

  if (input.words.sceneTarget) {
    lines.push(
      `Length: this draft is ${input.words.draft} words against a scene target of ` +
        `${input.words.sceneTarget}. Report a length problem only when the shortfall shows as ` +
        `content — a beat summarised rather than played — because length itself is scored ` +
        `separately and padding is penalised as hard as brevity.`,
      "",
    );
  }

  lines.push("### What the deterministic layer already found", "");
  if (input.deterministic.length === 0) {
    lines.push(
      "Nothing. The schema, reference integrity and canon-comparison checks all passed, so",
      "everything left is a question about the prose — which is your half of the work, and the",
      "half no comparison can do.",
    );
  } else {
    for (const f of input.deterministic) {
      lines.push(
        `- [${f.severity}] ${f.subtype} (${f.validator}): ${f.reasoning}`,
      );
    }
    lines.push(
      "",
      "Do not re-report these. If you think one of them is wrong, say so and why — that is",
      "useful, and a machine comparison can be right about the values and wrong about which",
      "side should change.",
    );
  }

  return lines.join("\n");
}
