/**
 * The index-manager's write surface.
 *
 * Every tool here reports its problems synchronously and in full. That is the
 * cheapest feedback signal in the system: a schema complaint answered in the same
 * turn costs one tool call, whereas the same mistake caught by the verifier costs
 * a whole repair round, and the same mistake caught by *nothing* costs a
 * contradiction in a later scene that nobody can trace.
 *
 * The tools are deliberately fine-grained — one per partition rather than one
 * `update_index(everything)` — for the same reason the partitions are separate.
 * A single blob tool would let a state observation be filed as identity, which is
 * precisely the confusion that cost 80% of the failed scenes in the first long
 * run.
 */

import { Type } from "typebox";

import { BackfillError, type PartitionWriter } from "../index/backfill.ts";
import { STATE_ATTRIBUTES, IDENTITY_ATTRIBUTES } from "../index/entities.ts";
import { RelationRecordError } from "../index/relations.ts";
import { paths } from "../index/tree.ts";

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

/**
 * These tools must not run concurrently with each other.
 *
 * pi executes a batch of tool calls in parallel by default
 * (`toolExecution ?? "parallel"`), and every tool here is a read-modify-write
 * against the same pending-writes map. Two `append_state` calls issued in one
 * assistant message would both read the same base and the second would overwrite
 * the first — losing a state entry silently, in a step whose entire purpose is
 * not to lose anything. The index-manager is also the role most likely to emit a
 * batch, because folding a scene means touching six partitions at once.
 */
const SEQUENTIAL = "sequential" as const;

/** Turn a thrown validation error back into feedback rather than a dead turn. */
async function reporting(work: () => Promise<string>): Promise<{ content: { type: string; text: string }[] }> {
  try {
    return toolText(await work());
  } catch (error) {
    if (error instanceof BackfillError) {
      return toolText(`rejected:\n- ${error.problems.join("\n- ")}`);
    }
    if (error instanceof RelationRecordError) {
      return toolText(`rejected (relation record):\n- ${error.problems.join("\n- ")}`);
    }
    throw error;
  }
}

