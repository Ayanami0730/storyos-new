/**
 * From a premise to a finished manuscript.
 *
 * The scene loop can complete one scene. This is the layer that decides which
 * scenes there are, feeds each one the context the index has accumulated so
 * far, and assembles what comes back.
 *
 * The part that carries the paper's claim is `contextFor`. Every scene is
 * written against material *derived from committed state*, not against a
 * growing transcript — that is the difference between this and a harness that
 * hands the next call a summary of the last one. Whether it is worth its cost
 * is exactly what the experiments measure, so the code has to make it true
 * rather than approximately true.
 */

import { Type } from "typebox";

import type { ContextItem } from "../context/types.ts";
import { stringify as toYaml } from "yaml";

import type { CanonicalIndex, FileWrite } from "../index/commit.ts";
import { chapterFor, paths, sceneIndexOf } from "../index/tree.ts";
import type { AgentRole } from "../transaction/types.ts";
import type { CanonFact } from "../verification/deterministic.ts";
import type { ResidentAgents } from "../agents/residents.ts";
import { type SceneToolBus, residentCollaborators } from "./collaborators.ts";
import { type RevisionPlan, planRevisions } from "./revision.ts";
import type { SceneDelta } from "../verification/deterministic.ts";
import { type SceneOutcome, runScene } from "./scene-loop.ts";

export interface SceneCard {
  readonly id: string;
  readonly intent: string;
  readonly presentEntities: readonly string[];
  readonly targetWords: number;
}

export interface StoryPlan {
  readonly logline: string;
  readonly entities: readonly { readonly id: string; readonly sketch: string }[];
  readonly worldRules: readonly string[];
  readonly scenes: readonly SceneCard[];
}

