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
  /** Who narrates, and in what tense. See `submit_plan` for why this is required. */
  readonly voice: { readonly person: string; readonly tense: string };
  readonly scenes: readonly SceneCard[];
}

/**
 * Below this, a "scene" is not a scene.
 *
 * ## Why the floor of four had to yield
 *
 * `lbw029` is a 500-word task, and `max(4, …)` gave it four scenes of 125 words,
 * each with its own packet, writer turn, verifier pass and commit. A scene that
 * has to open and close inside 125 words is not a scene, and the frozen judge put
 * that run seventh of nine systems: the best length score in the table (99.4) and
 * the worst quality in it (3.83, against raw `gpt-5-mini`'s 4.67 on the same
 * backbone).
 *
 * ## What the rerun said
 *
 * Same task as **one** scene: 93.6 against 88.0, with S_q rising 3.83 → 4.50
 * (coherence, breadth and reading experience each gaining) at the cost of two
 * points of length compliance. It also cost **$0.46 against $1.31** and 304
 * tokens per delivered word against 4,542 — four scenes of 125 words spend four
 * packets, four verifier passes and four commits on 500 words of prose.
 *
 * One sample per arm on a 1–5 integer quality scale is weak evidence and the two
 * runs produced different stories rather than one story cut two ways, so the size
 * of the gap means little. The direction agrees with the structural argument,
 * which is what this constant rests on: a passage that must open and close inside
 * 125 words is not a scene.
 *
 * Nothing at 2,000 words and above changes, which is deliberate: those lengths
 * have been scored, and silently altering their scene counts would invalidate
 * every comparison in the table while looking like an improvement.
 */
const MIN_WORDS_PER_SCENE = 500;

/**
 * A scene happens somewhere. Above this many locations it is a list of places.
 *
 * Measured rather than chosen: across twenty plans this harness has produced —
 * 1 to 32 scenes, 500 to 40,000 words — the most locations any single scene
 * declared present was **four**. The 60,000-word stress test declared
 * **thirteen** in every one of its fifty-two scenes.
 */
const MAX_LOCATIONS_PER_SCENE = 5;

/**
 * Above this share of the whole cast per scene, the scene lists are a roster
 * dump rather than a plan.
 *
 * Same measurement, and stated as coverage rather than as similarity between
 * scenes on purpose: the defect is "every scene contains everybody", and
 * similarity alone also flags a legitimate ten-scene story about one person,
 * whose scenes are identical because its cast really is one character.
 *
 * Among plans long enough for a cast to move around (17, 32 and 52 scenes) the
 * median scene listed 17%, 30%, 33% and 20% of the story's entities — against
 * **100%** for the 60,000-word stress test. Short plans legitimately run much
 * higher (a four-scene story does use its whole small cast, up to 81%), which
 * is why this only applies once there are enough scenes for a cast to be
 * somewhere else, and only to a roster big enough to choose from.
 *
 * The share is measured against the entities the plan actually *uses*, not the
 * entities it declares. Against the declared list the check buys itself off:
 * declare a hundred and put the same thirty-four in every scene, and the share
 * reads 34%.
 */
const MAX_CAST_SHARE_PER_SCENE = 0.7;
const CAST_SHARE_MIN_SCENES = 8;
const CAST_SHARE_MIN_ENTITIES = 10;

/**
 * How many scenes a target length gets.
 *
 * Derived rather than left to the model: asked for "a plan for 40,000 words" a
 * model reliably proposes a dozen scenes and then has to write 3,000 words each,
 * which is where single-call length limits bite.
 */
export function sceneCountFor(targetWords: number, wordsPerScene = 1_200): number {
  const preferred = Math.max(4, Math.round(targetWords / wordsPerScene));
  const affordable = Math.floor(targetWords / MIN_WORDS_PER_SCENE);
  return Math.max(1, Math.min(preferred, affordable));
}