export function indexManagerTools(writer: () => PartitionWriter): unknown[] {
  const identityNames = IDENTITY_ATTRIBUTES.filter((a) => /^[a-z]/.test(a)).join(" | ");
  return [
    {
      label: "Upsert character",
      name: "upsert_character",
      executionMode: SEQUENTIAL,
      description:
        "Create a character file or add identity attributes to one. Identity means what " +
        "does not vary with the plot. Anything that changes as the story moves goes to " +
        "append_state instead.",
      parameters: Type.Object({
        id: Type.String({ description: "e.g. char-araine" }),
        name: Type.String(),
        sketch: Type.String({ description: "One or two sentences" }),
        identity: Type.Array(
          Type.Object({
            attribute: Type.String({ description: identityNames }),
            value: Type.String(),
          }),
        ),
      }),
      execute: async (
        _id: string,
        args: { id: string; name: string; sketch: string; identity: { attribute: string; value: string }[] },
      ) =>
        reporting(async () => {
          const identity = Object.fromEntries(
            (args.identity ?? []).map((a) => [a.attribute, a.value]),
          );
          const { conflicts } = await writer().upsertCharacter({
            id: args.id,
            name: args.name,
            sketch: args.sketch,
            identity,
          });
          return conflicts.length > 0
            ? `written, but ${conflicts.length} attribute(s) were not applied:\n- ` +
                conflicts.join("\n- ")
            : `${paths.profile(args.id)} written.`;
        }),
    },
    {
      label: "Append state",
      name: "append_state",
      executionMode: SEQUENTIAL,
      description:
        `Record what is now true of a character after this scene. Attributes: ` +
        `${STATE_ATTRIBUTES.join(", ")}. Append-only — the newest entry wins, so moving a ` +
        `character needs no retcon. Quote the prose for each.`,
      parameters: Type.Object({
        character: Type.String(),
        entries: Type.Array(
          Type.Object({
            attribute: Type.String({ description: STATE_ATTRIBUTES.join(" | ") }),
            value: Type.String(),
            quote: Type.String({ description: "Verbatim prose from this scene" }),
          }),
        ),
      }),
      execute: async (
        _id: string,
        args: { character: string; entries: { attribute: string; value: string; quote: string }[] },
      ) =>
        reporting(async () => {
          await writer().appendState(args.character, args.entries ?? []);
          return `${args.entries?.length ?? 0} state entr(ies) appended to ${paths.state(args.character)}.`;
        }),
    },
    {
      label: "Append beliefs",
      name: "append_beliefs",
      executionMode: SEQUENTIAL,
      description:
        "Record what a character now knows, suspects, is wrong about, or is still ignorant " +
        "of. This is the boundary that decides whether their next line is a revelation or " +
        "a continuity error, so it is tracked separately from what is true.",
      parameters: Type.Object({
        character: Type.String(),
        entries: Type.Array(
          Type.Object({
            proposition: Type.String(),
            stance: Type.String({ description: "knows | suspects | wrong-about | ignorant-of" }),
            quote: Type.String(),
          }),
        ),
      }),
      execute: async (
        _id: string,
        args: { character: string; entries: { proposition: string; stance: string; quote: string }[] },
      ) =>
        reporting(async () => {
          await writer().appendBeliefs(args.character, args.entries ?? []);
          return `${args.entries?.length ?? 0} belief entr(ies) appended.`;
        }),
    },
    {
      label: "Record relation phase",
      name: "record_relation_phase",
      executionMode: SEQUENTIAL,
      description:
        "Open, close or revise a phase in one pair's relationship. Use it when this scene " +
        "changed what these two are to each other. `transition` must say how and why the " +
        "phase began — that sentence is what a later scene needs and what a label cannot " +
        "carry.",
      parameters: Type.Object({
        participants: Type.Array(Type.String(), { minItems: 2, maxItems: 2 }),
        relation: Type.String({ description: "e.g. wary allies, mentor, rivals" }),
        transition: Type.String({ description: "How and why this phase began" }),
        span: Type.String({ description: "Line span in this scene, e.g. L44-L60" }),
        asymmetry: Type.Optional(
          Type.String({ description: "When A's view of B differs from B's view of A" }),
        ),
        closes_previous: Type.Optional(
          Type.Boolean({ description: "Close the pair's latest open phase at this scene" }),
        ),
        supersedes: Type.Optional(
          Type.Number({ description: "Phase index this revises in place" }),
        ),
      }),
      execute: async (
        _id: string,
        args: {
          participants: string[];
          relation: string;
          transition: string;
          span: string;
          asymmetry?: string;
          closes_previous?: boolean;
          supersedes?: number;
        },
      ) =>
        reporting(async () => {
          const [a, b] = args.participants ?? [];
          if (!a || !b) throw new BackfillError(["participants must be exactly two entity ids"]);
          const { pairId, phaseIndex } = await writer().recordRelationPhase({
            participants: [a, b],
            relation: args.relation,
            transition: args.transition,
            span: args.span,
            ...(args.asymmetry ? { asymmetry: args.asymmetry } : {}),
            ...(args.closes_previous ? { closesPrevious: true } : {}),
            ...(args.supersedes ? { supersedes: args.supersedes } : {}),
          });
          return `phase ${phaseIndex} recorded in ${paths.relation(pairId)}.`;
        }),
    },
    {
      label: "Append event",
      name: "append_event",
      executionMode: SEQUENTIAL,
      description:
        "Record something that happened, in story time. Events are not properties: 'she " +
        "crossed the quay' belongs here, not on her file.",
      parameters: Type.Object({
        summary: Type.String(),
        participants: Type.Array(Type.String()),
        location: Type.Optional(Type.String()),
        when: Type.Optional(Type.String({ description: "Story time if the scene states one" })),
      }),
      execute: async (
        _id: string,
        args: { summary: string; participants: string[]; location?: string; when?: string },
      ) =>
        reporting(async () => {
          await writer().appendEvent({
            summary: args.summary,
            participants: args.participants ?? [],
            location: args.location ?? null,
            when: args.when ?? null,
          });
          return `event appended to ${paths.timeline()}.`;
        }),
    },
    {
      label: "Record rhythm",
      name: "record_rhythm",
      executionMode: SEQUENTIAL,
      description:
        "Where this scene sits in the story's rise and fall. Target is what the plan wanted " +
        "here; actual is what the prose delivered. A gap is not a defect to fix now — it is " +
        "how the closing pass finds a sagging middle.",
      parameters: Type.Object({
        beat: Type.String({ description: "e.g. setup, turn, complication, release" }),
        tension_target: Type.Number({ description: "0–10" }),
        tension_actual: Type.Number({ description: "0–10, as delivered" }),
        note: Type.String(),
      }),
      execute: async (
        _id: string,
        args: { beat: string; tension_target: number; tension_actual: number; note: string },
      ) =>
        reporting(async () => {
          await writer().recordRhythm({
            beat: args.beat,
            tensionTarget: args.tension_target,
            tensionActual: args.tension_actual,
            note: args.note,
          });
          return `rhythm row written for ${writer().sceneId}.`;
        }),
    },
    {
      label: "Register promise",
      name: "register_promise",
      executionMode: SEQUENTIAL,
      description:
        "Record a promise this scene made to the reader. Registered when made, never " +
        "reconstructed later — an abandoned thread is invisible at the end precisely " +
        "because nothing refers to it.",
      parameters: Type.Object({
        id: Type.String({ description: "Stable id, e.g. pc-locked-ledger" }),
        promise: Type.String(),
        quote: Type.String(),
        due_by_scene: Type.Optional(Type.String()),
      }),
      execute: async (
        _id: string,
        args: { id: string; promise: string; quote: string; due_by_scene?: string },
      ) =>
        reporting(async () => {
          await writer().registerPromise({
            id: args.id,
            promise: args.promise,
            quote: args.quote,
            dueByScene: args.due_by_scene ?? null,
          });
          return `promise ${args.id} registered.`;
        }),
    },
    {
      label: "Pay off promise",
      name: "pay_off_promise",
      executionMode: SEQUENTIAL,
      description:
        "Mark a registered promise as answered by this scene, quoting the prose that " +
        "answers it.",
      parameters: Type.Object({
        contract_id: Type.String(),
        quote: Type.String(),
      }),
      execute: async (_id: string, args: { contract_id: string; quote: string }) =>
        reporting(async () => {
          await writer().payOffPromise(args.contract_id, args.quote);
          return `promise ${args.contract_id} marked paid off.`;
        }),
    },
    {
      label: "Record retcon",
      name: "record_retcon",
      executionMode: SEQUENTIAL,
      description:
        "Change an identity attribute that was already established, on purpose. The old " +
        "value stays readable in the retcon log so a later reader can tell a decision from " +
        "a mistake.",
      parameters: Type.Object({
        entity: Type.String(),
        attribute: Type.String(),
        from: Type.String(),
        to: Type.String(),
        reason: Type.String(),
      }),
      execute: async (
        _id: string,
        args: { entity: string; attribute: string; from: string; to: string; reason: string },
      ) =>
        reporting(async () => {
          await writer().recordRetcon(args);
          return `retcon recorded and ${paths.profile(args.entity)} updated.`;
        }),
    },
    {
      label: "Upsert entity",
      name: "upsert_entity",
      executionMode: SEQUENTIAL,
      description: "Create or annotate a location, object or faction.",
      parameters: Type.Object({
        kind: Type.String({ description: "location | object | faction" }),
        id: Type.String(),
        sketch: Type.String(),
        notes: Type.Optional(Type.String()),
      }),
      execute: async (
        _id: string,
        args: { kind: string; id: string; sketch: string; notes?: string },
      ) =>
        reporting(async () => {
          if (!["location", "object", "faction"].includes(args.kind)) {
            throw new BackfillError([`kind must be location, object or faction`]);
          }
          await writer().upsertEntity(args.kind as "location" | "object" | "faction", {
            id: args.id,
            sketch: args.sketch,
            ...(args.notes ? { notes: args.notes } : {}),
          });
          return `${args.kind} ${args.id} written.`;
        }),
    },
  ];
}
