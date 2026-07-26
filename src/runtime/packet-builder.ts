/**
 * The context-builder, as an agent that actually searches the index.
 *
 * It was defined in the brief — *"context builder，专注于根据orch的本次写作人物从
 * index里面search、grep、read，构建writer的写作conetxt"* — and then, for nineteen
 * scenes, invoked zero times. The packet was assembled by a deterministic
 * function from the plan and an in-memory canon array. That arrangement has two
 * costs, and only the second is obvious.
 *
 * The obvious cost is reach: a fixed function can only include material somebody
 * thought to include. It cannot notice that this scene's location was described
 * six scenes ago, or that these two characters have a history worth re-reading,
 * because noticing is not something a template does.
 *
 * The subtler cost is that it made the paper's first claim untestable. "A unified
 * lossless index beats passing lossy summaries between components" is a claim
 * about *agents reading an index*. If no agent ever reads it, the run does not
 * test the claim — it tests a template, and a template's packet could have been
 * produced by any of the baselines.
 *
 * ## Deterministic skeleton, agent enrichment
 *
 * The builder does not start from nothing. `contextFor` still produces the P0/P1
 * skeleton — scene card, world rules, present entities' state and beliefs — and
 * that part stays deterministic because it is exactly the part that must not be
 * subject to judgement: a hard constraint the model decided to omit is the
 * failure mode the priority scheme exists to prevent.
 *
 * What the agent adds is P2–P4: what it can find by grepping that the skeleton
 * did not know to include. So the packet is a floor plus discretion, never
 * discretion alone.
 *
 * ## Follow-up rounds
 *
 * The brief allowed the writer up to three follow-up questions. That number is
 * now a measured parameter rather than a guess: every round is recorded with the
 * findings that followed, so "does a third round buy anything" is answerable
 * from run data instead of argued.
 */

import { Type } from "typebox";

import type { ContextItem, Priority } from "../context/types.ts";

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

/** What the builder contributed, so its value can be measured rather than assumed. */
export interface BuilderContribution {
  readonly sceneId: string;
  readonly items: readonly ContextItem[];
  /** Reads it performed, for the "was the grep worth it" question. */
  readonly reads: number;
  /** Follow-up questions answered for the writer in this scene. */
  readonly followUps: readonly { readonly question: string; readonly answer: string }[];
}

/**
 * A bus, for the same reason the scene tool bus exists: the builder is resident,
 * so its tools are registered once, but each scene needs its own buffer.
 */
export class BuilderBus {
  #items: ContextItem[] = [];
  #followUps: { question: string; answer: string }[] = [];
  #reads = 0;
  #sceneId = "s-000";
  #taken: ReadonlySet<string> = new Set();

  /**
   * Begin a scene, told which ids the skeleton already occupies.
   *
   * Without this the builder can collide with the skeleton and the packet build
   * throws — which is what happened on the first tree run: it chose the id
   * `story-so-far`, already used by the P3 beat list, and the whole
   * contribution for that scene was discarded with a one-line warning. A
   * collision is a naming accident, not a reason to lose the work.
   */
  open(sceneId: string, takenIds: Iterable<string> = []): void {
    this.#sceneId = sceneId;
    this.#items = [];
    this.#followUps = [];
    this.#reads = 0;
    this.#taken = new Set(takenIds);
  }

  get sceneId(): string {
    return this.#sceneId;
  }

  noteRead(): void {
    this.#reads += 1;
  }

