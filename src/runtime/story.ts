/**
 * From a plan to a finished manuscript.
 *
 * `plan.ts` decides which scenes there are. This is the layer that runs them:
 * it feeds each one the context the index has accumulated so far, lets the
 * orchestrator drive the transaction, and assembles what comes back.
 *
 * The part that carries the paper's claim is `contextFor`. Every scene is
 * written against material *derived from committed state*, not against a
 * growing transcript — that is the difference between this and a harness that
 * hands the next call a summary of the last one. Whether it is worth its cost
 * is exactly what the experiments measure, so the code has to make it true
 * rather than approximately true.
 */

import type { ContextItem } from "../context/types.ts";

import type { CanonicalIndex } from "../index/commit.ts";
import { chapterFor, paths, sceneIndexOf } from "../index/tree.ts";
import type { AgentRole } from "../transaction/types.ts";
import type { CanonFact } from "../verification/deterministic.ts";
import type { ResidentAgents } from "../agents/residents.ts";
import { type AllocationState, type SceneAllocation, allocate } from "./allocation.ts";
import { type ArtifactStore, artifactPaths } from "./artifacts.ts";
import { BudgetExhausted } from "./budget.ts";
import { type SceneToolBus, residentCollaborators } from "./collaborators.ts";
import { type SceneStage, driveScene, sceneBrief } from "./orchestration.ts";
import { type RevisionPlan, planRevisions } from "./revision.ts";
import type { SceneDelta } from "../verification/deterministic.ts";
import {
  type OrthographyConvention,
  conventionOf,
  renderConvention,
  requestScriptOf,
} from "../verification/orthography.ts";
import {
  type SceneCard,
  type StoryPlan,
  planFiles,
  planStory,
} from "./plan.ts";
import {
  BACKFILL_FAILURE_PREFIX,
  DETERMINISTIC_LAYER_FAILED,
  SceneDirector,
} from "./scene-director.ts";
import type { SceneCollaborators, SceneOutcome } from "./scene-loop.ts";
import { countWords } from "./words.ts";

export type { SceneCard, StoryPlan };

export interface StoryResult {
  readonly manuscript: string;
  readonly words: number;
  readonly plan: StoryPlan;
  readonly scenes: readonly { readonly card: SceneCard; readonly outcome: SceneOutcome }[];
  readonly canon: readonly CanonFact[];
  /** Scenes that never committed, with why. Reported, never hidden. */
  readonly failures: readonly { readonly sceneId: string; readonly reason: string }[];
  /** What the whole-story pass found, and what was done about it. */
  readonly revision: RevisionPlan;
  /**
   * How much of the driving the orchestrator actually did.
   *
   * The point of making it drive is that it can decide — revise the outline
   * before a scene, abandon one that is not worth repairing. Whether it does is
   * not something to assume from the fact that it has the tools: the first run
   * where all five agents were live had the orchestrator send eight messages in
   * total and delegate nothing. So the split is recorded per run.
   */
  readonly driving: {
    readonly scenesDriven: number;
    readonly stepsByOrchestrator: number;
    readonly stepsRescuedByEngine: number;
  };
  /**
   * What each scene was allowed to spend, in scene order.
   *
   * Recorded because the schedule rests on an inference rather than a direct
   * measurement: `experiments/degradation` shows errors accumulating with the
   * *length* of a finished text, and this design assumes that also means a later
   * scene of one story is riskier than an earlier one. Putting each scene's
   * allowance beside its findings and attempts is what makes that assumption
   * checkable from run data — including checkable as false, in which case the
   * endgame tiers are buying nothing and should shrink.
   */
  readonly allocations: readonly {
    readonly sceneId: string;
    readonly allocation: SceneAllocation;
  }[];
  /**
   * Scenes whose index backfill failed, out of those that committed.
   *
   * Reported because the absence of this number is what let a total failure of
   * the index-manager ship for four versions. A failed backfill is a per-scene
   * warning and the scene commits anyway — the right trade for a transient
   * failure, and the reason a permanent one was invisible: 26 runs across
   * 0.9.1–0.9.4 delivered manuscripts whose index held identities and nothing
   * else, every one of them reporting `done`.
   */
  readonly backfillFailures: number;
  /**
   * Scenes whose deterministic checks threw instead of running.
   *
   * The same argument one field up, one layer in. A checker crash used to be
   * unrepresented anywhere, so the run it destroyed reported the same shape as a
   * healthy one — `0 finding(s)` on every scene, which reads as clean prose.
   */
  readonly deterministicFailures: number;
}

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

/**
 * Ask the orchestrator for a plan.
 *
 * Scene count is derived from the target rather than left to the model: a model
 * asked for "a plan for 40,000 words" reliably proposes a dozen scenes and then
 * has to write 3,000 words each, which is where single-call length limits bite.
 */
