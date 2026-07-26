import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type StoryPlan, planStory, planTool, sceneCountFor } from "./plan.ts";

describe("scene count", () => {
  it("scales with the target rather than being left to the model", () => {
    assert.equal(sceneCountFor(12_000), 10);
    assert.equal(sceneCountFor(40_000), 33);
  });

  it("never proposes a story of one or two scenes", () => {
    assert.equal(sceneCountFor(500), 4);
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
    const tool = planTool(sink, 4) as {
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
  function tool(sceneCount = 10) {
    const sink: { plan?: StoryPlan } = {};
    const spec = planTool(sink, sceneCount) as {
      execute(id: string, args: unknown): Promise<{ content: { text: string }[] }>;
    };
    return { sink, run: (args: unknown) => spec.execute("t", args) };
  }

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
