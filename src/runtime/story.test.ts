import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CanonFact } from "../verification/deterministic.ts";
import { type StoryPlan, absorb, contextFor, planTool, sceneCountFor } from "./story.ts";

const plan: StoryPlan = {
  logline: "A cartographer maps a city that moves at night.",
  entities: [
    { id: "char-mira", sketch: "the cartographer" },
    { id: "char-warden", sketch: "keeps the harbour records" },
    { id: "loc-harbour", sketch: "where the ships do not move" },
  ],
  worldRules: ["the city only moves when nobody is watching"],
  scenes: [
    { id: "s-001", intent: "Mira notices the discrepancy", presentEntities: ["char-mira"], targetWords: 1200 },
  ],
};

describe("scene count", () => {
  it("scales with the target rather than being left to the model", () => {
    assert.equal(sceneCountFor(12_000), 10);
    assert.equal(sceneCountFor(40_000), 33);
  });

  it("never proposes a story of one or two scenes", () => {
    assert.equal(sceneCountFor(500), 4);
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

describe("contextFor", () => {
  const canon: readonly CanonFact[] = [
    { id: "f1", entity: "char-mira", attribute: "eye_colour", value: "grey", source: "s-001" },
    { id: "f2", entity: "char-warden", attribute: "location", value: "the tower", source: "s-002" },
  ];

  it("puts the scene card, logline, roster and world rules in P0", () => {
    const items = contextFor({
      card: plan.scenes[0]!,
      plan,
      canon: [],
      previousProse: null,
      earlierIntents: [],
    });
    const p0 = items.filter((i) => i.priority === "P0").map((i) => i.id);
    assert.deepEqual(p0, ["scene-card", "logline", "entity-roster", "world-rules"]);
  });

  it("names every entity that exists, not only the ones in this scene", () => {
    // Without the roster the writer is told to feature a character it has been
    // given nothing about — scene 1's intent said Elias met Mira while `present`
    // listed neither — so it invents an id and the verifier rejects the scene
    // for entities that were in the plan all along.
    const roster = contextFor({
      card: plan.scenes[0]!,
      plan,
      canon: [],
      previousProse: null,
      earlierIntents: [],
    }).find((i) => i.id === "entity-roster")!;
    for (const entity of plan.entities) assert.match(roster.content, new RegExp(entity.id));
    assert.match(roster.content, /rather than inventing an id/);
  });

  it("cites paths that exist in the tree", () => {
    // Provenance that cannot be opened is worse than none: the verifier greps
    // the citation, finds nothing, and spends its budget rediscovering the
    // layout before it can check anything.
    const items = contextFor({
      card: plan.scenes[0]!,
      plan,
      canon,
      previousProse: null,
      earlierIntents: [],
    });
    for (const item of items) {
      assert.doesNotMatch(item.source, /^index\/story\//, `${item.id} cites a removed path`);
    }
    assert.equal(
      items.find((i) => i.id === "entity-char-mira")!.source,
      "characters/char-mira/profile.yaml",
    );
  });

  it("gives P1 the current facts of present entities, and only those entities", () => {
    const items = contextFor({
      card: plan.scenes[0]!,
      plan,
      canon,
      previousProse: null,
      earlierIntents: [],
    });
    const p1 = items.filter((i) => i.priority === "P1");
    assert.deepEqual(p1.map((i) => i.id), ["entity-char-mira"]);
    assert.match(p1[0]!.content, /eye_colour: grey {2}\(from s-001\)/);
    // The warden is not in this scene; a packet listing everyone gets skimmed.
    assert.ok(!items.some((i) => i.content.includes("the tower")));
  });

  it("says plainly when an entity has no facts yet, rather than omitting it", () => {
    const items = contextFor({
      card: plan.scenes[0]!,
      plan,
      canon: [],
      previousProse: null,
      earlierIntents: [],
    });
    assert.match(
      items.find((i) => i.id === "entity-char-mira")!.content,
      /no facts established yet/,
    );
  });

  it("carries the previous scene verbatim in P2 and earlier beats only in P3", () => {
    const items = contextFor({
      card: plan.scenes[0]!,
      plan,
      canon,
      previousProse: "She folded the chart.",
      earlierIntents: ["Mira arrives", "the warden lies"],
    });
    assert.equal(items.find((i) => i.id === "previous-scene")!.priority, "P2");
    assert.equal(items.find((i) => i.id === "story-so-far")!.priority, "P3");
    assert.match(items.find((i) => i.id === "story-so-far")!.content, /1\. Mira arrives/);
  });
});

describe("absorb", () => {
  it("adds new facts", () => {
    const canon = absorb([], "s-001", {
      claims: [{ entity: "char-mira", attribute: "mood", value: "wary" }],
    });
    assert.equal(canon.length, 1);
    assert.equal(canon[0]!.source, "s-001");
  });

  it("replaces a fact in place and moves its source to the scene that changed it", () => {
    const first = absorb([], "s-001", {
      claims: [{ entity: "char-mira", attribute: "location", value: "the harbour" }],
    });
    const second = absorb(first, "s-004", {
      claims: [{ entity: "char-mira", attribute: "location", value: "the tower" }],
    });
    assert.equal(second.length, 1);
    assert.equal(second[0]!.value, "the tower");
    // Source must follow the current value, or a later contradiction points at
    // a scene that no longer says what the fact claims.
    assert.equal(second[0]!.source, "s-004");
  });

  it("keeps different attributes of the same entity apart", () => {
    const canon = absorb([], "s-001", {
      claims: [
        { entity: "char-mira", attribute: "location", value: "the harbour" },
        { entity: "char-mira", attribute: "mood", value: "wary" },
      ],
    });
    assert.equal(canon.length, 2);
  });
});