export function contextFor(input: {
  readonly card: SceneCard;
  readonly plan: StoryPlan;
  readonly canon: readonly CanonFact[];
  /**
   * The most recent committed scenes, newest last, as many as this scene's
   * allocation asks for.
   *
   * It used to be exactly one — `previousProse` — for every scene of every story.
   * One is right for scene 2, where there is nothing else, and wrong for a scene
   * that has to land an ending: the beat list carries intent rather than the
   * detail a contradiction actually lives in, so a defect against two scenes ago
   * was invisible to everything except the verifier's own grepping.
   */
  readonly recentProse: readonly { readonly sceneId: string; readonly text: string }[];
  readonly earlierIntents: readonly string[];
  /**
   * What the user actually asked for, verbatim.
   *
   * The writer has never seen it. The orchestrator reads it once at planning time
   * and everything downstream gets the plan's paraphrase, which is lossy in one
   * specific way: `submit_plan` can state entities, scenes, narrative person and
   * tense, and it has no field at all for the *form* of the thing being written.
   * So a request whose form the schema cannot express is silently converted into
   * the form it can.
   *
   * Measured on `lbw112`, "请写一份有五个人搞笑的青春校园剧本，明确各角色所说话语，共
   * 五幕": the strings `五幕` and `各角色所说话语` appear **twice and once in the
   * orchestrator's transcript and zero times in the writer's**, and the frozen
   * judge scored Relevance 2 against agentwrite's 4 with the words
   * "没有明确标注五幕，整体更像连续小说片段而非规范剧本". Five of twenty-one tasks
   * ask for a form the plan cannot state, and their S_q deficit is -0.97 against
   * -0.44 for the eleven with no known mechanical defect.
   *
   * Deliberately the whole prompt rather than an extracted "requirements" field.
   * Extraction is a judgement, it would be made by the same layer that already
   * drops the form, and the prompt is a few hundred tokens against a 60,000-word
   * budget.
   */
  readonly request?: string;
}): readonly ContextItem[] {
  const { card, plan, canon, recentProse, earlierIntents } = input;
  const items: ContextItem[] = [
    ...(input.request?.trim()
      ? [
          {
            id: "task-request",
            priority: "P0" as const,
            source: paths.premise(),
            content:
              `The request this book must satisfy, as it was written. The plan below is ` +
              `an interpretation of it; where the two differ, this is what is being ` +
              `graded — including any form it asks for (a script, acts, diary entries, ` +
              `an essay in parts) and any element it names.\n\n${input.request.trim()}`,
          },
        ]
      : []),
    {
      id: "scene-card",
      priority: "P0",
      // Real paths in the tree. The first version cited `index/story/bible/...`,
      // which no longer exists, and the cost was not cosmetic: the verifier read
      // the citation, grepped it, found nothing, and spent nine further reads
      // working out the layout by hand before it could check anything.
      source: paths.chapterCard(chapterFor(sceneIndexOf(card.id))),
      content:
        `Scene ${card.id}. Intent: ${card.intent}\n` +
        `Present: ${card.presentEntities.join(", ") || "none stated"}\n` +
        `Target length: about ${card.targetWords} words.`,
    },
    {
      id: "logline",
      priority: "P0",
      source: paths.logline(),
      content: plan.logline,
    },
    {
      // The cast list, at P0, because omitting it produced a whole class of
      // failure. The scene card's intent named Elias and the Watchhouse while
      // `present` omitted them, so the writer was told to feature two entities
      // it had been given nothing about — and then the verifier, seeing them in
      // the delta but not in the packet, ruled they did not exist and rejected
      // the scene three times. Eleven ids and a line each is a rounding error
      // against that.
      id: "entity-roster",
      priority: "P0",
      source: "characters/, locations/, objects/",
      content:
        `Every entity that exists in this story. Only these ids may be used; if you need ` +
        `someone or something that is not here, say so rather than inventing an id.\n` +
        plan.entities.map((e) => `- ${e.id}: ${e.sketch}`).join("\n"),
    },
  ];

  /**
   * The narrative person and tense, as a hard constraint in every packet.
   *
   * P0 rather than P4, and stated as a rule rather than as a note, because the
   * measurement says it behaves like one. In the first 20,000-word manuscript this
   * harness produced, LiveNovelBench's audit found nine consistency errors and
   * **seven were `perspective_confusions`** — the narration alternating between a
   * collective first person and close third on the protagonist, scene by scene.
   * Nothing had decided: `voice.md` was a placeholder and the plan had no field, so
   * seventeen writers each chose.
   *
   * A voice is the one constraint that cannot be inferred from the previous scene
   * either, which is what makes the recall tail no substitute: a scene that reads
   * one scene back sees a choice, not a decision, and half the time sees the wrong
   * one.
   */
  items.push({
    id: "narrative-voice",
    priority: "P0",
    source: paths.voice(),
    content:
      `Narration: ${plan.voice.person}, ${plan.voice.tense} tense. This was decided for the ` +
      `whole book before any of it was written and does not change.\n` +
      `Check your own sentences against it before you stage them. Mixing a collective "we" ` +
      `into a third-person narration, or slipping into present tense for a scene that feels ` +
      `immediate, is scored as a defect and is the most common one this system has produced: ` +
      `seven of nine consistency errors in a measured 18,000-word manuscript were exactly ` +
      `this.\n` +
      `If you think the story genuinely needs a different voice, propose the deviation — do ` +
      `not simply write it.`,
  });

  if (plan.worldRules.length > 0) {
    // The framing is the load-bearing part, not the list.
    //
    // Handed over as a bare block of P0 constraints, world rules get written
    // into the viewpoint character's head — three consecutive runs had scene 1
    // rejected for `knowledge_contradictions` because the writer gave Mira, on
    // page one, the full account of the phenomenon the whole story is about her
    // discovering. The verifier was right each time and the writer could not
    // repair it, because nothing in the packet distinguished "true of the
    // world" from "known to the people in it".
    items.push({
      id: "world-rules",
      priority: "P0",
      source: paths.worldRules(),
      content:
        `These govern what is TRUE. They do not say what anyone KNOWS.\n` +
        `A character knows a rule only where canon says so; otherwise they may be ` +
        `ignorant of it, wrong about it, or in the middle of working it out — and if ` +
        `the story is about someone discovering one of these, writing it into their ` +
        `thoughts early is how that story gets destroyed.\n\n` +
        plan.worldRules.map((r) => `- ${r}`).join("\n"),
    });
  }

  // P1 — who is here and what is currently true of them. Facts are grouped per
  // entity because that is how a writer needs them, and only present entities
  // are included: a packet that lists everyone is a packet the writer skims.
  for (const entityId of card.presentEntities) {
    const sketch = plan.entities.find((e) => e.id === entityId)?.sketch ?? "";
    const facts = canon.filter((f) => f.entity === entityId);
    items.push({
      id: `entity-${entityId}`,
      priority: "P1",
      source: entityId.startsWith("char-")
        ? paths.profile(entityId)
        : entityId.startsWith("loc-")
          ? paths.location(entityId)
          : paths.object(entityId),
      content:
        `${entityId}: ${sketch}\n` +
        (facts.length > 0
          ? facts.map((f) => `  ${f.attribute}: ${f.value}  (from ${f.source})`).join("\n")
          : "  no facts established yet — including nothing about what they know"),
    });
  }

  // Newest first, so that if the packet's word budget binds it is the oldest
  // recall that is dropped rather than the scene immediately before this one.
  for (const [offset, scene] of [...recentProse].reverse().entries()) {
    items.push({
      id: offset === 0 ? "previous-scene" : `recent-scene-${scene.sceneId}`,
      priority: "P2",
      source: paths.scene(chapterFor(sceneIndexOf(scene.sceneId)), scene.sceneId),
      content:
        offset === 0
          ? scene.text
          : `${scene.sceneId}, ${offset + 1} scene(s) before this one:\n\n${scene.text}`,
    });
  }

  if (earlierIntents.length > 0) {
    // Navigation only. Summaries may point at the story; they may not be cited
    // as fact — anything load-bearing is in the P1 facts with its source.
    items.push({
      id: "story-so-far",
      priority: "P3",
      source: paths.beats(),
      content: earlierIntents.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    });
  }

  return items;
}

