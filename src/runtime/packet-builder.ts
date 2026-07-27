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
 * How many questions the writer may ask is not a property of this file: it is
 * decided per scene in `allocation.ts` from where the scene sits in the story,
 * one in the opening third and five in the endgame. It used to be the constant
 * `FOLLOW_UP_ROUNDS = 3`, and the constant is gone rather than defaulted — a
 * default would be a second answer to a question that now has one place to ask.
 * Every round is recorded with the findings that followed, so "did the fifth
 * round buy anything" stays answerable from run data.
 */

import { Type } from "typebox";

import type { ContextItem, Priority } from "../context/types.ts";
import type { SceneAllocation } from "./allocation.ts";

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

/**
 * Something this scene needs that the index does not contain.
 *
 * The reason this type exists is a measurement. Across three runs the writer
 * asked the builder **zero** questions, with the tool registered, named in its
 * prompt and given a section of its own. Reading a writer transcript explained
 * why, and it was not reluctance: nothing in the packet said anything was
 * missing. A packet presents itself as complete, an agent handed a complete
 * document and an instruction to write does not stop to interrogate it, and the
 * gaps only became visible at the moment the writer invented something to fill
 * them — by which point asking is not the obvious move, finishing is.
 *
 * So the builder now says what it looked for and did not find. A named gap is
 * something to ask about; an absence is not.
 */
export interface ContextGap {
  /** What the scene needs, in the writer's terms. */
  readonly need: string;
  /** Where the builder looked, so the writer does not send it back over the same ground. */
  readonly searched: string;
}

/** What the builder contributed, so its value can be measured rather than assumed. */
export interface BuilderContribution {
  readonly sceneId: string;
  readonly items: readonly ContextItem[];
  /** Reads it performed, for the "was the grep worth it" question. */
  readonly reads: number;
  /** Follow-up questions answered for the writer in this scene. */
  readonly followUps: readonly { readonly question: string; readonly answer: string }[];
  /** What this scene needs and the index does not have. */
  readonly gaps: readonly ContextGap[];
}

/**
 * A bus, for the same reason the scene tool bus exists: the builder is resident,
 * so its tools are registered once, but each scene needs its own buffer.
 */
