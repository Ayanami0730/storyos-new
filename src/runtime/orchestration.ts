/**
 * The orchestrator, actually orchestrating.
 *
 * Until now it planned the story and then went silent: eight messages in a
 * whole run, no delegation, while the engine called the other four in a fixed
 * order. Its prompt described a loop it had no tools to perform.
 *
 * These are those tools. Each one is a delegation to a resident specialist and
 * a step of the scene transaction at the same time, which is not a coincidence
 * — the transaction's actors *are* the specialists. `call_index_manager` is the
 * commit because index-manager is the only actor that may produce COMMITTED.
 * There is no separate "commit" tool to be called by the wrong role, because
 * there is no separate commit.
 *
 * ## Why the engine still has a driver
 *
 * A model that forgets to call `call_index_manager` would otherwise throw away
 * an approved scene, and one that loops would burn a run. So the orchestrator
 * gets a bounded number of turns per scene, and whatever it leaves unfinished
 * the engine finishes with the deterministic driver — recording that it had to.
 * That number is the measurement this whole change exists to produce: a scene
 * the orchestrator carried to a commit by itself is evidence that agent-driven
 * orchestration works, and a scene the engine had to rescue is evidence it does
 * not yet. Either way the novel gets written.
 */

import { Type } from "typebox";

import type { AgentRole } from "../transaction/types.ts";
import type { ResidentAgents } from "../agents/residents.ts";
import { type SceneAllocation, renderAllocation } from "./allocation.ts";
import { BudgetExhausted } from "./budget.ts";
import type { SceneDirector, StepReport } from "./scene-director.ts";
import type { SceneOutcome } from "./scene-loop.ts";

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

/**
 * Which director the orchestrator's tools point at right now.
 *
 * The same seam as the scene tool bus, for the same reason: the orchestrator is
 * resident, so its tools are registered once at construction, but each scene is
 * its own transaction. A tool closing over scene 1's director would still be
 * committing into scene 1's transaction at scene 40.
 */
export class SceneStage {
  #director: SceneDirector | null = null;
  #steps: { scene: string; step: string; ok: boolean }[] = [];
  #words: { committed: number; target: number } = { committed: 0, target: 0 };

  open(director: SceneDirector, words?: { committed: number; target: number }): void {
    this.#director = director;
    if (words) this.#words = words;
  }

  /** Words on the page against the task target, for the writer's draft prompt. */
  get words(): { committed: number; target: number } {
    return this.#words;
  }

  close(): void {
    this.#director = null;
  }

  get director(): SceneDirector | null {
    return this.#director;
  }

  note(scene: string, step: string, ok: boolean): void {
    this.#steps.push({ scene, step, ok });
  }

