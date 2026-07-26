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
import { makeFinding } from "../verification/finding.ts";
import { LITERARY_EXEMPTIONS, SUBTYPES, subtypesForTier } from "../verification/taxonomy.ts";
import type { Draft, SceneCollaborators } from "./scene-loop.ts";
import type { ResidentAgents } from "../agents/residents.ts";

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

const VERIFIER_BRIEF = [
  "Check this scene against the index and the scene card.",
  "",
  "Read before you judge. You have `bash` and `read` over the whole project, and a",
  "finding that quotes the actual earlier scene is one the writer can act on rather",
  "than argue with. Work through the five categories, using the files named:",
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
  "You can read the whole book. `run_command` reaches every committed scene under",
  "novel/chapters/, every character file, the relation records and the promise ledger — so",
  "when a passage looks wrong, check before reporting. The packet is what the writer was",
  "given, not the limit of what you may consult, and a finding that quotes the actual",
  "earlier scene is one the writer can act on rather than argue with.",
].join("\n");


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
  readonly build?: (input: {
    readonly sceneId: string;
    readonly skeleton: ContextPacket;
  }) => Promise<readonly ContextItem[]>;
  /** Ask the resident index-manager to fold the approved scene into the index. */
  readonly backfill?: (input: {
    readonly sceneId: string;
    readonly draft: Draft;
    readonly packet: ContextPacket;
  }) => Promise<readonly FileWrite[]>;
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
      async draft({ packet, attempt, repairBrief }): Promise<Draft> {
        capture.prose = undefined;
        capture.delta = undefined;

        const task =
          attempt === 0
            ? `${packet.rendered}\n\nWrite scene ${sceneId}. Call write_staged_scene with the ` +
              `prose, then propose_state_delta with everything it established.`
            : `Your draft of ${sceneId} came back with findings. Repair the specific defects ` +
              `below — do not rewrite the scene wholesale, and read each finding's locus ` +
              `before you change anything.\n\n${repairBrief}\n\nThen call write_staged_scene ` +
              `and propose_state_delta again.\n\nIf one of these findings is a mistake you ` +
              `can see yourself making again on later scenes, record the lesson with ` +
              `\`remember\` first — a repair round is where the durable lessons are, and it ` +
              `is the one moment you can still see what you did wrong.`;

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

      async review({ packet, draft }) {
        capture.findings = [];
        await residents.invoke(
          "verifier",
          `${VERIFIER_BRIEF}\n\n## Context the writer was given\n\n${packet.rendered}\n\n` +
            `## The draft\n\n${draft.prose}\n\n## What the writer says it established\n\n` +
            `${JSON.stringify(draft.delta.claims, null, 2)}`,
          { txid, caller: "orchestrator" },
        );
        return [...capture.findings];
      },
    },
  };
}
