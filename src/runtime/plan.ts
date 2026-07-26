/**
 * The plan: what scenes there are, and the index they are written against.
 *
 * Split from `story.ts` because it answers a different question. This file is
 * about the story before any of it exists — how many scenes, which entities,
 * what the world may not break — and about turning that into files on disk.
 * `story.ts` is about what happens once prose starts arriving and the plan
 * begins to be wrong.
 *
 * The split has a load-bearing consequence in `planFiles`. Writing the plan into
 * the index *before the first scene is built* was missing for a long time, and
 * the failure it caused was not one anybody would predict: the context-builder,
 * asked to find material and finding no outline anywhere on disk, read the
 * orchestrator's transcript and cited `runtime/transcripts/orchestrator/….jsonl`
 * as provenance for the cast. It was the only place the plan existed.
 */

import { Type } from "typebox";
import { stringify as toYaml } from "yaml";

import type { FileWrite } from "../index/commit.ts";
import { chapterFor, paths, sceneIndexOf } from "../index/tree.ts";
import type { ResidentAgents } from "../agents/residents.ts";

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

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
  /**
   * Write the finished plan back into the sink, not just return it.
   *
   * `submit_plan` cannot know the per-scene word target — it is derived from the
   * task's target and the scene count — so the plan the tool stores has
   * `targetWords: 0` on every card. Returning a corrected copy while leaving the
   * sink uncorrected worked only for as long as nobody read the sink.
   *
   * Then the scene loop started re-reading it each iteration, so that
   * `update_plan` could revise the scenes ahead, and every card it read carried
   * the zero. The writer was told **"Target length: about 0 words"** on every
   * scene of every run, and the effect was exactly what it sounds like: a
   * 2,800-word task delivered 2,056. One object, one truth.
   */
  const resolved: StoryPlan = {
    ...sink.plan,
    scenes: sink.plan.scenes.map((s) => ({ ...s, targetWords: perScene })),
  };
  sink.plan = resolved;
  return resolved;
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