  /** Every step the orchestrator drove, so "did it actually drive" is a number. */
  steps(): readonly { scene: string; step: string; ok: boolean }[] {
    return [...this.#steps];
  }
}

const DELEGATION: readonly {
  readonly role: AgentRole;
  readonly what: string;
  readonly run: (d: SceneDirector, note: string, stage: SceneStage) => Promise<StepReport>;
}[] = [
  {
    role: "context-builder",
    what:
      "Have the context for the current scene assembled. It searches the index for what " +
      "the deterministic skeleton did not know to look for, and writes the packet to a " +
      "file whose path comes back in the reply.",
    run: (d, note) => d.buildContext(note),
  },
  {
    role: "writer",
    what:
      "Have the scene drafted, or repaired if the verifier sent it back. It returns prose " +
      "and a state delta; neither is committed yet.",
    run: (d, note, stage) => d.draft(note, stage.words),
  },
  {
    role: "verifier",
    what:
      "Have the draft checked. The deterministic layer runs first at no cost, then the " +
      "cross-family model on what that could not settle. The audit is written to a file " +
      "and the verdict comes back in the reply.",
    run: (d, note) => d.verify(note),
  },
  {
    role: "index-manager",
    what:
      "Fold the approved scene into every partition it touched and commit it. This is the " +
      "commit: prose, state delta and backfilled partitions land in one transaction or " +
      "none of them does. Only legal once the verifier has approved.",
    run: (d, note) => d.commit(note),
  },
];

export function delegationToolNameFor(role: AgentRole): string {
  return `call_${role.replace(/-/g, "_")}`;
}

/**
 * These must never run concurrently with each other.
 *
 * pi executes a batch of tool calls in parallel by default
 * (`toolExecution ?? "parallel"`), and each of these drives a state transition
 * on the same director. Two issued in one assistant message would interleave
 * two transitions on one transaction — and the plausible batch is exactly the
 * damaging one: an orchestrator that emits `call_writer` and `call_verifier`
 * together would have the verifier reading a draft while the writer is still
 * producing it, through a capture buffer they share.
 *
 * The refusals do not save us here. They are checks on the state at the moment
 * of the call, and two calls that begin simultaneously both see the state
 * before either.
 */
const SEQUENTIAL = "sequential" as const;

/**
 * The orchestrator's tool surface for the scene in progress.
 *
 * A call in the wrong state is refused with the state it is in and the call
 * that is legal instead. That phrasing matters more than it looks: an agent
 * told only "no" retries the same call, and each retry is a whole turn.
 */
export function orchestratorTools(stage: SceneStage): unknown[] {
  const tools: unknown[] = DELEGATION.map((entry) => ({
    label: `Call ${entry.role}`,
    name: delegationToolNameFor(entry.role),
    executionMode: SEQUENTIAL,
    description:
      `${entry.what} It keeps its own session across scenes, so refer to earlier work ` +
      `rather than restating it. \`brief\` is added to its standing instructions — use it ` +
      `for what is particular about this scene, not to repeat what it already knows.`,
    parameters: Type.Object({
      brief: Type.String({
        description: "What is particular about this scene, in your own words",
      }),
    }),
    execute: async (_id: string, args: { brief?: string }) => {
      const director = stage.director;
      if (!director) {
        return toolText(
          "refused: no scene is open. This tool is only callable while you are running a " +
            "scene.",
        );
      }
      const result = await entry.run(director, args.brief?.trim() ?? "", stage);
      stage.note(director.sceneId, entry.role, result.ok);
      return toolText(
        `${result.text}\n\nScene state: ${director.state}. Next: ${director.nextStep()}.`,
      );
    },
  }));

  tools.push({
    label: "Abandon scene",
    name: "abandon_scene",
    executionMode: SEQUENTIAL,
    description:
      "Give up on the scene in progress and move on. Use when a defect needs a decision " +
      "nobody in the loop can make, or when repairing it is costing more than the scene is " +
      "worth. An abandoned scene is recorded as a failure with your reason, which is a " +
      "result; three more silent rewrites are not.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why this scene cannot be finished" }),
    }),
    execute: async (_id: string, args: { reason?: string }) => {
      const director = stage.director;
      if (!director) return toolText("refused: no scene is open.");
      if (!args.reason?.trim()) {
        return toolText(
          "rejected: a reason is required. An abandoned scene with no reason is a hole in " +
            "the manuscript that nothing can explain later.",
        );
      }
      const result = director.abandon(args.reason);
      stage.note(director.sceneId, "abandon", result.ok);
      return toolText(result.text);
    },
  });

  return tools;
}

/**
 * The story as it stands, for the one actor that can act on it.
 *
 * Four things, chosen because each one enables a decision the orchestrator is
 * supposed to make and currently cannot:
 *
 *  - **How the last scene ended**, verbatim. This is what the next scene has to
 *    follow from, and it is the material for the brief — "pick up on the door she
 *    left open" is a sentence only available to someone who has read the door.
 *  - **What the story owes the reader.** Open promises with their due scene. An
 *    unpaid promise is invisible at the end precisely because nothing refers to
 *    it, so the moment to spend one is while it is still listed.
 *  - **Whether the last scene hit its length.** Half the score on this kind of
 *    task is length compliance, and the per-scene gap is the actionable version of
 *    the whole-task total already in this brief.
 *  - **Where the plan goes next.** `update_plan` has never been called in any run.
 *    A revisable plan whose upcoming scenes the reviser has not seen is not
 *    revisable in practice.
 */
