/**
 * The real collaborators: resident agents behind the scene loop's interface.
 *
 * The loop was built against `SceneCollaborators` so its control flow could be
 * tested without the network. This is the other side — the part that turns a
 * context packet into prose and a state delta by actually asking a model.
 *
 * One decision shapes everything here: **the writer's output is collected from
 * typed tool calls, not parsed out of its prose.** Asking a model to emit prose
 * and JSON in one response and then splitting them is how v2 spent retries on
 * malformed envelopes. Native function calling already gives us a validated
 * channel per artefact, so the scene comes back through `write_staged_scene`
 * and the delta through `propose_state_delta`, each schema-checked on arrival.
 */

import { Type } from "typebox";

import type { ContextItem, ContextPacket } from "../context/types.ts";
import type { FileWrite } from "../index/commit.ts";
import type { AgentRole } from "../transaction/types.ts";
import type { Finding } from "../transaction/types.ts";
import {
  type ProposedClaim,
  type SceneDelta,
  isEventShapedAttribute,
} from "../verification/deterministic.ts";
import { CRAFT_CHECKS, blockingCraftIds, renderCraftChecklist } from "../verification/craft.ts";
import { makeCraftFinding, makeFinding } from "../verification/finding.ts";
import { LITERARY_EXEMPTIONS, SUBTYPES, subtypesForTier } from "../verification/taxonomy.ts";
import { type Draft, type SceneCollaborators, VerificationUnavailable } from "./scene-loop.ts";
import { type ResidentAgents, TurnFailed } from "../agents/residents.ts";
import { renderAllocation } from "./allocation.ts";
import { renderGaps } from "./packet-builder.ts";

export class CollaboratorError extends Error {}

/** Tool payloads must be wrapped like this or the model never sees them. */
function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

interface Capture {
  prose: string | undefined;
  delta: SceneDelta | undefined;
  findings: Finding[];
}

/**
 * Writer tools. They validate on arrival and answer with the field that is
 * wrong, so a malformed delta costs one turn rather than a verifier round.
 */
function writerTools(live: () => Capture, sceneId: () => string): unknown[] {
  return [
    {
      label: "Write staged scene",
      name: "write_staged_scene",
      description:
        "Submit the scene's prose. Call this once, with the finished scene, before proposing the state delta.",
      parameters: Type.Object({
        prose: Type.String({ description: "The complete scene, prose only" }),
      }),
      execute: async (_id: string, args: { prose: string }) => {
        if (!args.prose?.trim()) {
          return toolText("rejected: prose is empty. Write the scene, then call this again.");
        }
        live().prose = args.prose;
        return toolText(
          `staged ${args.prose.split(/\s+/).filter(Boolean).length} words. ` +
            `Now call propose_state_delta with everything this scene established.`,
        );
      },
    },
    {
      label: "Propose state delta",
      name: "propose_state_delta",
      description:
        "Declare everything this scene established about the world. One claim per fact, " +
        "each quoting the prose it comes from. Mark a deliberate overwrite with supersedes.",
      parameters: Type.Object({
        claims: Type.Array(
          Type.Object({
            entity: Type.String({ description: "Entity id, e.g. char-mira" }),
            attribute: Type.String({ description: "Which property, e.g. eye_colour" }),
            value: Type.String(),
            quote: Type.String({ description: "Verbatim prose from this scene" }),
            supersedes: Type.Optional(
              Type.Object({ factId: Type.String(), reason: Type.String() }),
            ),
          }),
        ),
        present_entities: Type.Array(Type.String()),
        promises: Type.Optional(
          Type.Array(
            Type.Object({
              id: Type.String({ description: "Stable id, e.g. pc-locked-box" }),
              promise: Type.String({ description: "What the reader is now owed" }),
              quote: Type.String({ description: "Verbatim prose that made the promise" }),
              due_by_scene: Type.Optional(
                Type.String({ description: "Scene id by which it must pay off" }),
              ),
            }),
          ),
        ),
        pays_off: Type.Optional(
          Type.Array(
            Type.Object({
              contract_id: Type.String(),
              quote: Type.String({ description: "Verbatim prose that pays it off" }),
            }),
          ),
        ),
      }),
      execute: async (
        _id: string,
        args: {
          claims: ProposedClaim[];
          present_entities: string[];
          promises?: { id: string; promise: string; quote: string; due_by_scene?: string }[];
          pays_off?: { contract_id: string; quote: string }[];
        },
      ) => {
        const problems: string[] = [];
        (args.claims ?? []).forEach((c, i) => {
          if (!c.quote?.trim()) {
            problems.push(
              `claims[${i}].quote is required: without verbatim prose the claim cannot be ` +
                `audited or located when something needs repairing`,
            );
          }
          if (!c.entity?.trim()) problems.push(`claims[${i}].entity is required`);
          if (c.attribute && isEventShapedAttribute(c.attribute)) {
            problems.push(
              `claims[${i}].attribute "${c.attribute}" names what happened, not a property. ` +
                `Canon holds what is true of an entity between scenes, and the continuity ` +
                `check reads a changed property as a contradiction — so the next scene in ` +
                `which this character does anything else would be rejected. Record what the ` +
                `event left behind instead (knows_about_x, holds_object, location, injury), ` +
                `or leave it out: the prose already says what happened.`,
            );
          }
          if (c.supersedes && !c.supersedes.reason?.trim()) {
            problems.push(
              `claims[${i}].supersedes.reason is required: a later reader cannot tell a ` +
                `deliberate change from a mistake without it`,
            );
          }
        });
        if (problems.length > 0) {
          return toolText(`rejected:\n- ${problems.join("\n- ")}\nFix and call again.`);
        }
        live().delta = {
          sceneId: sceneId(),
          claims: args.claims ?? [],
          presentEntities: args.present_entities ?? [],
          // Recorded when the promise is made, not reconstructed at the end —
          // an abandoned thread is invisible later precisely because nothing
          // refers to it.
          promises: (args.promises ?? []).map((p) => ({
            id: p.id,
            promise: p.promise,
            quote: p.quote,
            dueByScene: p.due_by_scene ?? null,
          })),
          paysOff: (args.pays_off ?? []).map((p) => ({
            contractId: p.contract_id,
            quote: p.quote,
          })),
        };
        return toolText(`accepted ${live().delta!.claims.length} claim(s).`);
      },
    },
  ];
}

