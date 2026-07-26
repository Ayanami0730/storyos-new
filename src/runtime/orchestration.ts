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

  open(director: SceneDirector): void {
    this.#director = director;
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
  readonly run: (d: SceneDirector, note: string) => Promise<StepReport>;
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
    run: (d, note) => d.draft(note),
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
      const result = await entry.run(director, args.brief?.trim() ?? "");
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

/** The brief for one scene, addressed to the orchestrator. */
export function sceneBrief(input: {
  readonly sceneId: string;
  readonly intent: string;
  readonly presentEntities: readonly string[];
  readonly targetWords: number;
  readonly chapter: string;
  readonly position: { readonly index: number; readonly total: number };
  readonly committed: readonly string[];
  readonly failed: readonly string[];
  readonly repairBudget: number;
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
    "The sequence is fixed and enforced: call_context_builder, then call_writer, then",
    "call_verifier, then call_index_manager once it is approved. A call out of order comes",
    "back as a refusal naming the legal next step. Repairs loop between call_writer and",
    `call_verifier; you have ${input.repairBudget} repair round(s) for this scene.`,
    "",
    "Before you start, look. You have `bash` and `read` over the whole project: the",
    "committed scenes under novel/chapters/, the outline in novel/outline/, the promise",
    "ledger, the rhythm file. If the prose has outgrown the plan for the scenes ahead,",
    "`update_plan` now — you cannot touch scenes already written, and after this one is",
    "committed it joins them.",
    "",
    "Each call takes a `brief`: what is particular about this scene. The specialists keep",
    "their own sessions and already know their jobs, so a brief that restates their role",
    "wastes a turn. Say what this scene needs that the last one did not.",
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
  /** Nudges after the orchestrator stops short of a terminal state. */
  readonly maxNudges?: number;
  readonly log?: (line: string) => void;
}): Promise<SceneRun> {
  const { residents, stage, director, txid } = options;
  const say = options.log ?? (() => {});
  const maxNudges = options.maxNudges ?? 1;

  stage.open(director);
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
      if (!(await director.draft()).ok) break;
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