function renderStoryState(
  state: Parameters<typeof sceneBrief>[0]["state"],
  position: { readonly index: number; readonly total: number },
): string {
  const lines: string[] = ["## The story as it stands", ""];

  if (state.lastScene) {
    const gap = state.lastScene.words - state.lastScene.target;
    lines.push(
      `Last committed: ${state.lastScene.id}, ${state.lastScene.words} words against a target ` +
        `of ${state.lastScene.target} (${gap >= 0 ? "+" : ""}${gap}).`,
    );
  } else {
    lines.push("Nothing committed yet — this is the first scene.");
  }

  if (state.lastSceneClose) {
    lines.push(
      "",
      `How ${state.lastScene?.id ?? "it"} ended:`,
      `> ${state.lastSceneClose.replace(/\s+/g, " ").trim()}`,
      "",
      "That is what this scene follows from. A scene that opens as though the previous one had",
      "not happened is the most common way a sequence of scenes fails to be a story.",
    );
  }

  lines.push("");
  if (state.openPromises.length === 0) {
    lines.push("Open promises: none recorded.");
  } else {
    lines.push(`Open promises (${state.openPromises.length}) — what the reader is still owed:`);
    for (const p of state.openPromises) {
      const due = p.dueByScene ? `due by ${p.dueByScene}` : "no stated deadline";
      lines.push(`  - ${p.id}: ${p.promise} (${due})`);
    }
    lines.push(
      "A promise falling due in this scene or the next is worth saying so in the writer's",
      "brief — it cannot see this ledger. One that is overdue is a defect no later scene",
      "fixes more cheaply than this one does.",
    );
  }

  if (state.upcoming.length > 0) {
    lines.push("", "Planned after this one:");
    for (const s of state.upcoming) lines.push(`  - ${s.id}: ${s.intent}`);
  } else {
    lines.push("", "Nothing is planned after this one: this is the last scene.");
  }

  if (state.tierBoundary && position.index > 1) {
    lines.push(
      "",
      "**This scene begins a new allowance tier, so review the plan before you start it.**",
      "Not as a formality — `update_plan` has never been called in any run of this system, and",
      "a plan that is never revised is a plan written before any of the prose existed and then",
      "defended. Read the committed scenes and answer one question out loud: do the scenes",
      "listed above still earn their place, given what the prose actually became? If yes, say",
      "so and carry on — that is a real answer. If a thread needs more room, or a planned",
      "scene has become redundant, or the ending needs a scene to set it up, revise now. After",
      "this scene commits, the scenes behind it are fixed.",
    );
  }

  return lines.join("\n");
}

/** The brief for one scene, addressed to the orchestrator. */
/**
 * Where the book lands if the remaining scenes deliver what the finished ones did.
 *
 * The raw numbers were already in the brief and were not enough, because the
 * decision needs an arithmetic the orchestrator was left to do: a scene *target*
 * is what the writer was asked for, and what it delivers is a different number.
 * Measured on the chapter-length arm, where scenes are asked for 2,400–3,600
 * words: delivery settles around **2,050 per scene regardless of the ask**, so a
 * six-scene plan for a 20,000-word book finishes at 12,300 — attainment 0.61 —
 * and every individual scene looks fine on its way there. Nothing in the run
 * could notice, because the only actor able to add scenes was never told it was
 * heading for a shortfall.
 *
 * Adding scenes is a real lever and already works: `update_plan` replaces the
 * scenes ahead, may return more of them than it was given, and the scene loop
 * re-reads the plan's length every iteration, so an eighth scene appended at
 * scene four does get written.
 *
 * Silent until there are two committed scenes to average, because one scene is
 * not a rate. Silent when the projection is within 10% of target, since a plan
 * that will land is not a problem and this block would then be noise on every
 * scene of every run.
 */