/** Facts the committed delta adds to canon, so the next scene sees them. */
/**
 * The tail of a scene, as the next scene's starting point.
 *
 * The closing lines rather than a summary: what the orchestrator needs is the
 * sentence the reader was left on, and a summary of an ending is exactly the thing
 * that cannot be followed from. Bounded at roughly a paragraph because it goes into
 * every scene brief, and a brief that carries the whole previous scene is the
 * resident-verifier cost mistake in a different place.
 */
export function closingLines(text: string | null, words = 60): string | null {
  if (!text?.trim()) return null;
  const tokens = text.trim().split(/\s+/);
  return tokens.slice(-words).join(" ");
}

/**
 * Promises declared and not yet paid off.
 *
 * Computed from the deltas the loop already holds rather than read from
 * `continuity/plot-contracts.jsonl`, because the actor this is for has never read
 * that file: one `read` call in a whole run. A ledger nobody opens does not inform
 * a decision, whatever it contains.
 */
export function openPromisesFrom(
  deltas: readonly SceneDelta[],
): readonly { id: string; promise: string; dueByScene: string | null }[] {
  const paid = new Set(deltas.flatMap((d) => (d.paysOff ?? []).map((p) => p.contractId)));
  const open = new Map<string, { id: string; promise: string; dueByScene: string | null }>();
  for (const delta of deltas) {
    for (const p of delta.promises ?? []) {
      if (paid.has(p.id)) continue;
      open.set(p.id, { id: p.id, promise: p.promise, dueByScene: p.dueByScene });
    }
  }
  return [...open.values()];
}