export interface StoryResult {
  readonly manuscript: string;
  readonly words: number;
  readonly plan: StoryPlan;
  readonly scenes: readonly { readonly card: SceneCard; readonly outcome: SceneOutcome }[];
  readonly canon: readonly CanonFact[];
  /** Scenes that never committed, with why. Reported, never hidden. */
  readonly failures: readonly { readonly sceneId: string; readonly reason: string }[];
  /** What the whole-story pass found. Suggestions, never gate decisions. */
  readonly revision: RevisionPlan;
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
export function sceneCountFor(targetWords: number, wordsPerScene = 1_200): number {
  return Math.max(4, Math.round(targetWords / wordsPerScene));
}

export function planTool(sink: { plan?: StoryPlan }, sceneCount: number): unknown {
  return {
    label: "Submit plan",
    name: "submit_plan",
    description: "Submit the story plan. Call once.",
    parameters: Type.Object({
      logline: Type.String(),
      entities: Type.Array(
        Type.Object({
          id: Type.String({ description: "Stable id, e.g. char-mira or loc-harbour" }),
          sketch: Type.String({ description: "One or two sentences" }),
        }),
      ),
      world_rules: Type.Array(Type.String()),
      scenes: Type.Array(
        Type.Object({
          intent: Type.String({ description: "What this scene accomplishes" }),
          present: Type.Array(Type.String({ description: "Entity ids present" })),
        }),
      ),
    }),
    execute: async (
      _id: string,
      args: {
        logline: string;
        entities: { id: string; sketch: string }[];
        world_rules: string[];
        scenes: { intent: string; present: string[] }[];
      },
    ) => {
      const scenes = args.scenes ?? [];
      if (scenes.length < Math.floor(sceneCount * 0.6)) {
        return toolText(
          `rejected: ${scenes.length} scenes is too few for the target. Propose about ` +
            `${sceneCount}. Each scene is written by a separate call, so a short plan does ` +
            `not shorten the work — it makes each scene carry more words than one call writes well.`,
        );
      }
      const ids = new Set((args.entities ?? []).map((e) => e.id));
      const unknown = scenes.flatMap((s) =>
        (s.present ?? []).filter((p) => !ids.has(p)),
      );
      if (unknown.length > 0) {
        return toolText(
          `rejected: scenes reference entities that are not in your entity list: ` +
            `${[...new Set(unknown)].join(", ")}. Add them or fix the ids.`,
        );
      }

      // An intent that names a character the scene does not list as present is
      // an instruction the writer cannot follow safely. It happened on the first
      // run with the tree: scene 1's intent said "Elias meets Mira at the
      // Watchhouse" while `present` listed neither, so the writer invented what
      // it had not been given and the scene was rejected three times over
      // entities that were in the plan all along.
      const missing = scenes.flatMap((s, i) => {
        const present = new Set(s.present ?? []);
        const named = [...ids].filter(
          (id) =>
            !present.has(id) &&
            // Match on the distinctive part of the id, so `char-elias-warden`
            // is found in prose that says "Elias".
            new RegExp(`\\b${id.replace(/^(char|loc|obj|fac)-/, "").split("-")[0]}\\b`, "i").test(
              s.intent ?? "",
            ),
        );
        return named.map((id) => `scene ${i + 1} (${s.intent?.slice(0, 40)}…) names ${id}`);
      });
      if (missing.length > 0) {
        return toolText(
          `rejected: ${missing.length} scene(s) describe an entity they do not list as ` +
            `present:\n- ${missing.join("\n- ")}\nThe writer only receives state and ` +
            `beliefs for entities in \`present\`, so an intent that requires one which is ` +
            `absent asks the writer to invent it. Add them to \`present\` or rewrite the ` +
            `intent.`,
        );
      }
      sink.plan = {
        logline: args.logline,
        entities: args.entities ?? [],
        worldRules: args.world_rules ?? [],
        scenes: scenes.map((s, i) => ({
          id: `s-${String(i + 1).padStart(3, "0")}`,
          intent: s.intent,
          presentEntities: s.present ?? [],
          targetWords: 0,
        })),
      };
      return toolText(`plan accepted: ${scenes.length} scenes.`);
    },
  };
}

/**
 * Revise the remaining plan mid-story.
 *
 * Modelled on how a coding agent keeps a live todo list rather than a plan it
 * wrote once: the outline is a working document, and the prose is the thing
 * that teaches you what the outline should have said. Our writer prompt already
 * invites deviation proposals; this is where one can be acted on.
 *
 * The hard boundary is committed scenes. They are on the page, later scenes
 * were written against them, and "revising" one by editing the plan would make
 * the plan disagree with the manuscript silently. Changing committed prose is
 * the revision phase's job, through a real transaction.
 */
export function updatePlanTool(state: {
  plan?: StoryPlan;
  committed: ReadonlySet<string>;
}): unknown {
  return {
    label: "Update plan",
    name: "update_plan",
    description:
      "Revise the scenes that have not been written yet. Use when the prose has diverged " +
      "from the outline, a thread needs more room, or a planned scene is no longer earning " +
      "its place. Say why.",
    parameters: Type.Object({
      reason: Type.String({ description: "What the prose taught you that the plan got wrong" }),
      scenes: Type.Array(
        Type.Object({
          id: Type.String({ description: "Existing scene id to replace, or 'new'" }),
          intent: Type.String(),
          present: Type.Array(Type.String()),
        }),
      ),
    }),
    execute: async (
      _id: string,
      args: { reason: string; scenes: { id: string; intent: string; present: string[] }[] },
    ) => {
      if (!state.plan) return toolText("rejected: there is no plan yet.");
      if (!args.reason?.trim()) {
        return toolText("rejected: reason is required — an unexplained plan change is a drift.");
      }
      const touched = (args.scenes ?? []).filter((s) => state.committed.has(s.id));
      if (touched.length > 0) {
        return toolText(
          `rejected: ${touched.map((s) => s.id).join(", ")} are already written and later ` +
            `scenes were built on them. To change committed prose, raise it in the revision ` +
            `phase; editing the plan would leave the plan disagreeing with the manuscript.`,
        );
      }

      const kept = state.plan.scenes.filter((s) => state.committed.has(s.id));
      const perScene = state.plan.scenes[0]?.targetWords ?? 1200;
      const replacements = (args.scenes ?? []).map((s, i) => ({
        id: s.id === "new" ? `s-${String(kept.length + i + 1).padStart(3, "0")}` : s.id,
        intent: s.intent,
        presentEntities: s.present ?? [],
        targetWords: perScene,
      }));
      state.plan = { ...state.plan, scenes: [...kept, ...replacements] };
      return toolText(
        `plan updated: ${kept.length} scene(s) already written kept, ` +
          `${replacements.length} ahead.`,
      );
    },
  };
}

export async function planStory(options: {
  readonly residents: ResidentAgents;
  readonly premise: string;
  readonly targetWords: number;
  readonly txid: string;
  readonly sink: { plan?: StoryPlan };
}): Promise<StoryPlan> {
  const { residents, premise, targetWords, txid, sink } = options;
  const sceneCount = sceneCountFor(targetWords);
  const perScene = Math.round(targetWords / sceneCount);

  await residents.invoke(
    "orchestrator",
    `Plan a story of about ${targetWords} words from this premise.\n\n${premise}\n\n` +
      `Propose about ${sceneCount} scenes of roughly ${perScene} words each. Give every ` +
      `character, location and significant object a stable id now — later scenes can only ` +
      `refer to entities that exist. State the world rules the story must not break. ` +
      `Then call submit_plan.`,
    { txid, caller: "orchestrator", selfCall: true },
  );

  if (!sink.plan) throw new Error("the orchestrator produced no plan");
  return {
    ...sink.plan,
    scenes: sink.plan.scenes.map((s) => ({ ...s, targetWords: perScene })),
  };
}

/**
 * The plan, as files.
 *
 * A pure projection, so the engine writes it rather than spending a model call:
 * there is no judgement in turning a scene list into scene cards. What matters
 * is that it exists on disk *before the first scene is built*, because every
 * downstream agent is told to work from the index and until now the index did
 * not contain the story's own outline.
 *
 * Entity stubs are part of it. An empty `characters/char-mira/profile.yaml` is
 * not clutter — it is the difference between "this character has no recorded
 * identity yet" and "this character does not exist", and the verifier has
 * already rejected a scene three times for confusing the two.
 */
export function planFiles(plan: StoryPlan, premise: string): readonly FileWrite[] {
  const files: FileWrite[] = [
    { relPath: paths.premise(), content: `${premise.trim()}\n` },
    { relPath: paths.logline(), content: `${plan.logline}\n` },
    {
      relPath: paths.worldRules(),
      content: toYaml({
        note: "What is true. Not what anyone knows — see characters/<id>/beliefs.jsonl.",
        rules: plan.worldRules,
      }),
    },
    {
      relPath: paths.beats(),
      content: toYaml({
        scenes: plan.scenes.map((s) => ({
          id: s.id,
          chapter: chapterFor(sceneIndexOf(s.id)),
          intent: s.intent,
          present: s.presentEntities,
          target_words: s.targetWords,
        })),
      }),
    },
  ];

  for (const chapter of new Set(plan.scenes.map((s) => chapterFor(sceneIndexOf(s.id))))) {
    const scenes = plan.scenes.filter((s) => chapterFor(sceneIndexOf(s.id)) === chapter);
    files.push({
      relPath: paths.chapterCard(chapter),
      content: toYaml({
        chapter,
        scenes: scenes.map((s) => ({ id: s.id, intent: s.intent, present: s.presentEntities })),
      }),
    });
  }

  for (const entity of plan.entities) {
    if (entity.id.startsWith("char-")) {
      files.push({
        relPath: paths.profile(entity.id),
        content: toYaml({
          id: entity.id,
          name: entity.id.replace(/^char-/, ""),
          sketch: entity.sketch,
          identity: {},
          provenance: {},
        }),
      });
    } else if (entity.id.startsWith("loc-")) {
      files.push({
        relPath: paths.location(entity.id),
        content: toYaml({ id: entity.id, sketch: entity.sketch, first_seen: null }),
      });
    } else {
      files.push({
        relPath: paths.object(entity.id),
        content: toYaml({ id: entity.id, sketch: entity.sketch, first_seen: null }),
      });
    }
  }

  return files;
}

/**
 * The packet material for one scene, assembled from committed state.
 *
 * Priorities are what the builder enforces; what belongs in each is this
 * function's judgement. The one that matters most is P1: a character's *current*
 * facts, so the writer is never guessing at state the index already knows.
 */
export function contextFor(input: {
  readonly card: SceneCard;
  readonly plan: StoryPlan;
  readonly canon: readonly CanonFact[];
  readonly previousProse: string | null;
  readonly earlierIntents: readonly string[];
}): readonly ContextItem[] {
  const { card, plan, canon, previousProse, earlierIntents } = input;
  const items: ContextItem[] = [
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

  if (previousProse) {
    items.push({
      id: "previous-scene",
      priority: "P2",
      source: "manuscript (previous scene)",
      content: previousProse,
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
  readonly maxRepairs: number;
  readonly planSink: { plan?: StoryPlan };
  /**
   * Shared with whoever constructed the agents. It must be the same bus: the
   * agents' tools were registered against it once, and a second bus here would
   * mean the writer files its prose into a buffer nobody reads.
   */
  readonly bus: SceneToolBus;
  readonly onScene?: (sceneId: string) => void;
  /** Resident context-builder, when one is configured. */
  readonly build?: (input: {
    readonly sceneId: string;
    readonly skeleton: import("../context/types.ts").ContextPacket;
  }) => Promise<readonly ContextItem[]>;
  /** Resident index-manager's backfill, when one is configured. */
  readonly backfill?: (input: {
    readonly sceneId: string;
    readonly draft: import("./scene-loop.ts").Draft;
    readonly packet: import("../context/types.ts").ContextPacket;
  }) => Promise<readonly import("../index/commit.ts").FileWrite[]>;
  /** Where prose goes; the tree groups scenes into chapters. */
  readonly prosePathFor?: (sceneId: string) => string;
  /**
   * Progress, because a forty-scene run that prints nothing for an hour is
   * indistinguishable from a hung one, and the difference matters at 3am.
   */
  readonly log?: (line: string) => void;
}): Promise<StoryResult> {
  const { residents, index, premise, targetWords, maxRepairs, planSink } = options;

  const say = options.log ?? (() => {});
  const buildScene = options.build;
  const backfillScene = options.backfill;
  say(`planning for ${targetWords} words`);
  const plan = await planStory({
    residents,
    premise,
    targetWords,
    txid: "tx-plan",
    sink: planSink,
  });

  // The initial index, before any scene is built against it.
  const seeded = await index.seed(planFiles(plan, premise));
  say(`initial index seeded: ${seeded.writtenPaths.length} file(s)`);

  const knownEntities = new Set(plan.entities.map((e) => e.id));
  let canon: readonly CanonFact[] = [];
  let previousProse: string | null = null;
  const earlierIntents: string[] = [];
  const scenes: { card: SceneCard; outcome: SceneOutcome }[] = [];
  const failures: { sceneId: string; reason: string }[] = [];
  const prose: string[] = [];
  const committedScenes: string[] = [];
  const committedDeltas: SceneDelta[] = [];
  const proseByScene = new Map<string, string>();

  say(
    `plan: ${plan.scenes.length} scenes, ${plan.entities.length} entities, ` +
      `${plan.worldRules.length} world rules`,
  );

  for (const card of plan.scenes) {
    const txid = `tx-${card.id}`;
    const sceneStarted = Date.now();
    say(`${card.id} start — ${card.intent.slice(0, 70)}`);
    const { collaborators } = residentCollaborators({
      residents,
      sceneId: card.id,
      txid,
      bus: options.bus,
      ...(buildScene ? { build: buildScene } : {}),
      ...(backfillScene ? { backfill: backfillScene } : {}),
    });
    options.onScene?.(card.id);

    let outcome: SceneOutcome;
    try {
      outcome = await runScene(
      {
        txid,
        sceneId: card.id,
        packet: {
          sceneId: card.id,
          baseCommitId: await index.head(),
          hardRequiredIds: ["scene-card", "logline"],
          budgetWords: 60_000,
        },
        available: contextFor({ card, plan, canon, previousProse, earlierIntents }),
        canon,
        knownEntities,
        maxRepairs,
        prosePath: options.prosePathFor?.(card.id) ?? `manuscript/${card.id}.md`,
      },
      { index, collaborators },
      );
    } catch (error) {
      // A collaborator that never produced an artefact is a scene failure, not
      // a run failure. Recorded and moved past, exactly like a rejected scene:
      // the failure rate is a result we want, and a harness that halts on the
      // first misbehaving turn produces no result at all.
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      say(`${card.id} FAILED — ${reason}`);
      failures.push({ sceneId: card.id, reason });
      earlierIntents.push(`${card.intent} [scene not completed]`);
      continue;
    }

    scenes.push({ card, outcome });
    say(
      `${card.id} ${outcome.status} after ${outcome.attempts} attempt(s), ` +
        `${Math.round((Date.now() - sceneStarted) / 1000)}s, ` +
        `${outcome.findings.length} finding(s)`,
    );

    if (outcome.status === "COMMITTED") {
      for (const warning of outcome.warnings) say(`${card.id} warning — ${warning}`);
      const text = await index.read(options.prosePathFor?.(card.id) ?? `manuscript/${card.id}.md`);
      prose.push(text);
      previousProse = text;
      const delta = JSON.parse(
        await index.read(`continuity/deltas/${card.id}.json`),
      ) as SceneDelta;
      canon = absorb(canon, card.id, delta);
      committedScenes.push(card.id);
      committedDeltas.push(delta);
      proseByScene.set(card.id, text);
      earlierIntents.push(card.intent);
    } else {
      // A failed scene does not stop the story. It is recorded, the narrative
      // moves on, and the failure rate is a result — a harness that halts on
      // the first hard scene reports nothing at all.
      failures.push({
        sceneId: card.id,
        reason:
          "reason" in outcome
            ? outcome.reason
            : (outcome as { status: string }).status,
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

  const manuscript = prose.join("\n\n");
  return {
    manuscript,
    words: manuscript.split(/\s+/).filter(Boolean).length,
    plan,
    scenes,
    canon,
    failures,
    revision,
  };
}