export class BuilderBus {
  /**
   * Does this source name a file that exists in the project?
   *
   * Injected because the bus has no index handle, and required because the
   * alternative was measured. `add_context_item` takes a `source` and checked only
   * that it was non-empty, so the builder could add anything and name anything as
   * its provenance. On the 20k run `lnb20k-fantasy-the-girl-with-a-thousand-faces`
   * it added **93 items**, four of which cite no file at all — two of them
   * literally `source: "synthetic"` — and the content of those is invented world
   * material presented to the writer as established:
   *
   * > *"Canonical behaviors when a ritual 'goes wrong' (P3, consistent with
   * > spirit-vengeful sketch and world rules): Voices become physical…"*
   *
   * > *"Practical use in scene: Mercy finds a faded portrait in a token stall or
   * > folded into a wallet…"*
   *
   * Nothing in the index says either. The first calls itself canonical; the second
   * is the builder staging the scene, which its own prompt forbids in as many
   * words — *"You never decide what the scene should contain"*. And the shared
   * contract this system is built on is that a fact not in the index is not
   * established, because an invented one is indistinguishable from a real one once
   * it reaches the page and is then defended by every later scene.
   *
   * The builder already has the correct channel for exactly this: `note_gap`. "The
   * market's smells are not recorded anywhere" is a gap, the writer is told it is
   * free, and whatever it invents lands in the state delta where it becomes canon
   * *with a record of having been decided*. Fabricating the answer instead skips
   * that record, which is the whole apparatus.
   */
  #resolves: (source: string) => boolean = () => true;
  #items: ContextItem[] = [];
  #followUps: { question: string; answer: string }[] = [];
  #gaps: ContextGap[] = [];
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
    this.#gaps = [];
    this.#reads = 0;
    this.#taken = new Set(takenIds);
    this.#pending = null;
  }

  get sceneId(): string {
    return this.#sceneId;
  }

  /**
   * The writer's question, while one is outstanding.
   *
   * This exists because of a defect measured in `runs/v062/lbw081`, and the shape
   * of it is worth stating precisely because it silently removed a whole mechanism.
   *
   * The writer's follow-up allowance was metered by counting `answer_writer` calls.
   * That tool is on the builder's allowlist permanently, so it is callable during
   * the *initial* build, when there is no question to answer — and on scene `s-001`
   * the builder called it unprompted, inside its build turn, before the writer had
   * spoken. The count reached one, the opening tier's allowance is one, and the
   * writer's first and only question came back `no follow-ups left for this scene`.
   * It then said so in its closing message and wrote the scene without the fact it
   * had asked for.
   *
   * So the opening tier had an allowance of zero in practice, which is invisible in
   * every summary: `follow_ups.by_tier` counted the builder's spontaneous call as a
   * follow-up, so the mechanism looked used.
   *
   * A pending question makes the tool's precondition explicit. Unsolicited material
   * has its own channel — `add_context_item` — and always did.
   */
  #pending: string | null = null;

  /** Called by the harness immediately before the builder is asked a question. */
  expect(question: string): void {
    this.#pending = question;
  }

  /**
   * Teach the bus which sources are real. Called once, at assembly.
   *
   * Left permissive by default so unit tests can exercise the rest of the tool
   * without a project on disk — the enforcement that matters is in a live run,
   * where a fabricated source is a fabricated fact.
   */
  checkSourcesWith(resolves: (source: string) => boolean): void {
    this.#resolves = resolves;
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
      gaps: [...this.#gaps],
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
          if (!bus.#resolves(args.source)) {
            return toolText(
              `rejected: "${args.source}" is not a file in this project, so whatever is in ` +
                `this item is not established — you wrote it. Cite the path you read it from ` +
                `(\`objects/obj-x.yaml\`, \`novel/chapters/ch-01/scenes/s-003.md\`, ` +
                `\`continuity/plot-contracts.jsonl\`), one file per item.\n` +
                `If the index genuinely does not contain it, that is what \`note_gap\` is ` +
                `for, and a recorded gap is worth more than a plausible answer: the writer is ` +
                `then told it is free, and whatever it invents lands in the state delta where ` +
                `it becomes canon *with a record of having been decided*. An item you compose ` +
                `and label canonical skips that record, and every later scene will defend it.`,
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
        label: "Note gap",
        name: "note_gap",
        description:
          "Record something this scene will need that the index does not contain. Use it " +
          "when a search comes back empty and the writer would otherwise have to invent " +
          "the answer: a place with no description on file, two characters with no " +
          "recorded history, a promise whose exact wording you could not find. This is " +
          "not a failure to report — an unrecorded gap is the one the writer fills " +
          "silently, and an invented fact is indistinguishable from an established one " +
          "the moment it is on the page.",
        parameters: Type.Object({
          need: Type.String({ description: "What the scene needs, in the writer's terms" }),
          searched: Type.String({
            description: "Where you looked, so nobody sends you back over the same ground",
          }),
        }),
        execute: async (_id: string, args: { need: string; searched: string }) => {
          if (!args.need?.trim()) return toolText("rejected: say what is missing.");
          if (!args.searched?.trim()) {
            return toolText(
              "rejected: say where you looked. A gap with no search behind it is a guess " +
                "that something is absent, and the writer cannot tell the two apart.",
            );
          }
          bus.#gaps.push({ need: args.need, searched: args.searched });
          return toolText(`gap recorded: ${args.need}`);
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
          if (bus.#pending === null) {
            // Not pedantry: an unsolicited call here spends the writer's follow-up
            // allowance, and on the opening tier that allowance is one — so the
            // writer's only question came back refused before it had asked it.
            return toolText(
              "rejected: no follow-up is outstanding, so there is nothing to answer. This " +
                "tool spends the writer's question allowance for the scene, and calling it " +
                "unprompted spends it on a question nobody asked — on the opening tier, " +
                "where the allowance is one, that leaves the writer none. Material you " +
                "found and think the writer needs goes through add_context_item, which is " +
                "unlimited and lands in the packet.",
            );
          }
          bus.#followUps.push({ question: args.question, answer: args.answer });
          bus.#pending = null;
          return toolText("answered.");
        },
      },
    ];
  }
}