export function renderLengthProjection(input: {
  readonly words: { readonly committed: number; readonly target: number };
  readonly position: { readonly index: number; readonly total: number };
  readonly committed: readonly string[];
}): string {
  const done = input.committed.length;
  if (done < 2) return "";
  const perScene = input.words.committed / done;
  const remaining = input.position.total - input.position.index + 1;
  const projected = Math.round(input.words.committed + remaining * perScene);
  if (projected >= input.words.target * 0.9) return "";

  const extra = Math.ceil((input.words.target * 0.95 - projected) / perScene);
  return [
    "",
    `Projection: the ${done} committed scene(s) average ${Math.round(perScene)} words each. At ` +
      `that rate the remaining ${remaining} will finish the book at about ${projected} words ` +
      `against a target of ${input.words.target} — a shortfall of ` +
      `${input.words.target - projected}.`,
    `Two levers, and the second is yours alone. Ask the writer for more in its brief, which ` +
      `works only as far as it actually delivers more — across this arm it has settled near ` +
      `${Math.round(perScene)} words a scene whatever target it was given. Or call ` +
      `update_plan and add about ${extra} more scene(s), which is the lever that does not ` +
      `depend on the writer changing its behaviour. Scenes already committed are untouchable; ` +
      `you are proposing the ones ahead, and you may return more of them than there are now.`,
    `Added scenes have to earn their place in the story — a book padded to length reads worse ` +
      `than a short one, and the quality dimensions are scored too. Split what the plan is ` +
      `already compressing rather than appending filler at the end.`,
  ].join("\n");
}

