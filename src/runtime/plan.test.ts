import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type StoryPlan, planFiles, planStory, planTool, sceneCountFor } from "./plan.ts";

describe("scene count", () => {
  it("scales with the target rather than being left to the model", () => {
    assert.equal(sceneCountFor(12_000), 10);
    assert.equal(sceneCountFor(40_000), 33);
  });

  /**
   * The floor of four is a floor on architecture, and prose outranks it.
   *
   * `lbw029` at 500 words as four 125-word scenes scored the best length
   * compliance of nine systems and the worst quality of them, below a single
   * unstructured call to the same model. A scene that has to open and close inside
   * 125 words is not a scene.
   *
   * Rerunning it as a single scene scored 93.6 against 88.0 for $0.46 against
   * $1.31. This pins the structure rather than the score — one sample per arm on a
   * 1–5 quality scale says little about the size of that gap — but the direction
   * agrees with the argument.
   */
  it("yields the four-scene floor rather than slicing a short task into fragments", () => {
    assert.equal(sceneCountFor(500), 1);
    assert.equal(sceneCountFor(800), 1);
    assert.equal(sceneCountFor(1_200), 2);
  });

  /**
   * The lengths already scored must keep the scene counts they were scored with.
   * Changing them silently would invalidate every comparison in the results table
   * while looking like a pure improvement.
   */
  it("leaves every length at or above 2,000 words exactly where it was", () => {
    assert.equal(sceneCountFor(2_000), 4);
    assert.equal(sceneCountFor(2_800), 4);
    assert.equal(sceneCountFor(3_500), 4);
    assert.equal(sceneCountFor(5_000), 4);
    assert.equal(sceneCountFor(24_000), 20);
  });
});

describe("the per-scene word target", () => {
  it("is written back into the sink, because that is what the loop reads", async () => {
    // `submit_plan` cannot know the per-scene target — it is derived from the
    // task's target and the scene count — so the plan the tool stores has
    // `targetWords: 0` on every card. Returning a corrected copy and leaving
    // the sink alone was invisible until the scene loop began re-reading the
    // sink each iteration to support `update_plan`. From then on the writer was
    // told "Target length: about 0 words" on every scene of every run, and a
    // 2,800-word task came back 2,056 words long.
    const sink: { plan?: StoryPlan } = {};
    const tool = planTool(sink, 4, 2_800) as {
      execute: (id: string, args: unknown) => Promise<unknown>;
    };
    await tool.execute("1", {
      logline: "a locked room",
      entities: [{ id: "char-holt", sketch: "the detective" }],
      world_rules: [],
      narrative_person: "third person limited, Mira",
      tense: "past",
      scenes: Array.from({ length: 4 }, () => ({
        intent: "something happens",
        present: ["char-holt"],
      })),
    });
    assert.equal(sink.plan!.scenes[0]!.targetWords, 0, "the tool cannot know it");

    const returned = await planStory({
      residents: { invoke: async () => ({ text: "" }) } as never,
      premise: "a locked room",
      targetWords: 2_800,
      txid: "tx-plan",
      sink,
    });

    assert.equal(returned.scenes[0]!.targetWords, 700);
    // The load-bearing assertion: the sink and the return value are the same
    // plan, so it does not matter which one a caller happens to read.
    assert.equal(sink.plan!.scenes[0]!.targetWords, 700);
    assert.equal(sink.plan, returned);
  });
});