/** Verifier tool: findings only, never an edit. */
function verifierTools(live: () => Capture, sceneId: () => string): unknown[] {
  const blockable = SUBTYPES.filter((s) => s.tier === "explicit-pair").map((s) => s.subtype);
  return [
    {
      label: "Write findings",
      name: "write_findings",
      description:
        "Report one defect. Call once per defect; call nothing if the scene looks fine.",
      parameters: Type.Object({
        subtype: Type.String({
          description: `One of: ${SUBTYPES.map((s) => s.subtype).join(", ")}`,
        }),
        severity: Type.String({ description: "warning | error | fatal" }),
        reasoning: Type.String(),
        quote: Type.String({ description: "Verbatim offending passage from the draft" }),
        contradicts_quote: Type.Optional(
          Type.String({ description: "Verbatim passage it contradicts; required for pairs" }),
        ),
        contradicts_source: Type.Optional(Type.String({ description: "Where that came from" })),
        suggestion: Type.String({
          description:
            "What the writer should actually change, concretely. It cannot look anything " +
            "up — no shell, no index — so 'make the timeline consistent' is not actionable " +
            "and 'move the key's discovery to after Hale opens the door, and cut the later " +
            "clause claiming it was already in the lock' is.",
        }),
        canon_context: Type.Optional(
          Type.String({
            description:
              "The facts from the index the writer needs to perform the fix, quoted with " +
              "their source. You are the only participant that can put a fact in front of " +
              "it — it has no shell and no index access — so a finding that says a character " +
              "cannot know something must also say what they do know, and where that is " +
              "recorded. Without it the writer's only options are to ignore you or to invent " +
              "a fact, and an invented fact becomes canon with nothing recording that it was " +
              "invented.",
          }),
        ),
        edit_locus: Type.String({
          description: "draft | canon | unresolved — where the fix belongs",
        }),
        locus_detail: Type.String({
          description: "For canon, the stale path; for unresolved, the question to settle",
        }),
      }),
      execute: async (_id: string, args: Record<string, string>) => {
        try {
          live().findings.push(
            makeFinding({
              subtype: args.subtype!,
              validator: "llm",
              severity: (blockable.includes(args.subtype!)
                ? (args.severity as "warning" | "error" | "fatal")
                : "warning") as "warning" | "error" | "fatal",
              reasoning: args.reasoning ?? "",
              evidence: { quote: args.quote ?? "", source: sceneId() },
              ...(args.suggestion ? { suggestion: args.suggestion } : {}),
              ...(args.canon_context ? { canonContext: args.canon_context } : {}),
              ...(args.contradicts_quote
                ? {
                    contradicts: {
                      quote: args.contradicts_quote,
                      source: args.contradicts_source ?? "canon",
                    },
                  }
                : {}),
              editLocus:
                args.edit_locus === "canon"
                  ? {
                      kind: "canon",
                      path: args.locus_detail ?? "unknown",
                      reason: args.reasoning ?? "",
                    }
                  : args.edit_locus === "unresolved"
                    ? { kind: "unresolved", question: args.locus_detail ?? "which is right?" }
                    : { kind: "draft", quote: args.quote ?? "" },
            }),
          );
          return toolText("recorded.");
        } catch (error) {
          // The constructor's refusals are the useful feedback: a one-sided
          // contradiction pair, a negative inference asked to block, empty
          // evidence. Hand them straight back rather than dropping the finding.
          return toolText(`rejected: ${String(error)}`);
        }
      },
    },
    /**
     * The craft channel, separate from `write_findings` on purpose.
     *
     * One tool with a mode flag would let a craft judgement be filed as a ConStory
     * subtype, and the two are counted into different columns of the results table:
     * consistency findings feed EID, the metric of record, and a craft finding
     * pooled into that number would inflate an error density with something that is
     * not an error in that taxonomy. Two tools make the axis a choice the verifier
     * has to make explicitly, and make it visible in the trace which one it reached
     * for.
     */
    {
      label: "Write craft finding",
      name: "write_craft_finding",
      description:
        "Report a defect in the writing itself — something the graders penalise that is not " +
        "a consistency error. One call per defect.",
      parameters: Type.Object({
        check: Type.String({
          description: `One of: ${CRAFT_CHECKS.map((c) => c.id).join(", ")}`,
        }),
        severity: Type.String({
          description:
            `warning | error. Only these may be error, and only with their evidence: ` +
            `${blockingCraftIds().join(", ")}. Everything else is a warning that reaches the ` +
            `writer without costing it a repair round.`,
        }),
        reasoning: Type.String({ description: "Why this is a defect, in a sentence or two" }),
        quote: Type.String({ description: "Verbatim offending passage from the draft" }),
        contradicts_quote: Type.Optional(
          Type.String({
            description:
              "For restates_prior_scene and internal_incoherence: the verbatim passage that " +
              "already delivered this, or the half of the draft it contradicts. Required to " +
              "block.",
          }),
        ),
        contradicts_source: Type.Optional(
          Type.String({ description: "Which scene or file that came from" }),
        ),
        state_before: Type.Optional(
          Type.String({
            description:
              "For off_brief, nothing_changes and ending_not_delivered: what is true when " +
              "the scene opens — or, for an ending, the question the premise poses. Required " +
              "to block.",
          }),
        ),
        state_after: Type.Optional(
          Type.String({
            description:
              "The matching half: what is true when the scene closes, or where the draft " +
              "answers the question. If you cannot name a difference, that is the finding.",
          }),
        ),
        suggestion: Type.String({
          description:
            "What the writer should actually do, concretely enough to carry out — which " +
            "paragraph to cut, which beat to dramatise instead of summarising, what the last " +
            "line has to establish. Mandatory: a craft note with no instruction is a " +
            "complaint, and a guessed craft repair damages prose that was working.",
        }),
        canon_context: Type.Optional(
          Type.String({
            description:
              "Facts from the index the writer needs to carry out the fix, quoted with their " +
              "source. It cannot look anything up.",
          }),
        ),
      }),
      execute: async (_id: string, args: Record<string, string>) => {
        try {
          live().findings.push(
            makeCraftFinding({
              checkId: args.check!,
              severity: (args.severity === "error" ? "error" : "warning") as
                | "warning"
                | "error",
              reasoning: args.reasoning ?? "",
              evidence: { quote: args.quote ?? "", source: sceneId() },
              ...(args.contradicts_quote
                ? {
                    contradicts: {
                      quote: args.contradicts_quote,
                      source: args.contradicts_source ?? "an earlier scene",
                    },
                  }
                : {}),
              ...(args.state_before && args.state_after
                ? { statePair: { before: args.state_before, after: args.state_after } }
                : {}),
              suggestion: args.suggestion ?? "",
              ...(args.canon_context ? { canonContext: args.canon_context } : {}),
            }),
          );
          return toolText("recorded.");
        } catch (error) {
          return toolText(`rejected: ${String(error)}`);
        }
      },
    },
  ];
}

