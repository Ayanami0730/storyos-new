import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SceneToolBus, copiedFromPacket } from "./collaborators.ts";

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

describe("copiedFromPacket", () => {
  /**
   * The manuscript that made this necessary, quoted from `runs-070/lbw081`.
   *
   * It scored 78.6 where the previous version scored 81.5, with Reading Experience
   * at 2 — the lowest mark on any dimension in any of our runs — and the cause is
   * in the first four paragraphs: two object-file lines, in quotation marks, in the
   * narration. The second names "a time relevant to establishing the minute of
   * death", which is registry language about why a fact matters to an
   * investigation and cannot occur in fiction.
   *
   * The verifier found it and filed it correctly as a craft warning. A warning does
   * not block, so it shipped — which is why this is a refusal at the tool boundary
   * and not another paragraph of prompt.
   */
  const packet = [
    "## P1 — objects",
    "obj-watch: Victor's gold pocket watch found stopped on his person; the minute hand bent",
    "and the watch stopped at a time relevant to establishing the minute of death.",
  ].join("\n");

  it("catches an index line pasted into the prose", () => {
    const prose =
      'On his person lay his watch — gold, small, ruined in one graceful way: "Victor\'s gold ' +
      'pocket watch found stopped on his person; the minute hand bent and the watch stopped ' +
      'at a time relevant to establishing the minute of death." The watch had indeed stopped.';
    const copied = copiedFromPacket(prose, packet);
    assert.ok(copied, "the pasted registry line should be caught");
    assert.match(copied!, /gold pocket watch found stopped/);
  });

  it("leaves prose that shares only short phrases alone", () => {
    // A name, a repeated noun, a remembered line of dialogue: all legitimate, and
    // all well short of twelve consecutive words.
    const prose =
      "Victor's watch had stopped. I turned it over in my palm and felt the cold of it, and " +
      "the bent minute hand said nine-fourteen to anyone who would listen.";
    assert.equal(copiedFromPacket(prose, packet), null);
  });

  it("is not fooled by quotation marks or case", () => {
    const prose =
      "the minute hand bent and the watch stopped AT A TIME relevant to establishing the " +
      "minute of death";
    assert.ok(copiedFromPacket(prose, packet));
  });

  it("does nothing when there is no packet to compare against", () => {
    assert.equal(copiedFromPacket("any prose at all, of any length whatsoever here", ""), null);
  });

  it("refuses the staged scene rather than only reporting it", async () => {
    const bus = new SceneToolBus();
    const capture = bus.open("s-001");
    capture.packetText = packet;
    const tool = (bus.toolsFor("writer") as {
      name: string;
      execute: (id: string, args: never) => Promise<{ content: { text: string }[] }>;
    }[]).find((t) => t.name === "write_staged_scene")!;

    const result = await tool.execute("t1", {
      prose:
        "He lay there: Victor's gold pocket watch found stopped on his person; the minute hand " +
        "bent and the watch stopped at a time relevant to establishing the minute of death.",
    } as never);
    assert.match(result.content[0]!.text, /^rejected: this passage is copied verbatim/);
    assert.equal(capture.prose, undefined, "nothing may be staged");
  });
});