/**
 * How far back to look, by where the scene sits.
 *
 * The measured basis is `experiments/degradation`: consistency-error instances
 * rise with the volume of text a passage has to agree with, and timeline/plot and
 * factual detail — the two classes that depend on earlier text rather than on the
 * passage itself — are 54.8% of them. A late scene's risk is concentrated in
 * material a search of the last scene will not reach.
 */
const RECALL_DEPTH: Readonly<Record<SceneAllocation["tier"], string>> = {
  opening:
    "This scene is in the opening third. There is little behind it, so recall is cheap and " +
    "mostly unnecessary — check the scene before it and the entity files, and do not pad. An " +
    "item added here is an item the writer and the verifier both read.",
  middle:
    "This scene is in the middle third. Enough is on the page that the writer can now " +
    "contradict it without noticing: grep the committed scenes for every entity present, and " +
    "read the promise ledger for anything falling due. What has changed since a character was " +
    "last on the page is the thing most often missed.",
  endgame:
    "This scene is in the final 40%, and this is where the recall earns its cost. An ending " +
    "has to be consistent with the whole book rather than with its neighbour, and payoffs " +
    "land here — so go back to where each thread *started*, not to where it was last " +
    "mentioned, and quote the original wording of anything being paid off. Read the promise " +
    "ledger in full. Check every entity present against its first appearance as well as its " +
    "current state: a detail established in chapter one and quietly drifted since is the " +
    "defect class that nothing else in the loop can see.",
};