/**
 * What the verifier is told to do, and how.
 *
 * The instruction to "read the index" was already here and produced three shell
 * reads across a whole nineteen-scene run, against the context-builder's
 * forty-eight. An instruction to be thorough is not a procedure. So the brief
 * now names the five categories, and for each one says *which files answer it* —
 * because a check whose evidence source is unstated is a check performed from
 * memory, and memory is the thing being audited.
 */
const CATEGORY_CHECKLIST = [
  "**Factual detail** — appearance, names, counts, objects. Compare against",
  "  `characters/<id>/profile.yaml` (identity, where a change is a retcon) and the",
  "  earlier scenes under `novel/chapters/`. `grep -rn \"<name>\" novel/chapters/` finds",
  "  every prior mention.",
  "**Timeline and plot logic** — order, duration, simultaneity, cause. Compare against",
  "  `events/timeline.jsonl` and the promise ledger `continuity/plot-contracts.jsonl`.",
  "  This is ConStory's largest category and the easiest to miss by reading only the",
  "  draft.",
  "**Characterization** — motivation, ability, voice, and above all knowledge. Read",
  "  `characters/<id>/beliefs.jsonl`: a character using something they have not learnt",
  "  is the single most common defect in generated fiction, and it is invisible unless",
  "  you check what they knew as of this scene.",
  "**World building and setting** — rules, geography, technology. `world/rules.yaml`",
  "  says what is true; it does not say who knows it. `locations/<id>.yaml` and prior",
  "  scenes say what a place is like.",
  "**Narrative style** — voice, tense, register drift. `novel/style/voice.md` and the",
  "  previous scene are the comparison.",
].join("\n");