export function absorb(
  canon: readonly CanonFact[],
  sceneId: string,
  delta: { readonly claims: readonly { entity: string; attribute: string; value: string }[] },
): readonly CanonFact[] {
  const next = [...canon];
  for (const claim of delta.claims) {
    const at = next.findIndex(
      (f) => f.entity === claim.entity && f.attribute === claim.attribute,
    );
    const fact: CanonFact = {
      id: `fact-${claim.entity}-${claim.attribute}`,
      entity: claim.entity,
      attribute: claim.attribute,
      value: claim.value,
      source: sceneId,
    };
    // A superseding claim replaces in place; a new one appends. Either way the
    // source moves to the scene that established the current value, so a later
    // contradiction points at the right place.
    if (at >= 0) next[at] = fact;
    else next.push(fact);
  }
  return next;
}

export async function writeStory(options: {
  readonly residents: ResidentAgents;
  readonly index: CanonicalIndex;
  readonly premise: string;
  readonly targetWords: number;
  /** See `AssemblyOptions.wordsPerScene`; the chapter-length experiment. */
  readonly wordsPerScene?: number;
  /**
   * Pin every scene to one repair round instead of allocating by position.
   *
   * The uniform-allocation arm, which exists so that "does allocating by position
   * beat allocating evenly" can be answered by two runs of the same code rather
   * than by comparing against a previous version of the harness. Null means the
   * schedule decides.
   */
  readonly pinnedRepairs: number | null;
  /** The holder the writer's own tools read this scene's allowance from. */
  readonly allocationState: AllocationState;
  /**
   * Roles that begin each scene with an empty conversation.
   *
   * Default is the verifier alone, for the caching reason in
   * `ResidentAgents.resetSession`. Pass an empty array to get the fully resident
   * behaviour of 0.5.1 and earlier.
   */
  readonly freshEachScene?: readonly AgentRole[];
  readonly planSink: { plan?: StoryPlan };
  /**
   * Shared with whoever constructed the agents. It must be the same bus: the
   * agents' tools were registered against it once, and a second bus here would
   * mean the writer files its prose into a buffer nobody reads.
   */
  readonly bus: SceneToolBus;
  /**
   * Which director the orchestrator's `call_*` tools point at. Same reason as
   * the bus: registered once, swapped per scene.
   */
  readonly stage: SceneStage;
  /** Working artefacts on disk, so a hand-off is a path rather than a string. */
  readonly artifacts: ArtifactStore;
  readonly onScene?: (sceneId: string) => void;
  /** Resident context-builder, when one is configured. */
  readonly build?: SceneCollaborators["build"];
  /** Resident index-manager's backfill, when one is configured. */
  readonly backfill?: SceneCollaborators["backfill"];
  /** Where prose goes; the tree groups scenes into chapters. */
  readonly prosePathFor?: (sceneId: string) => string;
  /**
   * Progress, because a forty-scene run that prints nothing for an hour is
   * indistinguishable from a hung one, and the difference matters at 3am.
   */
  readonly log?: (line: string) => void;
}): Promise<StoryResult> {
  const { residents, index, premise, targetWords, planSink } = options;

  const say = options.log ?? (() => {});
  say(`planning for ${targetWords} words`);
  const plan = await planStory({
    residents,
    premise,
    targetWords,
    txid: "tx-plan",
    sink: planSink,
    log: say,
    ...(options.wordsPerScene ? { wordsPerScene: options.wordsPerScene } : {}),
  });

  // The initial index, before any scene is built against it.
  const seeded = await index.seed(planFiles(plan, premise));
  say(`initial index seeded: ${seeded.writtenPaths.length} file(s)`);

  const knownEntities = new Set(plan.entities.map((e) => e.id));
  let canon: readonly CanonFact[] = [];
  /** Committed prose in order, so a late scene can be given more than one. */
  const recentProse: { sceneId: string; text: string }[] = [];
  const earlierIntents: string[] = [];
  const scenes: { card: SceneCard; outcome: SceneOutcome }[] = [];
  const failures: { sceneId: string; reason: string }[] = [];
  const prose: string[] = [];
  const committedScenes: string[] = [];
  const committedDeltas: SceneDelta[] = [];
  const proseByScene = new Map<string, string>();
  const driving = { scenesDriven: 0, stepsByOrchestrator: 0, stepsRescuedByEngine: 0 };
  const allocations: { sceneId: string; allocation: SceneAllocation }[] = [];
  /**
   * Committed scenes whose backfill failed, and how many in a row.
   *
   * The run-level count is reported; the consecutive count is what stops the run.
   * A backfill failure is per-scene and non-fatal by design, so a *permanent*
   * cause — a misconfiguration, a permission the role does not have — presents as
   * every scene warning identically while the book is written anyway. Three in a
   * row is the threshold because transient failures are independent and a
   * configuration error is not: it fails 100% of the time from the first scene.
   */
  let backfillFailures = 0;
  let consecutiveBackfillFailures = 0;
  /**
   * Scenes whose deterministic checks crashed rather than ran.
   *
   * Reported next to the findings for the same reason `backfillFailures` is: a run
   * that says "0 blocking findings" because the checker threw looks exactly like a
   * run that says it because the prose was clean, and one of those is a result.
   */
  let deterministicFailures = 0;
  /**
   * The spelling and quotation convention, established by the first scene that
   * shows evidence of one and then fixed.
   *
   * Not reset afterwards: the point is that the whole book agrees, and letting a
   * later scene re-establish it would reproduce the defect the check exists for.
   */
  /**
   * The script comes from the request and is known before any prose exists; the
   * spelling and quote style come from the first committed scene, because the
   * request says nothing about British against American. So the convention is
   * built in two stages and the language half is enforced from scene one — which
   * is the scene that would otherwise establish whatever it happened to choose.
   */
  const requestScript = requestScriptOf(premise);
  let convention: OrthographyConvention | null = requestScript
    ? { spelling: "american", quotes: "double", script: requestScript }
    : null;
  /** True once a committed scene has settled the spelling, not just the script. */
  let spellingSettled = false;
  /** Words actually on the page, recounted from committed prose after each scene. */
  let committedWords = 0;
  /** The previous scene's delivered length against what it was asked for. */
  let lastCommitted: { id: string; words: number; target: number } | null = null;
  /**
   * Craft warnings from the scene just committed, for the next scene's writer.
   *
   * Only from the immediately previous scene, not accumulated. A list that grew for
   * seventeen scenes would be a standing indictment rather than a note, and the
   * writer would either ignore it or write to avoid all of it — and writing
   * defensively is a quality problem of its own.
   */
  let craftNotes: readonly {
    scene: string;
    check: string;
    why: string;
    suggestion: string;
  }[] = [];

  say(
    `plan: ${plan.scenes.length} scenes, ${plan.entities.length} entities, ` +
      `${plan.worldRules.length} world rules`,
  );

  // The plan is re-read each iteration rather than iterated over: `update_plan`
  // may rewrite the scenes ahead between scenes, and a `for...of` over the
  // original array would keep writing the outline the orchestrator has already
  // decided was wrong.
  for (let i = 0; i < (planSink.plan ?? plan).scenes.length; i += 1) {
    const card = (planSink.plan ?? plan).scenes[i]!;
    const txid = `tx-${card.id}`;
    const sceneStarted = Date.now();

    /**
     * What this scene may spend, from where it sits in the story.
     *
     * Computed against the plan as it stands now rather than as it stood at
     * planning time, because `update_plan` can add or remove scenes ahead — and a
     * position measured against a stale total would put the last scene of a
     * shortened story in the middle tier.
     */
    const allocation = allocate({
      sceneIndex: i + 1,
      total: (planSink.plan ?? plan).scenes.length,
      pinnedRepairs: options.pinnedRepairs,
    });
    options.allocationState.open(allocation);
    const previousTier = allocations.at(-1)?.allocation.tier ?? null;
    allocations.push({ sceneId: card.id, allocation });

    say(
      `${card.id} start [${allocation.tier} @ ${allocation.position}: ` +
        `${allocation.repairRounds} repair, ${allocation.followUpRounds} follow-up, ` +
        `${allocation.recentScenes} recall] — ${card.intent.slice(0, 60)}`,
    );

    const { collaborators } = residentCollaborators({
      residents,
      sceneId: card.id,
      txid,
      bus: options.bus,
      ...(options.build ? { build: options.build } : {}),
      ...(options.backfill ? { backfill: options.backfill } : {}),
    });
    options.onScene?.(card.id);

    /**
     * Roles whose conversation starts fresh for this scene.
     *
     * Not a cost tweak dressed up as a design choice — for a provider that gives
     * no prompt caching, residency means paying for the entire history on every
     * request, and the measured verifier bill was 81% of a run on 11% of its
     * round-trips with its input growing 10k → 62k across four scenes. Which roles
     * these are is configuration, and the summary records it, so the ablation is
     * one flag rather than one fork.
     */
    for (const role of options.freshEachScene ?? []) {
      residents.resetSession(role);
    }

    const director = new SceneDirector(
      {
        txid,
        sceneId: card.id,
        packet: {
          sceneId: card.id,
          baseCommitId: await index.head(),
          // `narrative-voice` is hard-required for the same reason the scene card
          // is: a scene written without knowing who narrates it is not a scene of
          // this book. Seven of the nine consistency errors in the first 20k-word
          // manuscript were the voice drifting, because nothing carried it.
          hardRequiredIds: ["scene-card", "logline", "narrative-voice"],
          budgetWords: 60_000,
        },
        available: contextFor({
          card,
          plan,
          canon,
          // The tail, as deep as this scene's tier asks for.
          recentProse: recentProse.slice(-allocation.recentScenes),
          earlierIntents,
          request: premise,
        }),
        canon,
        knownEntities,
        allocation,
        prosePath: options.prosePathFor?.(card.id) ?? `manuscript/${card.id}.md`,
        // Both are on the card and the loop already, and both were nonetheless
        // missing at the point they decide something: without the target the
        // verifier cannot tell a short scene from a compressed one, and without the
        // position no layer knew which scene was the last — which is how a
        // manuscript that never resolved its premise passed every gate.
        sceneTargetWords: card.targetWords,
        position: { index: i + 1, total: (planSink.plan ?? plan).scenes.length },
        priorCraftNotes: craftNotes,
        // The same voice the packet hands the writer, given to the layer that
        // can refuse a draft over it. Carried to the writer since 0.8.0 and
        // checked by nothing until seven of nine measured errors turned out to
        // be exactly this.
        voice: (planSink.plan ?? plan).voice,
        // Derived from what is already on the page, not planned: a spelling
        // convention is not a judgement worth a model call, and `submit_plan`
        // already refuses often enough to cost planning round-trips. Absent on
        // the first scene, which is the one that establishes it.
        ...(convention ? { convention } : {}),
        // The seam. Half the restatement pairs measured straddle it, and the
        // other half are inside the draft, which needs no input.
        ...(recentProse.at(-1)
          ? {
              preceding: {
                sceneId: recentProse.at(-1)!.sceneId,
                prose: recentProse.at(-1)!.text,
              },
            }
          : {}),
      },
      { index, collaborators, artifacts: options.artifacts },
    );

    let run: Awaited<ReturnType<typeof driveScene>>;
    try {
      run = await driveScene({
        residents,
        stage: options.stage,
        director,
        txid,
        words: { committed: committedWords, target: targetWords },
        brief: sceneBrief({
          sceneId: card.id,
          intent: card.intent,
          presentEntities: card.presentEntities,
          targetWords: card.targetWords,
          chapter: chapterFor(sceneIndexOf(card.id)),
          position: { index: i + 1, total: (planSink.plan ?? plan).scenes.length },
          committed: committedScenes,
          failed: failures.map((f) => f.sceneId),
          allocation,
          words: { committed: committedWords, target: targetWords },
          state: {
            lastSceneClose: closingLines(recentProse.at(-1)?.text ?? null),
            lastScene: lastCommitted,
            // Declared minus paid off, computed from the deltas already in memory
            // rather than by reading the ledger — the orchestrator never reads it,
            // which is the whole reason this block exists.
            openPromises: openPromisesFrom(committedDeltas),
            upcoming: (planSink.plan ?? plan).scenes
              .slice(i + 1)
              .map((s) => ({ id: s.id, intent: s.intent })),
            tierBoundary: allocation.tier !== previousTier,
          },
        }),
        log: say,
      });
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      // Stop the story rather than trying the next scene. Every scene after the
      // ceiling costs real tokens to fail, and a run that keeps going past its
      // own hard stop reports an overrun many times the size of the real one.
      say(`${card.id} not attempted — ${error.message}`);
      for (const remaining of (planSink.plan ?? plan).scenes.slice(i)) {
        failures.push({
          sceneId: remaining.id,
          reason: "not attempted: the per-task token budget was exhausted",
        });
      }
      break;
    }

    const outcome = run.outcome;
    driving.scenesDriven += 1;
    driving.stepsByOrchestrator += run.orchestratorSteps;
    driving.stepsRescuedByEngine += run.rescuedSteps;

    // What the orchestrator thought happened, next to what did. Written per
    // scene because the two disagreeing is the most informative thing a run can
    // produce about whether agent-driven orchestration is working.
    await options.artifacts.write(
      artifactPaths.sceneLog(card.id),
      [
        `# ${card.id}`,
        "",
        `Outcome: ${outcome.status} after ${outcome.attempts} attempt(s), ` +
          `${outcome.findings.length} finding(s).`,
        `Steps driven by the orchestrator: ${run.orchestratorSteps}. ` +
          `Finished by the engine: ${run.rescuedSteps}.`,
        "",
        "## The orchestrator's account",
        "",
        run.account || "(it said nothing)",
        "",
      ].join("\n"),
    );

    scenes.push({ card, outcome });
    say(
      `${card.id} ${outcome.status} after ${outcome.attempts} attempt(s), ` +
        `${Math.round((Date.now() - sceneStarted) / 1000)}s, ` +
        `${outcome.findings.length} finding(s), ` +
        `${run.orchestratorSteps} step(s) driven, ${committedWords}/${targetWords} words so far`,
    );

    /**
     * Counted on every scene, committed or not, and outside the branch below.
     *
     * A checker that throws does not care whether the scene went on to commit, and
     * the incident that motivated the count is precisely the one where it did not:
     * the throw stranded the scene in VALIDATING, so every occurrence was on a
     * failed scene and a counter inside the COMMITTED branch would have read zero.
     */
    const outcomeWarnings: readonly string[] = "warnings" in outcome ? outcome.warnings : [];
    const checkerCrash = outcomeWarnings.find((w) => w.startsWith(DETERMINISTIC_LAYER_FAILED));
    if (checkerCrash) {
      deterministicFailures += 1;
      say(`${card.id} — ${checkerCrash}`);
    }

    if (outcome.status === "COMMITTED") {
      for (const warning of outcome.warnings) say(`${card.id} warning — ${warning}`);

      const backfillFailed = outcome.warnings.some((w) =>
        w.startsWith(BACKFILL_FAILURE_PREFIX),
      );
      if (backfillFailed) {
        backfillFailures += 1;
        consecutiveBackfillFailures += 1;
        if (consecutiveBackfillFailures >= 3) {
          // Not a scene failure — a broken mechanism. Continuing produces a
          // complete manuscript whose index holds identities and nothing else,
          // which is the artefact the whole design exists to avoid and the one
          // it reported as `done` for four versions.
          throw new Error(
            `the index backfill failed on ${consecutiveBackfillFailures} consecutive ` +
              `scenes, so this is a configuration failure and not a scene that went ` +
              `badly: every later scene would be written against an index missing ` +
              `state, beliefs, relations and events. Last cause — ` +
              `${outcome.warnings.find((w) => w.startsWith(BACKFILL_FAILURE_PREFIX))}`,
          );
        }
      } else {
        consecutiveBackfillFailures = 0;
      }

      const text = await index.read(options.prosePathFor?.(card.id) ?? `manuscript/${card.id}.md`);
      prose.push(text);
      recentProse.push({ sceneId: card.id, text });
      const delta = JSON.parse(
        await index.read(`continuity/deltas/${card.id}.json`),
      ) as SceneDelta;
      canon = absorb(canon, card.id, delta);
      const sceneWords = countWords(text);
      committedWords += sceneWords;
      lastCommitted = { id: card.id, words: sceneWords, target: card.targetWords };
      craftNotes = outcome.findings
        .filter((f) => f.axis === "craft" && f.severity === "warning" && f.suggestion)
        .map((f) => ({
          scene: card.id,
          check: f.subtype,
          why: f.reasoning,
          suggestion: f.suggestion!,
        }));
      committedScenes.push(card.id);
      committedDeltas.push(delta);
      proseByScene.set(card.id, text);
      earlierIntents.push(card.intent);

      // The first scene with evidence of a spelling system decides it for the
      // book, and the decision goes into the file every role is told to read —
      // the same fix as 0.8.6, where the packet asserted a constraint while the
      // file it cited still held its seed text.
      if (!spellingSettled) {
        const spelling = conventionOf(text);
        if (spelling) {
          spellingSettled = true;
          convention = { ...spelling, ...(requestScript ? { script: requestScript } : {}) };
          say(`convention established by ${card.id}: ${renderConvention(convention)}`);
          await index.seed([
            {
              relPath: paths.voice(),
              content:
                `Narration: ${(planSink.plan ?? plan).voice?.person ?? "(not declared)"}, ` +
                `${(planSink.plan ?? plan).voice?.tense ?? "?"} tense.\n\n` +
                `${renderConvention(convention)}\n`,
            },
          ]);
        }
      }
    } else {
      // A failed scene does not stop the story. It is recorded, the narrative
      // moves on, and the failure rate is a result — a harness that halts on
      // the first hard scene reports nothing at all.
      failures.push({
        sceneId: card.id,
        reason:
          "reason" in outcome ? outcome.reason : (outcome as { status: string }).status,
      });
      earlierIntents.push(`${card.intent} [scene not completed]`);
    }
  }

  // The revision phase. Everything above is scene-local; this is the only
  // place the story is looked at as a whole, and it is the only place the
  // negative inferences — an unpaid promise, an ability never used — can be
  // judged at all.
  say(`drafting done: ${committedScenes.length}/${plan.scenes.length} committed`);
  const revision = planRevisions({
    scenes: committedScenes,
    deltas: committedDeltas,
    proseByScene,
  });

  /**
   * The revision plan, on disk and then in front of the orchestrator.
   *
   * This layer has existed for two rounds and changed no prose in either,
   * because nothing read what it produced: the tasks went into a JSON file and
   * the story loop returned. A checker whose findings nobody acts on is a
   * measurement, not a mechanism — and the defects it sees are the ones a
   * scene-level gate is structurally blind to, so they are exactly the ones that
   * have no other route into the manuscript.
   *
   * What the orchestrator can do about them is bounded on purpose. Every scene
   * after the defect is already written and was written against it, so a repair
   * that contradicts a later scene trades a known defect for an unknown one. It
   * gets the tasks, the whole book to read, and the plan tool; a rewrite of
   * committed prose remains a transaction and is not attempted here.
   */
  await options.artifacts.write(
    artifactPaths.revisionPlan(),
    renderRevisionPlan({ revision, committed: committedScenes, failures }),
  );

  if (revision.tasks.length > 0 || failures.length > 0) {
    say(
      `revision pass: ${revision.tasks.length} task(s), ` +
        `${revision.coverage.contractsOpen} unpaid promise(s)`,
    );
    try {
      await residents.invoke(
        "orchestrator",
        [
          "The draft is complete. This is the whole-story pass — the only point at which",
          "defects that are absences rather than errors can be seen at all: a promise made",
          "and never paid off, an ability established and never used, a thread the story",
          "dropped. A scene-level gate cannot see any of them, because each individual scene",
          "is fine.",
          "",
          `The plan is written to ${artifactPaths.revisionPlan()}. Read it, then read what it`,
          "points at — you have the whole book under novel/chapters/ and the promise ledger",
          "at continuity/plot-contracts.jsonl.",
          "",
          renderRevisionPlan({ revision, committed: committedScenes, failures }),
          "",
          "Two constraints, and they are what make this hard rather than tedious. Every scene",
          "after a defect is already written and was written against it, so a repair that",
          "contradicts a later scene trades a known defect for an unknown one. And a payoff",
          "dropped in at the deadline with no preparation reads worse than the abandonment it",
          "was meant to repair.",
          "",
          "So do not rewrite anything now. Say, for each task: whether it is real, what the",
          "fix would have to touch, and whether the fix is worth its risk. Record anything",
          "you would do differently next time with `remember` — the next story is where that",
          "judgement is worth something.",
        ].join("\n"),
        { txid: "tx-revision", caller: "orchestrator", selfCall: true },
      );
    } catch (error) {
      // A failed revision pass does not invalidate a finished draft. It costs
      // the assessment, which is worth recording and not worth the manuscript.
      say(
        `revision pass failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const manuscript = prose.join("\n\n");
  return {
    manuscript,
    words: countWords(manuscript),
    plan: planSink.plan ?? plan,
    scenes,
    canon,
    failures,
    revision,
    driving,
    allocations,
    backfillFailures,
    deterministicFailures,
  };
}

/** The whole-story pass, as a document rather than a JSON dump. */
export function renderRevisionPlan(input: {
  readonly revision: RevisionPlan;
  readonly committed: readonly string[];
  readonly failures: readonly { readonly sceneId: string; readonly reason: string }[];
}): string {
  const { revision } = input;
  return [
    "# Revision plan",
    "",
    `Committed scenes: ${input.committed.length}. ` +
      `Did not complete: ${input.failures.length}.`,
    `Promises made: ${revision.coverage.contractsChecked}. ` +
      `Still unpaid: ${revision.coverage.contractsOpen}.`,
    `Capabilities established: ${revision.coverage.capabilitiesChecked}.`,
    "",
    revision.tasks.length === 0
      ? revision.coverage.contractsOpen > 0
        ? // Two numbers on the same page must not contradict each other. The
          // first version said "nothing is owed to the reader and unpaid"
          // directly under "still unpaid: 2", because it read the task count
          // and described the promise count. An open promise with no deadline
          // is not yet a defect — the global pass only raises one once a
          // declared `due_by_scene` has passed — but saying nothing is owed
          // when something is owed teaches the reader to distrust the file.
          `No revision tasks. ${revision.coverage.contractsOpen} promise(s) are still ` +
          `open, but none declared a scene by which they had to pay off, so nothing is ` +
          `overdue. Judge them yourself: an open loop the story never returns to reads ` +
          `as abandonment whether or not a deadline was written down.`
        : "No revision tasks, and no promise left unpaid."
      : revision.tasks
          .map(
            (task, i) =>
              `## Task ${i + 1} — ${task.finding.subtype}\n\n` +
              `${task.rationale}.\n\n` +
              `Scenes in scope: ${task.targetScenes.join(", ")}.\n\n` +
              `> ${task.finding.evidence.quote.slice(0, 300)}\n\n` +
              `${task.finding.reasoning}`,
          )
          .join("\n\n"),
    "",
    input.failures.length > 0
      ? `## Scenes that never landed\n\n${input.failures
          .map((f) => `- ${f.sceneId}: ${f.reason}`)
          .join("\n")}`
      : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}