export function planTool(
  sink: { plan?: StoryPlan },
  sceneCount: number,
  /**
   * The task's whole target, so the tool can refuse a plan that slices it too
   * thinly. Deriving the scene count is not enough on its own: the model is only
   * *asked* for about `sceneCount` scenes, and on a short task the difference
   * between one scene and four is the difference between a story and four
   * fragments.
   */
  targetWords: number,
): unknown {
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
      /**
       * Who tells the story, and in what tense.
       *
       * Added because it was the largest single defect in the first 20k-word
       * manuscript this harness produced. LiveNovelBench's consistency audit found
       * nine errors in 18,274 words, and **seven of them were
       * `perspective_confusions`**: the narration drifts between a collective
       * first person and close third on the protagonist, scene by scene —
       * *"The list was already up when **we** came in"* against *"**Rue** walked
       * toward the ferry"*, five more like it.
       *
       * Nothing in the system had ever decided. `novel/style/voice.md` was seeded
       * with the placeholder *"(Established by the first committed scenes)"*, the
       * plan had no field for it, and so seventeen scenes each chose for
       * themselves. That is not a writer failing to hold a voice; it is a
       * constraint that was never written down, and a constraint nobody records is
       * the one the index cannot defend.
       */
      narrative_person: Type.String({
        description:
          "How the story is narrated, decided once and held: \"first person, Rue\" | " +
          "\"third person limited, Rue\" | \"third person omniscient\" | \"first person plural, " +
          "the Hundred\". Name the viewpoint character where there is one.",
      }),
      tense: Type.String({ description: "past | present" }),
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
        narrative_person?: string;
        tense?: string;
        scenes: { intent: string; present: string[] }[];
      },
    ) => {
      const scenes = args.scenes ?? [];
      if (!args.narrative_person?.trim() || !args.tense?.trim()) {
        return toolText(
          "rejected: narrative_person and tense are both required. They are the one pair of " +
            "constraints every scene needs and no scene can establish, because a voice is only " +
            "consistent relative to a decision made before the first scene. Left undecided, the " +
            "first 20,000-word manuscript this system wrote drifted between \"we\" and \"Rue\" " +
            "across seventeen scenes, and seven of its nine measured consistency errors were " +
            "that drift.",
        );
      }
      if (!/\b(first|second|third)\b/i.test(args.narrative_person)) {
        return toolText(
          `rejected: narrative_person "${args.narrative_person}" does not say which person. ` +
            `The writer has to be able to check a sentence against it, so it needs to name the ` +
            `person and, where there is one, the viewpoint character — "third person limited, ` +
            `Rue" is checkable and "intimate and lyrical" is not.`,
        );
      }
      /**
       * A story may alternate viewpoints. It may not leave the switch unlocated.
       *
       * The 40,000-word historical cell declared *"third person limited,
       * alternating between the Queen and the Actress, past tense"*, which passes
       * every check above and still fails this tool's own stated bar: the writer
       * has to be able to check a sentence against it, and under that declaration
       * a sentence inside either woman's head is correct anywhere in the book. So
       * is a sentence that moves between them mid-paragraph — which is what the
       * consistency detector reports as `perspective_confusions`, the subtype
       * holding seven of the nine errors this constraint exists to prevent.
       *
       * Naming the unit fixes it without banning the technique: "one viewpoint per
       * scene, alternating between the Queen and the Actress" makes every sentence
       * checkable again, because the scene it is in has an owner.
       */
      if (/\b(alternat\w*|shifting|rotating|switch\w*|multiple viewpoints)\b/i.test(args.narrative_person)) {
        if (!/\bper (?:scene|chapter|section)\b|\beach (?:scene|chapter|section)\b|\bone .{0,24}per\b|\bby (?:scene|chapter)\b/i.test(args.narrative_person)) {
          return toolText(
            `rejected: narrative_person "${args.narrative_person}" alternates viewpoint without ` +
              `saying where it is allowed to switch, so no sentence can be checked against it — ` +
              `either head is correct anywhere, including in the middle of a paragraph. Name the ` +
              `unit that owns a viewpoint: "third person limited, one viewpoint per scene, ` +
              `alternating between the Queen and the Actress". Alternating is fine; unlocated ` +
              `alternation is the defect the consistency detector reports as ` +
              `perspective_confusions, and that subtype was seven of the nine errors in the ` +
              `first 20,000-word manuscript this harness wrote.`,
          );
        }
      }
      if (!/^(past|present)$/i.test(args.tense.trim())) {
        return toolText(`rejected: tense must be "past" or "present"; got "${args.tense}".`);
      }
      if (scenes.length < Math.floor(sceneCount * 0.6)) {
        return toolText(
          `rejected: ${scenes.length} scenes is too few for the target. Propose about ` +
            `${sceneCount}. Each scene is written by a separate call, so a short plan does ` +
            `not shorten the work — it makes each scene carry more words than one call writes well.`,
        );
      }
      const perScene = Math.floor(targetWords / Math.max(1, scenes.length));
      if (scenes.length > sceneCount && perScene < MIN_WORDS_PER_SCENE) {
        return toolText(
          `rejected: ${scenes.length} scenes for ${targetWords} words is ${perScene} words ` +
            `each, and a ${perScene}-word scene is not a scene — it has to open and close ` +
            `with no room to do anything in between. Propose about ${sceneCount}. This was ` +
            `measured: a 500-word task written as four 125-word scenes scored the best ` +
            `length compliance in its table and the worst quality in it, below a single ` +
            `unstructured call to the same model.`,
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
            `absent asks the writer to invent it. Add the ones that scene's intent needs, ` +
            `or rewrite the intent. Do not pad \`present\` to be safe: it is the cast of ` +
            `one scene, it is checked in both directions, and everything listed there is ` +
            `carried into the writer's packet at a priority nothing can evict.`,
        );
      }

      // The other direction, and the one that cost a whole stress test.
      //
      // The rejection above tells the orchestrator to *add* entities, and across
      // fifty-two scenes the cheapest way to never trip it again is to list
      // every entity in every scene. That is what the 60k run did: the identical
      // thirty-four ids — thirteen characters, thirteen locations, eight objects
      // — in all fifty-two cards, in a story whose scenes are 1,200 words each.
      //
      // It is not a cosmetic defect. `present` drives P1 of the context packet
      // (each present character's current state and beliefs), P1 cannot be
      // evicted, and it measured 2,609 tokens against a median of ~700 in the
      // two healthy 40k runs. The writer is also simply told, on its scene card,
      // that thirteen characters are in a 1,200-word opening.
      const locationHeavy = scenes.flatMap((s, i) => {
        const locs = (s.present ?? []).filter((p) => p.startsWith("loc-"));
        return locs.length > MAX_LOCATIONS_PER_SCENE
          ? [`scene ${i + 1} lists ${locs.length}: ${locs.join(", ")}`]
          : [];
      });
      if (locationHeavy.length > 0) {
        return toolText(
          `rejected: ${locationHeavy.length} scene(s) list more than ` +
            `${MAX_LOCATIONS_PER_SCENE} locations as present:\n- ` +
            `${locationHeavy.join("\n- ")}\nA scene happens somewhere; it can move once ` +
            `or twice. List where this scene actually takes place, not everywhere it ` +
            `refers to — a place a character mentions or remembers is not present, and ` +
            `the writer reads this line as the setting it has to put on the page.`,
        );
      }

      const used = new Set(scenes.flatMap((s) => s.present ?? []));
      if (scenes.length >= CAST_SHARE_MIN_SCENES && used.size >= CAST_SHARE_MIN_ENTITIES) {
        const shares = scenes
          .map((s) => new Set(s.present ?? []).size / used.size)
          .sort((a, b) => a - b);
        const median = shares[Math.floor(shares.length / 2)] ?? 0;
        if (median > MAX_CAST_SHARE_PER_SCENE) {
          return toolText(
            `rejected: the median scene lists ${(median * 100).toFixed(0)}% of the ` +
              `${used.size} entities this plan uses as present. A plan whose every scene ` +
              `contains everybody ` +
              `has not decided anything: it cannot say who arrives, who is absent when the ` +
              `news breaks, or who finds out last — and those are the decisions that make a ` +
              `scene worth writing. Give each scene the cast that is in the room for it. For ` +
              `reference, the plans that scored well at this length ran 17–33%.`,
          );
        }
      }
      sink.plan = {
        logline: args.logline,
        entities: args.entities ?? [],
        worldRules: args.world_rules ?? [],
        voice: {
          person: args.narrative_person!.trim(),
          tense: args.tense!.trim().toLowerCase(),
        },
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
    /**
     * The declared voice, written where everything is told to look for it.
     *
     * The packet has carried `Narration: <person>, <tense> tense … decided for
     * the whole book before any of it was written and does not change` since
     * 0.8.0, and it cites this path as its source. This path held the seed text:
     * *"(Established by the first committed scenes; the writer may propose
     * changes.)"* — the opposite claim, at the address the claim points to.
     *
     * That is not a tidiness problem, because of who reads it. The verifier's
     * brief sends it here by name to check register drift — *"Narrative style —
     * voice, tense, register drift. `novel/style/voice.md` and the previous
     * scene are the comparison"* — and register drift is the defect that
     * accounts for **seven of the nine** consistency errors measured in the
     * first 20,000-word manuscript. An agent asked to enforce a constraint, sent
     * to the file that holds it, and shown a note saying the constraint is not
     * settled yet, has been told there is nothing to enforce.
     */
    {
      relPath: paths.voice(),
      content:
        `# Voice\n\nNarration: ${plan.voice.person}, ${plan.voice.tense} tense.\n\n` +
        `Decided for the whole book before any of it was written, and held. A scene that ` +
        `slips into another person or tense is wrong against this file, not proposing a ` +
        `change to it.\n`,
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