/**
 * The craft half of the brief, stating where the checks come from.
 *
 * The provenance is load-bearing rather than decorative. A verifier told to judge
 * quality will report what it dislikes, and taste is unbounded — so the axis is
 * presented as what it is: a finite list derived from the two rubrics this system
 * is actually scored by, with each item naming the dimension that penalises it.
 * That bounds the axis in the only way that survives an eager model, and it tells
 * the verifier why a check exists, which is what decides whether it is applied
 * where it matters or ticked off.
 */
function craftBrief(finalScene: boolean): string {
  return [
    "## Second axis: the writing itself",
    "",
    "The nineteen subtypes above are consistency errors, and they are one of the two numbers",
    "this system is scored on. The other is quality, judged on rubrics that penalise things no",
    "consistency subtype can express — and that is where our deficit actually is: measured on",
    "the same task, our length score was the best in the field and our quality score was 0.5 to",
    "0.8 points below the frontier on a five-point scale, where one point of quality is worth",
    "ten points of the mean.",
    "",
    "Two of the worst defects found by reading our finished manuscripts were invisible to a",
    "consistency gate by construction. The story **had no ending** — the final scene was a",
    'confrontation that named nobody and closed on "Not yet. There is enough for a warrant" —',
    "and an unresolved ending contradicts nothing, so there was no subtype to report it as. And",
    "the scenes **restate each other**: same content, different words, so no textual comparison",
    "sees it, and it is not a contradiction. It is what makes a long story feel padded.",
    "",
    "So report those with `write_craft_finding`. The checks, each naming the scored dimension",
    "that penalises it:",
    "",
    renderCraftChecklist({ finalScene }),
    "",
    "Two rules, both enforced by the tool rather than left to your judgement:",
    "",
    `Only these may be **error** and therefore cost the writer a round: ${blockingCraftIds().join(", ")}.`,
    "Everything else is a warning — it reaches the writer and costs nothing. That asymmetry is",
    "deliberate: a craft judgement a reader could reasonably disagree with must not be able to",
    "hold up a scene.",
    "",
    "And a blocking craft finding needs **checkable evidence**, in the shape the check names.",
    "Either two verbatim quotes (this draft, and the earlier passage it repeats or the half of",
    "itself it contradicts), or a named state pair — what is true when the scene opens and what",
    "is true when it closes. `nothing_changes` is precisely the claim that you cannot name a",
    "difference, so name both halves and let the pair be the evidence. If you cannot produce",
    "the evidence, you have an impression: report it as a warning, which is a perfectly useful",
    "thing to do.",
    "",
    "`suggestion` is mandatory on every craft finding, warnings included. The writer cannot see",
    "the manuscript, the index or the rubric. A craft note without an instruction is a complaint",
    "it can only answer by guessing, and a guessed craft repair damages prose that was working —",
    "which is not hypothetical: a run whose findings the writer could not act on scored 8.4",
    "points below one with fewer, better ones.",
    "",
    "At most two craft findings can block one round, whatever you report. Consistency comes",
    "first when both are present: it is counted by name and craft is not. So if you have three",
    "craft blockers, the third is a warning — pick the two that most damage the scene.",
  ].join("\n");
}

