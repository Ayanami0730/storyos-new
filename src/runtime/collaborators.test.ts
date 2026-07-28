import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SceneToolBus,
  copiedFromPacket,
  harnessAnnotation,
  residentCollaborators,
} from "./collaborators.ts";
import { allocate } from "./allocation.ts";

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

describe("harness notes left in the manuscript", () => {
  /**
   * All five shapes are from one finished manuscript, where ten of them reached
   * the page and the frozen consistency judge charged every one as
   * `style_shifts` — the largest subtype in the audit, 30 of 87 kept instances.
   */
  it("catches the shapes that were measured on the page", () => {
    for (const prose of [
      "Above, a plaque caught the light. [staging folio A-0001 — Gate Ritual and Plaque]",
      "The Tall Clerk [bracketed provenance: unnamed in builder] said the id aloud.",
      "The press had a modest sound, the same as Rue had felt [see s-001].",
      "(staging: invented by writer — debt amount specified as 'twelve crowns'.)",
      "The press_podium gave her a footing and she did not look away.",
      "She lifted char-rue's letter from the folder.",
    ]) {
      assert.ok(harnessAnnotation(prose), `should have been refused: ${prose}`);
    }
  });

  it("leaves fiction that merely uses brackets alone", () => {
    // Narrow on purpose: fiction uses parentheses and asides, and a check that
    // refused them would cost far more than the defect.
    for (const prose of [
      "She counted the coins (there were twelve) and pushed them across the table.",
      "The letter — unsigned, undated — lay where he had dropped it.",
      "He said it twice, the second time more quietly, as though to himself.",
      "A well-worn, hand-me-down coat hung by the door.",
    ]) {
      assert.equal(harnessAnnotation(prose), null, `should have passed: ${prose}`);
    }
  });
});

describe("a writer that will not stage anything", () => {
  /**
   * Why clearing the session is the fix rather than another ask.
   *
   * Measured on `lbw081-ch`: the writer replied *"I'm sorry, but I cannot assist
   * with that request"* **eight times** — four scene attempts times the two asks
   * each makes — and the scene was lost. The same task on the same backbone had
   * delivered 2,679 words at attainment 0.96 two versions earlier, so the refusal
   * was a state the conversation reached, and every retry inside it drew the same
   * reply. The retry was already there; what it inherited was the problem.
   */
  it("clears the writer's session so the retry does not inherit the refusal", async () => {
    const resets: string[] = [];
    let asks = 0;
    const { collaborators } = residentCollaborators({
      residents: {
        invoke: async () => {
          asks += 1;
          return { text: "I'm sorry, but I cannot assist with that request." };
        },
        resetSession: (role: string) => resets.push(role),
      } as never,
      sceneId: "s-001",
      txid: "tx-s-001",
    });

    await assert.rejects(
      collaborators.draft({
        packet: { rendered: "a packet" } as never,
        attempt: 0,
        repairBrief: "",
        allocation: allocate({ sceneIndex: 0, total: 4 }),
      } as never),
      /session has been cleared/,
    );
    assert.equal(asks, 2, "it asks twice before giving up, as before");
    assert.deepEqual(resets, ["writer"]);
  });
});