  contribution(): BuilderContribution {
    return {
      sceneId: this.#sceneId,
      items: [...this.#items],
      reads: this.#reads,
      followUps: [...this.#followUps],
    };
  }

  /** Tools the builder writes its findings through. Registered once per process. */
  tools(): unknown[] {
    const bus = this;
    return [
      {
        label: "Add context item",
        name: "add_context_item",
        description:
          "Add material you found in the index to this scene's packet. P2 for direct " +
          "dependencies (the previous scene, a promise due here), P3 for remote recall " +
          "(something established long ago that this scene touches), P4 for optional " +
          "background. Quote or summarise the material itself — a pointer the writer has " +
          "to go and fetch is not context. Cite the file it came from.",
        parameters: Type.Object({
          id: Type.String({ description: "Short stable id, e.g. recall-lighthouse" }),
          priority: Type.String({ description: "P2 | P3 | P4" }),
          source: Type.String({ description: "File this came from" }),
          content: Type.String(),
        }),
        execute: async (
          _id: string,
          args: { id: string; priority: string; source: string; content: string },
        ) => {
          if (!["P2", "P3", "P4"].includes(args.priority)) {
            // P0 and P1 are the deterministic floor. Letting the builder write
            // them would put the hard constraints under its judgement, and a
            // constraint omitted by judgement is the exact failure the priority
            // scheme exists to prevent.
            return toolText(
              `rejected: priority must be P2, P3 or P4. P0 and P1 are assembled ` +
                `deterministically from the scene card and the entity files — you cannot ` +
                `add or replace a hard constraint, only supply what the skeleton did not ` +
                `know to look for.`,
            );
          }
          if (!args.content?.trim()) {
            return toolText("rejected: content is empty — a pointer is not context.");
          }
          if (!args.source?.trim()) {
            return toolText(
              "rejected: source is required. The writer has to be able to say where a " +
                "fact came from, and so does the verifier when it disagrees.",
            );
          }
          // Collisions are renamed, not refused. The id is a label for the
          // writer's benefit; losing a piece of researched context over it —
          // or losing the whole contribution, as the first run did — trades
          // something that matters for something that does not.
          let id = args.id;
          if (bus.#taken.has(id) || bus.#items.some((i) => i.id === id)) {
            let n = 2;
            while (bus.#taken.has(`${args.id}-${n}`) || bus.#items.some((i) => i.id === `${args.id}-${n}`)) {
              n += 1;
            }
            id = `${args.id}-${n}`;
          }
          bus.#items.push({
            id,
            priority: args.priority as Priority,
            source: args.source,
            content: args.content,
          });
          return toolText(
            id === args.id
              ? `added ${id} at ${args.priority}.`
              : `added as ${id} at ${args.priority} (${args.id} was already taken).`,
          );
        },
      },
      {
        label: "Answer writer",
        name: "answer_writer",
        description:
          "Answer a follow-up question from the writer, with what you found and where. If " +
          "the index does not contain the answer, say so — that is a real answer and the " +
          "writer needs it, whereas a plausible guess becomes canon.",
        parameters: Type.Object({
          question: Type.String(),
          answer: Type.String(),
        }),
        execute: async (_id: string, args: { question: string; answer: string }) => {
          if (!args.answer?.trim()) return toolText("rejected: answer is empty.");
          bus.#followUps.push({ question: args.question, answer: args.answer });
          return toolText("answered.");
        },
      },
    ];
  }
}