describe("planTool", () => {
  function tool(sceneCount = 10, targetWords = 2_800) {
    const sink: { plan?: StoryPlan } = {};
    const spec = planTool(sink, sceneCount, targetWords) as {
      execute(id: string, args: unknown): Promise<{ content: { text: string }[] }>;
    };
    return { sink, run: (args: unknown) => spec.execute("t", args) };
  }

  /**
   * Deriving the scene count is not enough on its own — the model is only *asked*
   * for about that many. On `lbw029` the difference between one scene and four was
   * the difference between a story and four 125-word fragments, and the fragments
   * cost more quality than they bought in length compliance.
   */
  it("refuses to slice a short task into scenes too small to be scenes", async () => {
    const { sink, run } = tool(1, 500);
    const reply = await run({
      logline: "A young woman leaves a small town.",
      entities: [{ id: "char-sam", sketch: "the leaver" }],
      world_rules: [],
      narrative_person: "third person limited, Mira",
      tense: "past",
      scenes: Array.from({ length: 4 }, (_, i) => ({
        intent: `beat ${i + 1}`,
        present: ["char-sam"],
      })),
    });
    assert.match(reply.content[0]!.text, /rejected/);
    assert.match(reply.content[0]!.text, /125 words each|125-word scene/);
    assert.equal(sink.plan, undefined, "nothing is stored when the plan is refused");
  });

  it("still allows more scenes than asked for when each one has room to be a scene", async () => {
    // The check is about words per scene, not about obedience. Eight scenes of a
    // 5,000-word story is twice what was asked for and 625 words each, which is a
    // scene — so the structure is the planner's call and this tool has nothing to
    // say about it.
    const { sink, run } = tool(4, 5_000);
    await run({
      logline: "A cartographer maps a city that moves at night.",
      entities: [{ id: "char-mira", sketch: "the cartographer" }],
      world_rules: [],
      narrative_person: "third person limited, Mira",
      tense: "past",
      scenes: Array.from({ length: 8 }, (_, i) => ({
        intent: `beat ${i + 1}`,
        present: ["char-mira"],
      })),
    });
    assert.equal(sink.plan!.scenes.length, 8);
  });

  const good = {
    logline: "A cartographer maps a city that moves at night.",
    entities: [
      { id: "char-mira", sketch: "the cartographer" },
      { id: "char-warden", sketch: "the record keeper" },
    ],
    world_rules: ["the city only moves unobserved"],
    narrative_person: "third person limited, Mira",
    tense: "past",
    scenes: Array.from({ length: 10 }, (_, i) => ({
      intent: `beat ${i + 1}`,
      present: ["char-mira"],
    })),
  };

  it("accepts a plan and assigns stable scene ids", async () => {
    const { sink, run } = tool();
    await run(good);
    assert.equal(sink.plan!.scenes.length, 10);
    assert.equal(sink.plan!.scenes[0]!.id, "s-001");
    assert.equal(sink.plan!.scenes[9]!.id, "s-010");
  });

  it("rejects a plan too short for the target, and says why it does not help", async () => {
    const { sink, run } = tool(10);
    const reply = await run({ ...good, scenes: good.scenes.slice(0, 3) });
    assert.equal(sink.plan, undefined);
    assert.match(reply.content[0]!.text, /too few/);
    assert.match(reply.content[0]!.text, /does not shorten the work/);
  });

  it("rejects scenes that reference entities the plan never declared", async () => {
    const { sink, run } = tool();
    const reply = await run({
      ...good,
      scenes: [...good.scenes.slice(1), { intent: "beat x", present: ["char-ghost"] }],
    });
    assert.equal(sink.plan, undefined);
    assert.match(reply.content[0]!.text, /char-ghost/);
  });

  /**
   * The shape of the 60,000-word stress test, which is where this came from: the
   * identical thirty-four ids — thirteen characters, thirteen locations, eight
   * objects — declared present in all fifty-two of its 1,200-word scenes.
   *
   * It reached scene one before anyone noticed, and it is not cosmetic. P1 of the
   * writer's packet is each present character's state and beliefs, P1 cannot be
   * evicted, and it measured 2,609 tokens against a median of ~700 in the two
   * healthy 40k runs then in flight.
   */
  const stressTest = (() => {
    const name = (i: number) => `${"abcdefghijklm"[i]}${"xyz"[i % 3]}or`;
    const chars = Array.from({ length: 13 }, (_, i) => `char-${name(i)}`);
    const locs = Array.from({ length: 13 }, (_, i) => `loc-${name(i)}vale`);
    const objs = Array.from({ length: 8 }, (_, i) => `obj-${name(i)}key`);
    const all = [...chars, ...locs, ...objs];
    return {
      logline: "A book-witch polices fictional worlds.",
      entities: all.map((id) => ({ id, sketch: "someone or somewhere" })),
      world_rules: [],
      narrative_person: "third person limited, Mira",
      tense: "past",
      scenes: Array.from({ length: 52 }, (_, i) => ({
        intent: `beat ${i + 1}`,
        present: all,
      })),
    };
  })();

  it("rejects a scene that takes place in thirteen locations at once", async () => {
    const { sink, run } = tool(52, 60_000);
    const reply = await run(stressTest);
    assert.equal(sink.plan, undefined);
    assert.match(reply.content[0]!.text, /more than 5 locations/);
    assert.match(reply.content[0]!.text, /A scene happens somewhere/);
  });

  it("rejects a plan whose every scene contains the whole cast", async () => {
    // Locations trimmed to one, so only the cast-share check can fire and this
    // test cannot pass for the wrong reason.
    const { sink, run } = tool(52, 60_000);
    const reply = await run({
      ...stressTest,
      scenes: stressTest.scenes.map((s) => ({
        ...s,
        present: s.present.filter((id) => !id.startsWith("loc-") || id.endsWith("axorvale")),
      })),
    });
    assert.equal(sink.plan, undefined);
    assert.match(reply.content[0]!.text, /median scene lists/);
    assert.match(reply.content[0]!.text, /has not decided anything/);
  });

  /**
   * The guard has to leave a small cast alone. A ten-scene story about one person
   * has identical rosters in every scene because its cast really is one person,
   * which is why this is stated as a share of the whole roster and floored on
   * roster size rather than measured as similarity between scenes.
   */
  /**
   * The packet's voice constraint cites `novel/style/voice.md`, and that file held
   * the seed note saying the opposite — that voice is settled by the first scenes
   * and the writer may propose changes. The verifier's brief sends it to this file
   * by name to check register drift, which is seven of the nine consistency errors
   * measured in the first 20,000-word manuscript.
   */
  it("writes the declared voice to the file everything is told to read", async () => {
    const { sink, run } = tool();
    await run({ ...good, narrative_person: "first person, Rue", tense: "past" });
    const voice = planFiles(sink.plan!, "a premise").find((f) =>
      f.relPath.endsWith("novel/style/voice.md"),
    );
    assert.ok(voice, "the plan projects a voice file");
    assert.match(voice!.content, /first person, Rue/);
    assert.match(voice!.content, /past tense/);
    assert.doesNotMatch(voice!.content, /may propose changes/);
  });

  /**
   * The declaration the 40,000-word historical cell actually submitted. It passes
   * every other check and still leaves no sentence checkable: under it, either
   * woman's head is correct anywhere, including mid-paragraph — which is what the
   * detector reports as `perspective_confusions`.
   */
  it("refuses an alternating viewpoint that does not say where it may switch", async () => {
    const { sink, run } = tool();
    const reply = await run({
      ...good,
      narrative_person: "third person limited, alternating between the Queen and the Actress",
    });
    assert.equal(sink.plan, undefined);
    assert.match(reply.content[0]!.text, /where it is allowed to switch/);
    assert.match(reply.content[0]!.text, /perspective_confusions/);
  });

  it("accepts alternation once the unit that owns a viewpoint is named", async () => {
    const { sink, run } = tool();
    await run({
      ...good,
      narrative_person:
        "third person limited, one viewpoint per scene, alternating between the Queen and the Actress",
    });
    assert.ok(sink.plan, "a located alternation is a legitimate technique, not a defect");
    assert.match(sink.plan!.voice.person, /one viewpoint per scene/);
  });

  /**
   * The chapter-length arm, at the derivation that produces it. A scene is the
   * unit of one packet, one writer call, one verifier pass and one commit, so
   * asking for 3,600-word scenes runs a third as many of all four.
   */
  it("derives a third as many scenes when a scene is asked to be three times as long", () => {
    assert.equal(sceneCountFor(40_000), 33);
    assert.equal(sceneCountFor(40_000, 3_600), 11);
    assert.equal(sceneCountFor(20_000, 3_600), 6);
  });

  /**
   * The floor still binds. A 500-word task cannot become one 3,600-word scene,
   * and it must not become four 125-word ones either — that arm took the best
   * length score in its table and the worst quality in it.
   */
  it("lets an explicit scene length outrank the floor of four", () => {
    // The bug this pins: the floor is unconditional, so a 2,000-word task asked
    // for 3,600-word scenes came back with 4 — the control's plan exactly. Every
    // LongBench-Write task is 500 to 3,500 words, so the whole arm would have
    // measured as "no effect" on that bench.
    assert.equal(sceneCountFor(2_000, 3_600), 1);
    assert.equal(sceneCountFor(500, 3_600), 1);
    // The default keeps its floor: 2,000 words wants ~1.7 scenes and gets 4.
    assert.equal(sceneCountFor(2_000), 4);
    // And the 500-word affordability floor still binds in both modes.
    assert.equal(sceneCountFor(500), 1);
  });

  it("leaves a genuinely small cast alone", async () => {
    const { sink, run } = tool();
    await run(good);
    assert.equal(sink.plan!.scenes.length, 10);
  });

  /**
   * And it has to leave short plans alone at any share: a four-scene story
   * legitimately used up to 81% of its roster per scene across every run scored
   * so far, and those are the runs the table is built on.
   */
  it("leaves a four-scene plan alone even when every scene holds the whole cast", async () => {
    const all = Array.from({ length: 12 }, (_, i) => `char-${"abcdefghijkl"[i]}quor`);
    const { sink, run } = tool(4, 2_800);
    await run({
      logline: "A locked room.",
      entities: all.map((id) => ({ id, sketch: "a suspect" })),
      world_rules: [],
      narrative_person: "third person limited, Holt",
      tense: "past",
      scenes: Array.from({ length: 4 }, (_, i) => ({ intent: `beat ${i + 1}`, present: all })),
    });
    assert.equal(sink.plan!.scenes.length, 4);
  });
});
