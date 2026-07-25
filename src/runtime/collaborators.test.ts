import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SceneToolBus } from "./collaborators.ts";

interface Tool {
  name: string;
  execute: (id: string, args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

function writerTool(name: string): Tool {
  const bus = new SceneToolBus();
  bus.open("s-003");
  return (bus.toolsFor("writer") as Tool[]).find((t) => t.name === name)!;
}

const claim = {
  entity: "char-mira",
  attribute: "knows_about_the_shifts",
  value: "true",
  quote: "She said it aloud for the first time: the streets move.",
};

describe("what a state delta may claim", () => {
  it("refuses an attribute that names what happened rather than what is true", async () => {
    // From runs/v2-generous: `action` was filed as a property in two
    // consecutive scenes, the continuity check correctly saw a property change
    // value, and a scene in which nothing was actually wrong was rejected. The
    // cheapest place to stop that is here, one turn before it becomes a
    // finding that reads exactly like a real continuity failure.
    const tool = writerTool("propose_state_delta");
    const result = await tool.execute("t1", {
      claims: [{ ...claim, attribute: "action", value: "climbed the lighthouse stairs" }],
      present_entities: ["char-mira"],
    });
    assert.match(result.content[0]!.text, /^rejected:/);
    assert.match(result.content[0]!.text, /names what happened, not a property/);
  });

  it("refuses the same shape however it is spelt", async () => {
    const tool = writerTool("propose_state_delta");
    for (const attribute of ["Last Action", "current_activity", "recent-events", "did"]) {
      const result = await tool.execute("t1", {
        claims: [{ ...claim, attribute }],
        present_entities: [],
      });
      assert.match(result.content[0]!.text, /^rejected:/, attribute);
    }
  });

  it("accepts what the event left behind", async () => {
    const tool = writerTool("propose_state_delta");
    for (const attribute of ["location", "holds", "knows_about_the_shifts", "reaction_to_elias"]) {
      const result = await tool.execute("t1", {
        claims: [{ ...claim, attribute }],
        present_entities: [],
      });
      assert.match(result.content[0]!.text, /^accepted/, attribute);
    }
  });

  it("reports every problem in the delta at once", async () => {
    const tool = writerTool("propose_state_delta");
    const result = await tool.execute("t1", {
      claims: [
        { ...claim, attribute: "action", quote: "" },
        { ...claim, entity: "" },
      ],
      present_entities: [],
    });
    const text = result.content[0]!.text;
    assert.match(text, /claims\[0\]\.quote/);
    assert.match(text, /claims\[0\]\.attribute/);
    assert.match(text, /claims\[1\]\.entity/);
  });
});