const VERIFIER_BRIEF_HEAD = [
  "Check this scene against the index and the scene card.",
  "",
  "**Start with the computed evidence below.** The claim-by-claim comparison against canon is",
  "assembled for you before you are called, so you do not have to recall what a file says: it",
  "names every claim this draft makes, what canon holds for it, and whether that is a conflict,",
  "a declared change, an agreement, or a first establishment. A finding about any of those",
  "should quote from there. That block exists because the previous version of this brief told",
  "you to read the index and the measured result was three shell reads across a nineteen-scene",
  "run — and eleven findings whose contradicting side was an absence, because a model asked",
  "what a file says without being shown it produces a plausible answer rather than a blank.",
  "",
  "Then read what the comparison cannot settle. You have `bash` and `read` over the whole",
  "project, and a finding that quotes the actual earlier scene is one the writer can act on",
  "rather than argue with. Work through the five categories, using the files named:",
  "",
  CATEGORY_CHECKLIST,
  "",
  "For a pair of characters, `read_relation_history` gives their history as narrative —",
  "what they were to each other at each stage and what changed it. Reading the YAML",
  "gives you the structure instead.",
  "",
  "Report a defect with write_findings, one call per defect. Call nothing if it looks fine —",
  "an empty finding list is a normal result and manufacturing a finding to appear useful",
  "makes the novel worse.",
  "",
  "Every finding needs a `suggestion`: what the writer should actually change. This is not",
  "politeness, it is the difference between a defect that gets fixed and one that does not.",
  "The writer has no shell, no index access and no way to look anything up — your finding is",
  "the whole of what it knows about the problem. `make the timeline consistent` leaves it",
  "guessing; `move the key's discovery to after Hale opens the door, and cut the later clause",
  "claiming it was already in the lock` can be carried out. A scene that cannot be repaired",
  "in the rounds available is committed with your finding attached to it, so a vague",
  "suggestion becomes a permanent defect in the book rather than a lost round.",
  "",
  "And use `canon_context` whenever the fix depends on a fact. You are the only participant",
  "who can put one in front of the writer — it has no shell and no index — so a finding that",
  "says a character cannot know something yet has to also say what they *do* know as of this",
  "scene, quoted, with the file it came from. Without that the writer has two options and both",
  "are bad: ignore you, or invent the fact. An invented fact reaches the page with nothing",
  "anywhere recording that it was invented, which is the failure the whole index exists to",
  "prevent. The same applies to a timeline, a distance, a name, a piece of history: quote it.",
  "",
  "These are not defects:",
  ...LITERARY_EXEMPTIONS.map((e) => `  - ${e}`),
  "When a passage admits both a literary and a defective reading, take the literary one.",
  "",
  "These subtypes can only ever be warnings at scene time, because at this point they are",
  "not yet errors — an unpaid promise is an open loop until the story ends:",
  `  ${subtypesForTier("negative-inference").map((s) => s.subtype).join(", ")}`,
  "",
  "For any contradiction you must quote both sides. If you cannot point at the passage it",
  "contradicts, you have a suspicion, not a finding: report it as a warning or not at all.",
  "",
  "An entity being absent from the packet does not mean it does not exist. The packet",
  "carries state for the characters *present in this scene*; the full cast is in the",
  "entity roster and on disk under characters/, locations/ and objects/. Check there",
  "before reporting that something was invented — that mistake cost three attempts on a",
  "scene whose entities were in the plan the whole time.",
  "",
  "**An absence in the index is not a defect.** This is the direction that is easy to get",
  "backwards, and getting it backwards is expensive. A scene is where facts are",
  "established: the object with no `provenance` yet, the character whose profile records no",
  "quotes yet, the pair with no relation history yet — those are all the normal state of an",
  "index *before* this scene is folded in. index-manager writes them at commit, from this",
  "prose. So `objects/obj-note.yaml has no first_seen entry` and `the relation query returns",
  "nothing for these two` are not findings; they are what a first appearance looks like.",
  "",
  "A finding needs a **conflict with something the index actually records**, and you must be",
  "able to quote both sides. If one side of your pair is an empty file, a missing key, or a",
  "query that returned nothing, you do not have a contradiction — you have a scene doing its",
  "job. Report nothing.",
  "",
  "Nor is an unmet request a *consistency* defect. The orchestrator's brief may ask for things",
  "it invented on the spot; a draft that declines one is not contradicting the world, and no",
  "subtype fits. Do not file that with `write_findings`.",
  "",
  "The scene card is different, and the distinction matters now that there are two channels. A",
  "card is the plan's account of what this scene is for, so a scene that does something else",
  "belongs on the craft axis as `off_brief` — not because an instruction was disobeyed, but",
  "because the task's own requirements are what the Relevance dimension is scored against. A",
  "brief invented mid-run is not; if the two disagree, the card wins.",
  "",
  "Why this is stated so heavily: a run where the verifier raised eleven findings of this",
  "shape scored *worse* than one that raised five real ones. The writer cannot tell a",
  "spurious finding from a real one — it has no shell and no index — so it spends its repair",
  "rounds adding provenance sentences to prose that was fine, and the prose is what is",
  "scored.",
  "",
  "You can read the whole book. `run_command` reaches every committed scene under",
  "novel/chapters/, every character file, the relation records and the promise ledger — so",
  "when a passage looks wrong, check before reporting. The packet is what the writer was",
  "given, not the limit of what you may consult, and a finding that quotes the actual",
  "earlier scene is one the writer can act on rather than argue with.",
].join("\n");