export function sceneBrief(input: {
  readonly sceneId: string;
  readonly intent: string;
  readonly presentEntities: readonly string[];
  readonly targetWords: number;
  readonly chapter: string;
  readonly position: { readonly index: number; readonly total: number };
  readonly committed: readonly string[];
  readonly failed: readonly string[];
  /**
   * What this scene may spend, and why this scene rather than another.
   *
   * Replaces the flat `repairBudget` number. The orchestrator is the one actor
   * that can decide *when* to spend a round, so it is the one that needs the
   * reason and not just the ceiling — and the ceiling now differs per scene, so a
   * brief that stated a run-wide number would be wrong on most scenes.
   */
  readonly allocation: SceneAllocation;
  /**
   * Words on the page so far, against the whole task's target.
   *
   * The system was flying blind on the one number half its benchmark score is
   * made of: nothing counted the manuscript as it grew, so nothing could notice
   * it running short until the run was over. A scene target is a plan; this is
   * the outcome, and only the orchestrator is in a position to act on the gap.
   */
  readonly words: { readonly committed: number; readonly target: number };
  /**
   * The state of the story so far, put in front of the orchestrator rather than
   * left for it to fetch.
   *
   * The brief has told it to look since the tools existed — *"Before you start,
   * look. You have `bash` and `read` over the whole project"*. Measured on
   * `runs/v062/lbw081`: in a whole four-scene run it made **one** `read` call,
   * **zero** `update_plan` calls and **zero** `abandon_scene` calls. Its
   * twenty-two tool calls were nineteen delegations and two plan submissions. So
   * the revisable plan, the judgement about whether the outline still fits the
   * prose, and the decision to cut a scene — three things the design claims — had
   * no realisations at all, and the orchestrator was a sequencer with a prompt
   * describing a director.
   *
   * The verifier had the identical failure and the fix that worked was not more
   * insistent wording, it was assembling the evidence. An agent asked to judge
   * without material judges nothing; an agent handed the last scene's closing
   * lines, what the story still owes the reader, and where the plan goes next has
   * something to be wrong about.
   */
  readonly state: {
    /** How the previous scene ended, verbatim. Continuity begins here. */
    readonly lastSceneClose: string | null;
    readonly lastScene: { readonly id: string; readonly words: number; readonly target: number } | null;
    /** Promises made and not yet paid off, with the scene they are due by. */
    readonly openPromises: readonly {
      readonly id: string;
      readonly promise: string;
      readonly dueByScene: string | null;
    }[];
    /** The intents of the scenes after this one, so "the plan is stale" is checkable. */
    readonly upcoming: readonly { readonly id: string; readonly intent: string }[];
    /** True when this scene is the first in its allocation tier. */
    readonly tierBoundary: boolean;
  };
}): string {
  return [
    `Run scene ${input.sceneId} — number ${input.position.index} of ${input.position.total}, ` +
      `in ${input.chapter}.`,
    "",
    `Intent: ${input.intent}`,
    `Present: ${input.presentEntities.join(", ") || "none stated"}`,
    `Target length: about ${input.targetWords} words.`,
    input.committed.length > 0
      ? `Committed so far: ${input.committed.join(", ")}.`
      : "Nothing has been committed yet; this is the first scene.",
    input.failed.length > 0 ? `Did not complete: ${input.failed.join(", ")}.` : "",
    "",
    `Length so far: ${input.words.committed} words committed of ${input.words.target} for the ` +
      `whole task; ${Math.max(0, input.words.target - input.words.committed)} still to write ` +
      `across ${input.position.total - input.position.index + 1} remaining scene(s). Half of ` +
      `the score on this kind of task is length compliance, so if the committed scenes are ` +
      `running short of their targets, say so in the writer's brief — it cannot see this ` +
      `number and will otherwise keep writing to the same length.`,
    renderLengthProjection(input),
    "",
    "The sequence is fixed and enforced: call_context_builder, then call_writer, then",
    "call_verifier, then call_index_manager once it is approved. A call out of order comes",
    "back as a refusal naming the legal next step. Repairs loop between call_writer and",
    "call_verifier.",
    "",
    renderAllocation(input.allocation),
    "",
    renderStoryState(input.state, input.position),
    "",
    "That block is assembled for you so that judging the plan does not depend on your",
    "going to look for it. You still have `bash` and `read` over the whole project — the",
    "committed scenes under novel/chapters/, the outline, the promise ledger, the rhythm",
    "file — and the block is a starting point rather than the limit. If the prose has",
    "outgrown the plan for the scenes ahead, `update_plan` now: you cannot touch scenes",
    "already written, and after this one is committed it joins them.",
    "",
    "Each call takes a `brief`: what is particular about this scene. The specialists keep",
    "their own sessions and already know their jobs, so a brief that restates their role",
    "wastes a turn. Say what this scene needs that the last one did not.",
    "",
    /**
     * The last scene has to end the story, and saying so is not redundant.
     *
     * Measured on `lbw081`: the plan's final scene was "Reveal: confrontation", the
     * writer produced a confrontation that named nobody and closed on *"Not yet.
     * There is enough for a warrant"*, and the promise ledger recorded the central
     * contradiction as **paid off** by that scene. Everything downstream agreed the
     * story was finished: promises 3 declared / 0 unpaid, revision tasks 0. The
     * frozen judge did not — Accuracy 2 on a locked-room mystery whose room is never
     * explained.
     *
     * Nothing in the loop was positioned to catch it. The verifier checks a scene
     * against the index, and an unresolved ending contradicts nothing. The promise
     * ledger counts payoffs and cannot weigh them. The scene card said "reveal" and
     * a reveal was, in form, delivered.
     */
    input.position.index === input.position.total
      ? [
          "",
          "**This is the last scene, so it has to end the story.** Not gesture at an ending —",
          "end it. If the premise poses a question, this scene answers it: who, how, and how the",
          "impossibility was possible. A detective story that closes on \"there is enough for a",
          "warrant\" has not finished; it has stopped.",
          "",
          "Two specific ways this has gone wrong here. The writer wrote a confrontation in which",
          "nobody was named and every contradiction the story had carefully listed was left",
          "standing — and then declared the promise paid off, so the ledger, the revision pass",
          "and the finding count all agreed the book was complete. Say in the brief that the",
          "answer must be *on the page*, in the prose, not implied by the arrangement of clues.",
          "",
          "And check it yourself before you commit. You can read the draft; read the last few",
          "paragraphs and ask whether a reader who stopped there would know what happened. If",
          "they would not, send it back — this is what your repair rounds are for, and it is the",
          "one defect no later scene can fix.",
        ].join("\n")
      : "",
    "",
    "Finish when the scene is committed or you have abandoned it. Then say in two or three",
    "sentences what happened: how many attempts, what the verifier objected to, where the",
    "artefacts are.",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface SceneRun {
  readonly outcome: SceneOutcome;
  /** Steps the orchestrator drove itself. */
  readonly orchestratorSteps: number;
  /** Steps the engine had to run after the orchestrator stopped. */
  readonly rescuedSteps: number;
  /** The orchestrator's own account of the scene. */
  readonly account: string;
}

/**
 * Run one scene with the orchestrator driving, and finish anything it leaves.
 *
 * The rescue is not a courtesy to the model. Losing an approved scene because
 * nobody called the commit would corrupt the only number that matters — how
 * much of a story this system can finish — with a failure that has nothing to
 * do with writing.
 */
export async function driveScene(options: {
  readonly residents: ResidentAgents;
  readonly stage: SceneStage;
  readonly director: SceneDirector;
  readonly brief: string;
  readonly txid: string;
  /** Words on the page against the task target, forwarded to the writer. */
  readonly words?: { committed: number; target: number };
  /** Nudges after the orchestrator stops short of a terminal state. */
  readonly maxNudges?: number;
  readonly log?: (line: string) => void;
}): Promise<SceneRun> {
  const { residents, stage, director, txid } = options;
  const say = options.log ?? (() => {});
  const maxNudges = options.maxNudges ?? 1;

  stage.open(director, options.words);
  const before = stage.steps().length;
  let account = "";

  try {
    const first = await residents.invoke("orchestrator", options.brief, {
      txid,
      caller: "orchestrator",
      selfCall: true,
    });
    account = first.text;

    for (let nudge = 0; nudge < maxNudges && !director.isTerminal(); nudge += 1) {
      const next = await residents.invoke(
        "orchestrator",
        `Scene ${director.sceneId} is not finished: it is in ${director.state} and the legal ` +
          `next call is ${director.nextStep()}. Make that call, and keep going until the ` +
          `scene is committed or you abandon it with a reason.`,
        { txid, caller: "orchestrator", selfCall: true },
      );
      account = `${account}\n${next.text}`.trim();
    }
  } catch (error) {
    // Except when there is nothing left to spend. Rescuing a scene with an
    // exhausted budget buys a second failure at full price.
    if (error instanceof BudgetExhausted) {
      stage.close();
      throw error;
    }
    // An orchestrator turn that failed is not a scene that must fail. The
    // rescue below still runs, so a timeout on the driving turn costs the
    // scene's autonomy rather than the scene.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    say(`${director.sceneId} orchestrator turn failed — ${message}`);
    account = `${account}\n[orchestrator turn failed: ${message}]`.trim();
  }

  const orchestratorSteps = stage.steps().length - before;

  // Whatever is left, the engine walks — the same steps, in the same order,
  // with the same refusals.
  let rescuedSteps = 0;
  while (!director.isTerminal()) {
    const state = director.state;
    if (state === "OPEN" || state === "STALE_BASE") {
      if (!(await director.buildContext()).ok) break;
    } else if (state === "CONTEXT_BUILT" || state === "REPAIR_REQUIRED") {
      // A failed writer turn deliberately leaves the state unchanged so the
      // attempt can be retried, which means the "state did not move" guard below
      // would read it as a stuck loop. The director's own failure count bounds
      // this, and it ends the scene by going terminal.
      if (!(await director.draft()).ok) {
        if (director.isTerminal()) break;
        rescuedSteps += 1;
        continue;
      }
    } else if (state === "DRAFTED" || state === "STATE_DELTA_PROPOSED") {
      if (!(await director.verify()).ok) break;
    } else if (state === "APPROVED") {
      if (!(await director.commit()).ok) break;
    } else {
      break;
    }
    rescuedSteps += 1;
    // A step that leaves the state untouched would spin here. It cannot happen
    // through the director's own transitions, and the loop is cheap to make
    // safe against a future one that could.
    if (director.state === state) break;
  }

  if (rescuedSteps > 0) {
    say(
      `${director.sceneId} the engine finished ${rescuedSteps} step(s) the orchestrator ` +
        `left undone`,
    );
  }

  stage.close();
  return { outcome: director.outcome(), orchestratorSteps, rescuedSteps, account };
}