/** The brief the builder gets. Written to make it grep rather than summarise. */
export function builderBrief(input: {
  readonly sceneId: string;
  readonly intent: string;
  readonly presentEntities: readonly string[];
  readonly skeleton: string;
  readonly committedScenes: readonly string[];
  /** Where the assembled packet will be written, and where follow-ups append. */
  readonly packetPath?: string;
  /** What the orchestrator asked for on this scene, if it drove this call. */
  readonly note?: string;
}): string {
  return [
    `Build the context for scene ${input.sceneId}.`,
    "",
    `Intent: ${input.intent}`,
    `Present: ${input.presentEntities.join(", ") || "none stated"}`,
    "",
    "The P0 and P1 material is already assembled and is below. You cannot change it.",
    "Your job is what it does not know to look for: something established long ago that",
    "this scene touches, a promise falling due, a place or object that has been described",
    "before, a relationship whose history matters here.",
    "",
    "Search the index with the shell. Useful starting points:",
    `  grep -rn "<entity-id>" novel/chapters/ | tail -20`,
    `  cat characters/<id>/state.jsonl | tail -5`,
    `  ls relations/ && cat relations/<a>--<b>.yaml`,
    `  cat continuity/plot-contracts.jsonl`,
    input.committedScenes.length > 0
      ? `Scenes written so far: ${input.committedScenes.join(", ")}.`
      : "Nothing has been written yet, so there is no recall to do — say so and stop.",
    "",
    "Add what you find with add_context_item. Quote the material; a pointer is not context.",
    "Add nothing if there is nothing — a padded packet costs the writer attention it needs",
    "for the scene, and every item you add is also an item the verifier reads.",
    input.packetPath
      ? `\nEverything you add is assembled into ${input.packetPath}, which is the document ` +
        `the writer works from. If it asks a follow-up later, your answer is appended to that ` +
        `same file rather than sent as a loose reply — so answer as though you were adding to ` +
        `the packet, because you are.`
      : "",
    input.note
      ? `\n## What the orchestrator asked for on this scene\n\n${input.note.trim()}\n\n` +
        `That is in addition to the above, not instead of it.`
      : "",
    "",
    "Finish by saying in one sentence what you added and which files you read it from.",
    "",
    "--- P0/P1 skeleton, already in the packet ---",
    "",
    input.skeleton,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The follow-up question, when the writer wants more before drafting. */
export function followUpBrief(input: {
  readonly sceneId: string;
  readonly question: string;
  readonly round: number;
  readonly maxRounds: number;
}): string {
  return [
    `The writer has a question about scene ${input.sceneId} (round ${input.round} of ` +
      `${input.maxRounds}).`,
    "",
    input.question,
    "",
    "Search the index and answer with answer_writer. If the index does not contain the",
    "answer, say exactly that — an invented answer becomes canon the moment the writer",
    "uses it, and nothing downstream can tell it was invented.",
  ].join("\n");
}

/**
 * The tool the writer uses to ask.
 *
 * Bounded, and the bound is visible in the refusal: an agent told "no" without a
 * reason retries, and an agent told "you have used your rounds" writes the scene.
 */
/**
 * The writer's read of its own packet.
 *
 * The writer has no shell, deliberately: its job is the prose, and the measured
 * behaviour said the shell did not help it — across a whole run it ran four
 * commands to the builder's forty-eight. But "no shell" is not the same as "no
 * reading". Its packet is a document written for it, a follow-up answer is
 * appended to that document, and re-reading it is how the answer becomes part of
 * the material rather than a reply that scrolled past.
 *
 * Scoped to that one file on purpose. A path argument would make this a general
 * read tool wearing a narrow name.
 */
export function readContextTool(options: {
  readonly path: () => string | null;
  readonly read: (relPath: string) => Promise<string | null>;
}): unknown {
  return {
    label: "Read context",
    name: "read_context",
    description:
      "Re-read your context packet for this scene, including any follow-up answers that " +
      "have been appended to it since you were given it.",
    parameters: Type.Object({
      purpose: Type.String({ description: "Why you are re-reading it" }),
    }),
    execute: async () => {
      const relPath = options.path();
      if (!relPath) {
        return toolText(
          "there is no packet file for the scene in progress. Everything you were given is " +
            "in the message that opened this turn.",
        );
      }
      const text = await options.read(relPath);
      return toolText(
        text ??
          `${relPath} has not been written yet. What you were given at the start of this ` +
            `turn is all there is; do not treat its absence as licence to invent.`,
      );
    },
  };
}

export function askBuilderTool(options: {
  readonly ask: (question: string) => Promise<string>;
  readonly roundsUsed: () => number;
  readonly maxRounds: number;
}): unknown {
  return {
    label: "Ask context builder",
    name: "ask_context_builder",
    description:
      `Ask the context-builder for something the packet does not contain. It can search ` +
      `the whole index. Up to ${options.maxRounds} questions per scene — ask for what you ` +
      `actually need before drafting rather than guessing and being sent back.`,
    parameters: Type.Object({
      question: Type.String({ description: "One specific question" }),
    }),
    execute: async (_id: string, args: { question: string }) => {
      if (options.roundsUsed() >= options.maxRounds) {
        return toolText(
          `no follow-ups left for this scene (${options.maxRounds} used). Write the scene ` +
            `with what you have, and if a hard constraint is genuinely missing, say so in ` +
            `your reply instead of inventing it.`,
        );
      }
      if (!args.question?.trim()) return toolText("rejected: ask something specific.");
      return toolText(await options.ask(args.question));
    },
  };
}