function verifierBrief(finalScene: boolean): string {
  return `${VERIFIER_BRIEF_HEAD}\n\n${craftBrief(finalScene)}`;
}


/**
 * What the checker said about the writer's last scene, on the way into this one.
 *
 * A craft warning does not block, so a scene that commits on its first attempt
 * never opens a repair round and the writer is never shown the note. Measured on
 * `runs-070/lbw081` s-001: three craft warnings went into the audit file and
 * stopped there, and the axis whose whole purpose is the quality score changed
 * nothing about the next scene.
 *
 * Framed as an observation about the writer's habits rather than as a queue of
 * unpaid repairs, because that is what these are — summarising instead of
 * dramatising, or explaining the theme outright, is not a defect in one paragraph
 * that a rewrite would remove. And framed as optional on purpose: a writer told
 * that three things were wrong with its last scene and that it must now avoid all
 * of them writes cautiously, which is its own quality problem.
 */
function renderPriorCraftNotes(
  notes: readonly {
    readonly scene: string;
    readonly check: string;
    readonly why: string;
    readonly suggestion: string;
  }[],
): string {
  if (notes.length === 0) return "";
  return [
    "",
    `## What the checker noticed about ${notes[0]!.scene}`,
    "",
    "These did not block it — the scene is committed and is not being reopened. They are here",
    "because they are about how you write rather than about one paragraph, and this scene is",
    "where you can still act on them.",
    "",
    ...notes.flatMap((n) => [
      `- **${n.check}**: ${n.why}`,
      `    instead: ${n.suggestion}`,
    ]),
    "",
    "Use your judgement. Correcting a habit is worth doing; writing defensively to avoid a",
    "list of criticisms is worse than the habit, and reads like it.",
  ].join("\n");
}

/**
 * A turn in which the model emitted nothing at all.
 *
 * Output tokens rather than text, because a turn whose whole content was tool
 * calls has no text and did plenty. Zero output tokens means the model produced
 * no tokens of any kind.
 */
function silentTurn(turn: {
  readonly text: string;
  readonly ledger: { readonly usage: { readonly output: number }; readonly toolCalls: number };
}): boolean {
  return turn.ledger.usage.output === 0 && turn.ledger.toolCalls === 0 && !turn.text.trim();
}

/**
 * The orchestrator's brief for this step, wrapped so its status is unambiguous.
 *
 * It is an addition to a standing instruction, never a replacement. The parts of
 * a brief that make a step correct — quote the material, refuse to invent, name
 * the file you read it from — are exactly the parts a per-scene note would
 * accidentally override if it arrived as bare text at the end of the prompt.
 */
function orchestratorNote(note: string | undefined): string {
  if (!note?.trim()) return "";
  return [
    "",
    "## What the orchestrator asked for on this scene",
    "",
    note.trim(),
    "",
    "That is in addition to your standing instructions above, not instead of them.",
    // The warning is for a measured failure, not a hypothetical one. On the
    // first orchestrator-driven run its briefs specified whole scenes down to
    // the invented detail — "give the quay a name/id on the folio and a quoted
    // folio line with coordinates" — and the writer, handed a complete
    // specification, asked the builder nothing across four scenes. A fact that
    // arrives in a brief has been through neither the index nor the verifier,
    // so treating one as established is how an invention becomes canon with
    // nothing anywhere recording that it was invented.
    "If it states a story fact that is not in your packet — a name, a measurement, a",
    "quotation, a piece of history — that fact has not been checked against the index by",
    "anyone. Ask about it or establish it yourself in the state delta. Do not write it down",
    "as though it were already true.",
  ].join("\n");
}

/**
 * A tool bus, because residency and per-scene state pull in opposite directions.
 *
 * Agents live for the whole story, so their tools are registered once. But each
 * scene needs its own capture buffer, and a tool closing over scene 1's buffer
 * would still be writing into it at scene 40. The bus is the seam: tools are
 * built once against its getters, and `open` swaps what they point at.
 */