/** The brief the builder gets. Written to make it grep rather than summarise. */
export function builderBrief(input: {
  readonly sceneId: string;
  readonly intent: string;
  readonly presentEntities: readonly string[];
  readonly skeleton: string;
  readonly committedScenes: readonly string[];
  /** Where the assembled packet will be written, and where follow-ups append. */
  readonly packetPath?: string;
  /** Where this scene sits, and therefore how far back the recall should reach. */
  readonly allocation: SceneAllocation;
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
    "Search the index with the shell, and **batch it**. One command can answer several",
    "questions, and one reply can carry several tool calls — measured, you averaged 22.5",
    "round-trips per build with 96% of them carrying a single read, each re-sending a",
    "transcript that had grown to 12,000 tokens to get one file back. That loop is most of",
    "what a run spends and most of how long it takes.",
    "",
    "So decide what you want, then ask for it all at once. `read_index` takes a **list** of",
    "paths — one call for ten files costs one round-trip, ten calls cost ten:",
    `  read_index paths=["characters/char-a/profile.yaml", "objects/obj-key.yaml", …]`,
    `  grep -rn "<id-a>\\|<id-b>\\|<id-c>" novel/chapters/ | tail -40`,
    `  cat characters/*/state.jsonl continuity/plot-contracts.jsonl relations/<a>--<b>.yaml`,
    `  ls relations/ objects/ locations/`,
    "A second round-trip is worth it when what you read next depends on what came back. It",
    "is not worth it for a list of files you had already chosen.",
    input.committedScenes.length > 0
      ? `Scenes written so far: ${input.committedScenes.join(", ")}.`
      : "Nothing has been written yet, so there is no recall to do — say so and stop.",
    "",
    // How hard to look is a function of where the scene is. Told to be equally
    // thorough everywhere, an agent is thorough where it is cheap: it reads the
    // previous scene, finds it sufficient, and stops — which is right for scene 2
    // and is how an ending contradicts chapter 1.
    RECALL_DEPTH[input.allocation.tier],
    "",
    "Add what you find with add_context_item. Quote the material; a pointer is not context.",
    "Add nothing if there is nothing — a padded packet costs the writer attention it needs",
    "for the scene, and every item you add is also an item the verifier reads.",
    "",
    "Then record what you could **not** find, with note_gap. Read the scene's intent and ask",
    "what a writer must know to write it: what this place looks like, whether these two have",
    "met, what exactly was promised. For each one you searched for and did not find, note it.",
    "This half matters as much as the first. What you add, the writer uses; what you record",
    "as missing is what the writer would otherwise invent without noticing it was inventing —",
    "and an invented fact is indistinguishable from an established one the moment it is on",
    "the page.",
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

/**
 * The gap list, as the writer sees it.
 *
 * Rendered as a decision rather than a report. Every line offers exactly two
 * moves and names the cost of each, because the failure being fixed is not that
 * the writer chose badly — it is that it never noticed there was a choice.
 */
export function renderGaps(gaps: readonly ContextGap[], maxRounds: number): string {
  if (gaps.length === 0) return "";
  return [
    "",
    "## What the index does not have",
    "",
    "The context-builder searched for these and came back empty. Each is something this",
    "scene needs, so each one you leave alone is one you will invent without meaning to.",
    "",
    ...gaps.map((g) => `- **${g.need}** (searched: ${g.searched})`),
    "",
    `For each: either ask \`ask_context_builder\` — you have ${maxRounds} questions and they`,
    "cost far less than a repair round — or invent it deliberately and put it in your state",
    "delta so it becomes canon rather than a floating detail. What you may not do is fill it",
    "in silently; that is the one move nothing downstream can detect.",
  ].join("\n");
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
  /**
   * Read per call, not captured once.
   *
   * The limit is now a property of the scene rather than of the system — one
   * question in the opening third, five in the endgame — and this tool belongs to
   * a resident agent whose tools are built once at construction. A number passed
   * in here would be scene 1's allowance enforced for the rest of the book.
   */
  readonly maxRounds: () => number;
}): unknown {
  return {
    label: "Ask context builder",
    name: "ask_context_builder",
    /**
     * Never concurrently with itself, because it delegates to another agent.
     *
     * pi executes a batch of tool calls in parallel by default, and this tool
     * `invoke`s the resident context-builder. Two of them in one assistant message
     * means the second arrives while the builder is mid-turn, and pi answers it with
     * `Agent is already processing a prompt. Use steer() or followUp() to queue
     * messages, or wait for completion.` — which the harness then handed to the
     * writer *as the answer to its question*.
     *
     * Measured on `runs-r1/lbw081`, and partly caused by us: v0.7.5 added "ask for
     * everything you already know you need, in one message" to `SHARED.md` to cut
     * round-trips, and the writer did exactly that. Scene 3 asked five questions in
     * one reply; **one** was answered and four came back with the framework's
     * error. The writer cannot tell that string from a real answer, so it wrote the
     * scene believing the index had nothing to say.
     *
     * Batching is right for file reads and wrong for delegation. Sequential
     * execution makes each question wait for the previous answer, which is also what
     * a follow-up *is*: the second question is usually shaped by the first reply.
     */
    executionMode: "sequential" as const,
    description:
      `Ask the context-builder for something the packet does not contain. It can search ` +
      `the whole index. How many questions you get depends on where the scene sits in the ` +
      `story and is stated in your brief — more later, where there is more to be consistent ` +
      `with. Ask for what you actually need before drafting rather than guessing and being ` +
      `sent back.`,
    parameters: Type.Object({
      question: Type.String({ description: "One specific question" }),
    }),
    execute: async (_id: string, args: { question: string }) => {
      const maxRounds = options.maxRounds();
      const used = options.roundsUsed();
      if (used >= maxRounds) {
        return toolText(
          // Both numbers, because the previous wording printed the allowance where
          // it meant the count — so a refusal caused by a bug elsewhere read as a
          // writer that had used up its questions.
          `no follow-ups left for this scene (${used} of ${maxRounds} used). Write the ` +
            `scene with what you have, and if a hard constraint is genuinely missing, say so ` +
            `in your reply instead of inventing it.`,
        );
      }
      if (!args.question?.trim()) return toolText("rejected: ask something specific.");
      return toolText(await options.ask(args.question));
    },
  };
}
