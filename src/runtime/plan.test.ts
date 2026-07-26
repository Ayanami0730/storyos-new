import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type StoryPlan, planStory, planTool, sceneCountFor } from "./plan.ts";

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
});