export class SceneToolBus {
  #capture: Capture = { prose: undefined, delta: undefined, findings: [] };
  #sceneId = "s-000";

  /** Begin a scene, returning the buffer the loop reads out of. */
  open(sceneId: string): Capture {
    this.#sceneId = sceneId;
    this.#capture = { prose: undefined, delta: undefined, findings: [] };
    return this.#capture;
  }

  /** Registered once per agent at construction; valid for every later scene. */
  toolsFor(role: AgentRole): unknown[] {
    const live = () => this.#capture;
    const sceneId = () => this.#sceneId;
    if (role === "writer") return writerTools(live, sceneId);
    if (role === "verifier") return verifierTools(live, sceneId);
    return [];
  }
}

/**
 * Wire the resident writer and verifier into the loop for one scene.
 */
export function residentCollaborators(options: {
  readonly residents: ResidentAgents;
  readonly sceneId: string;
  readonly txid: string;
  /** When present, tools are shared across scenes through the bus. */
  readonly bus?: SceneToolBus;
  /**
   * Ask the resident context-builder to enrich the skeleton. Omit to run without
   * a builder, which is the ablation that says what the builder is worth.
   */
  readonly build?: SceneCollaborators["build"];
  /** Ask the resident index-manager to fold the approved scene into the index. */
  readonly backfill?: SceneCollaborators["backfill"];
}): {
  readonly collaborators: SceneCollaborators;
  readonly toolsFor: (role: AgentRole) => unknown[];
} {
  const { residents, sceneId, txid } = options;
  const bus = options.bus ?? new SceneToolBus();
  const capture = bus.open(sceneId);

  return {
    toolsFor: (role) => bus.toolsFor(role),
    collaborators: {
      ...(options.build ? { build: options.build } : {}),
      ...(options.backfill ? { backfill: options.backfill } : {}),
      async draft({
        packet,
        attempt,
        repairBrief,
        packetPath,
        auditPath,
        gaps,
        words,
        allocation,
        priorCraftNotes,
        note,
      }): Promise<Draft> {
        capture.prose = undefined;
        capture.delta = undefined;

        const task =
          attempt === 0
            ? [
                packet.rendered,
                // Before the instruction to write, not after it. An agent given
                // a document and an order to produce follows the order; the
                // gaps have to arrive while there is still a decision to make.
                renderGaps(gaps ?? [], allocation.followUpRounds),
                "",
                // The allowance and the reason for it, before the instruction to
                // write. A tight opening allowance and a wide endgame one are the
                // same policy seen from two ends, and a writer that only sees the
                // number reads the tight one as discouragement — which is how a
                // mechanism designed to make it ask ends up making it ask less.
                renderPriorCraftNotes(priorCraftNotes ?? []),
                renderAllocation(allocation),
                allocation.repairRounds <= 1
                  ? `With one repair round, a defect you leave in this scene will probably ` +
                    `stay in the book: it lands with the finding attached rather than being ` +
                    `rewritten. Get the checkable things right the first time — names, ` +
                    `counts, who knew what — and spend your question if you are unsure of one.`
                  : `You have room to be sent back here, so a scene that reaches further is ` +
                    `worth the risk. What you cannot do is guess at an established fact; a ` +
                    `repair round can fix prose and cannot un-invent canon.`,
                "",
                `Write scene ${sceneId}. Call write_staged_scene with the prose, then ` +
                  `propose_state_delta with everything it established.`,
                // The path as well as the contents. The packet above is what it
                // says now; the file is where a follow-up answer will be
                // appended, and re-reading it is how the writer sees the answer
                // in the material rather than as a loose reply.
                packetPath
                  ? `Your packet is also at ${packetPath}. If you ask a follow-up, the answer ` +
                    `is appended there — read_context re-reads it.`
                  : "",
                words
                  ? `\nLength check: ${words.committed} of ${words.target} words are on the ` +
                    `page across the whole task so far. You cannot see the manuscript, so this ` +
                    `is the only place that number reaches you — if the book is running short ` +
                    `of its target, this scene is where that gets corrected, and a scene that ` +
                    `comes in well under its own target is how a book ends up short.`
                  : "",
                orchestratorNote(note),
              ]
                .filter(Boolean)
                .join("\n")
            : [
                `Your draft of ${sceneId} came back with findings. Repair the specific ` +
                  `defects below — do not rewrite the scene wholesale, and read each ` +
                  `finding's locus before you change anything.`,
                "",
                repairBrief,
                "",
                auditPath ? `The full audit is at ${auditPath}.` : "",
                `Then call write_staged_scene and propose_state_delta again.`,
                "",
                `If one of these findings is a mistake you can see yourself making again on ` +
                  `later scenes, record the lesson with \`remember\` first — a repair round ` +
                  `is where the durable lessons are, and it is the one moment you can still ` +
                  `see what you did wrong.`,
                orchestratorNote(note),
              ]
                .filter(Boolean)
                .join("\n");

        await residents.invoke("writer", task, { txid, caller: "orchestrator" });

        if (!capture.prose) {
          // One explicit second ask. Models sometimes answer a drafting request
          // in prose instead of through the tool, and re-stating the mechanism
          // recovers it far more cheaply than losing the scene.
          await residents.invoke(
            "writer",
            `You replied without calling write_staged_scene, so nothing was staged for ` +
              `${sceneId} and none of your prose was kept. Call write_staged_scene now with ` +
              `the complete scene as its \`prose\` argument, then call propose_state_delta.`,
            { txid, caller: "orchestrator" },
          );
        }
        if (!capture.prose) {
          throw new CollaboratorError(
            `writer finished without calling write_staged_scene for ${sceneId}, twice`,
          );
        }
        if (!capture.delta) {
          // Prose without a recorded state change is the failure mode that
          // makes the next scene contradict this one, so it is worth one
          // explicit second ask before giving up.
          await residents.invoke(
            "writer",
            `You staged prose for ${sceneId} but never called propose_state_delta. ` +
              `Call it now with everything the scene established.`,
            { txid, caller: "orchestrator" },
          );
        }
        if (!capture.delta) {
          throw new CollaboratorError(
            `writer staged prose for ${sceneId} but never declared what it changed`,
          );
        }
        return { prose: capture.prose, delta: capture.delta };
      },

      async review({ packet, draft, note, dossier, finalScene }) {
        capture.findings = [];
        const task = [
          verifierBrief(finalScene),
          orchestratorNote(note),
          "",
          dossier,
          "",
          `## Context the writer was given\n\n${packet.rendered}`,
          "",
          `## The draft\n\n${draft.prose}`,
          "",
          `## What the writer says it established\n\n${JSON.stringify(
            draft.delta.claims,
            null,
            2,
          )}`,
        ]
          .filter(Boolean)
          .join("\n");

        /**
         * A verifier that could not run is not a verifier that found nothing.
         *
         * This is the most dangerous failure the system has, because it fails
         * *open* and looks like success: the verifier reports defects by calling
         * a tool, so a call that never happened leaves an empty findings buffer,
         * an empty buffer has no blockers, and no blockers is an approval.
         *
         * Measured, not imagined. On the first orchestrator-driven run every
         * `gemini-3.1-pro-preview` call returned
         * `429 channel:model_rate_limited`; pi recorded each as an assistant
         * message with empty content and `stopReason: "error"` rather than
         * throwing, and every scene was logged "APPROVED, 0 findings". The run
         * looked flawless precisely because the gate never ran.
         *
         * `invoke` now retries the retryable ones and raises `TurnFailed` when
         * it cannot get through. Converting it here rather than letting it
         * escape keeps the distinction the director needs: the scene is
         * committable, and it is not verified.
         */
        let turn: Awaited<ReturnType<typeof residents.invoke>>;
        try {
          turn = await residents.invoke("verifier", task, { txid, caller: "orchestrator" });
        } catch (error) {
          if (error instanceof TurnFailed) {
            throw new VerificationUnavailable(
              `the verifier could not be reached for ${sceneId}: ${error.message}`,
            );
          }
          throw error;
        }

        if (silentTurn(turn) && capture.findings.length === 0) {
          // No error, and nothing said either. One explicit second ask, because
          // "found nothing" costs at least a sentence and "said nothing" costs
          // no tokens at all.
          const retry = await residents.invoke(
            "verifier",
            `Your last reply was empty — no text and no tool calls — so nothing was ` +
              `recorded and the scene is currently unchecked. Check it now. If it is ` +
              `genuinely clean, say so in a sentence; an empty reply is read as approval ` +
              `and neither of us wants that to be how a scene gets through.\n\n${task}`,
            { txid, caller: "orchestrator" },
          );
          if (silentTurn(retry) && capture.findings.length === 0) {
            throw new VerificationUnavailable(
              `the verifier produced no output twice for ${sceneId} — no text, no tool ` +
                `calls, zero output tokens.`,
            );
          }
        }
        return [...capture.findings];
      },
    },
  };
}
