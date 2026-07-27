import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BuilderBus, askBuilderTool } from "./packet-builder.ts";

/** The tools are plain objects with an `execute`; call them the way the agent does. */
function toolNamed(tools: unknown[], name: string) {
  const tool = (tools as { name: string; execute: (id: string, args: never) => Promise<unknown> }[])
    .find((t) => t.name === name);
  assert.ok(tool, `${name} is not registered`);
  return tool;
}

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
}

describe("the writer's follow-up allowance", () => {
  /**
   * The defect this pins, measured on `runs/v062/lbw081` s-001.
   *
   * The allowance was metered by counting `answer_writer` calls, and that tool is
   * on the builder's allowlist permanently — so during its *initial* build, with no
   * question outstanding, the builder called it unprompted. The count reached one,
   * the opening tier's allowance is one, and the writer's first and only question
   * came back "no follow-ups left". It wrote the scene without the fact it asked
   * for and said so in its closing message.
   *
   * The reason no test caught it and no summary showed it: the spontaneous call was
   * recorded *as* a follow-up, so `follow_ups.by_tier` reported the mechanism as
   * used. A count that both meters a budget and records that the budget was used
   * cannot distinguish "spent" from "spent on nothing".
   */
  it("cannot be spent by the builder before the writer asks", async () => {
    const bus = new BuilderBus();
    bus.open("s-001");
    const answer = toolNamed(bus.tools(), "answer_writer");

    const refused = textOf(
      await answer.execute("call-1", {
        question: "what time did the watch stop?",
        answer: "11:42, from events/timeline.jsonl",
      } as never),
    );
    assert.match(refused, /no follow-up is outstanding/);
    assert.match(refused, /add_context_item/);
    assert.equal(bus.contribution().followUps.length, 0);
  });

  it("accepts an answer once a question is outstanding, and only one", async () => {
    const bus = new BuilderBus();
    bus.open("s-001");
    bus.expect("what time did the watch stop?");
    const answer = toolNamed(bus.tools(), "answer_writer");

    const args = {
      question: "what time did the watch stop?",
      answer: "11:42, from events/timeline.jsonl",
    } as never;
    assert.match(textOf(await answer.execute("call-1", args)), /answered/);
    assert.equal(bus.contribution().followUps.length, 1);

    // The pending flag clears with the answer, so a second call is unsolicited
    // again — one question, one answer, one unit of the allowance.
    assert.match(textOf(await answer.execute("call-2", args)), /no follow-up is outstanding/);
    assert.equal(bus.contribution().followUps.length, 1);
  });

  it("clears an unanswered question when the next scene opens", async () => {
    const bus = new BuilderBus();
    bus.open("s-001");
    bus.expect("what time did the watch stop?");
    bus.open("s-002");
    const answer = toolNamed(bus.tools(), "answer_writer");
    assert.match(
      textOf(await answer.execute("call-1", { question: "q", answer: "a" } as never)),
      /no follow-up is outstanding/,
    );
  });
});

describe("ask_context_builder", () => {
  it("reports the count and the allowance separately when refusing", async () => {
    // The old wording printed the allowance where it meant the count, so a refusal
    // caused by a bug elsewhere read as a writer that had used up its questions —
    // which is exactly how the defect above stayed invisible.
    const tool = toolNamed(
      [
        askBuilderTool({
          ask: async () => "unused",
          roundsUsed: () => 3,
          maxRounds: () => 1,
        }),
      ] as unknown[],
      "ask_context_builder",
    );
    const refused = textOf(await tool.execute("call-1", { question: "q" } as never));
    assert.match(refused, /3 of 1 used/);
  });

  it("reads the allowance at call time, not at construction", async () => {
    // The writer is resident, so its tools are built once. A limit captured then
    // would police scene 40 with scene 1's allowance.
    let allowance = 0;
    const asked: string[] = [];
    const tool = toolNamed(
      [
        askBuilderTool({
          ask: async (q) => {
            asked.push(q);
            return "answer";
          },
          roundsUsed: () => 0,
          maxRounds: () => allowance,
        }),
      ] as unknown[],
      "ask_context_builder",
    );

    assert.match(textOf(await tool.execute("c1", { question: "q1" } as never)), /no follow-ups/);
    allowance = 2;
    assert.equal(textOf(await tool.execute("c2", { question: "q2" } as never)), "answer");
    assert.deepEqual(asked, ["q2"]);
  });
});

describe("add_context_item", () => {
  /**
   * The defect this pins, from `runs-070/lnb20k-fantasy-the-girl-with-a-thousand-faces`.
   *
   * The builder added 93 items on that run and four cited no file at all, two of
   * them literally `source: "synthetic"`. Their contents were invented world
   * material handed to the writer as established — *"Canonical behaviors when a
   * ritual 'goes wrong'…"*, *"Practical use in scene: Mercy finds a faded portrait
   * in a token stall…"* — and nothing in the index says either. The tool checked
   * only that `source` was non-empty, so a fabricated provenance passed.
   *
   * The channel for "the index does not contain this" already existed: `note_gap`.
   * The difference is where the invention gets recorded — a gap tells the writer it
   * is free and what it then invents lands in the state delta as a decision, where
   * a composed item is defended by every later scene as though established.
   */
  const bus = () => {
    const b = new BuilderBus();
    b.open("s-001");
    b.checkSourcesWith((s) => s.startsWith("objects/") || s.startsWith("novel/"));
    return b;
  };

  const add = (b: BuilderBus) => toolNamed(b.tools(), "add_context_item");

  it("refuses an item whose source is not a file in the project", async () => {
    const b = bus();
    const out = textOf(
      await add(b).execute("c1", {
        id: "s001-sensory",
        priority: "P4",
        source: "synthetic",
        content: "Smell: damp and mildew, frying oil, incense low on still days.",
      } as never),
    );
    assert.match(out, /is not a file in this project/);
    assert.match(out, /note_gap/);
    assert.equal(b.contribution().items.length, 0);
  });

  it("accepts an item that cites a real path", async () => {
    const b = bus();
    const out = textOf(
      await add(b).execute("c1", {
        id: "s001-knife",
        priority: "P3",
        source: "objects/obj-spirit-knife.yaml",
        content: "A short iron blade, handle wrapped in red thread.",
      } as never),
    );
    assert.doesNotMatch(out, /rejected/);
    assert.equal(b.contribution().items.length, 1);
  });

  it("tolerates a line range or a note after the path", async () => {
    // Refusing these would push the builder towards bare paths and lose the span,
    // which is the part that makes a citation checkable.
    const b = bus();
    for (const source of [
      "objects/obj-spirit-knife.yaml:12-18",
      "novel/chapters/ch-01/scenes/s-001.md (closing paragraph)",
    ]) {
      const out = textOf(
        await add(b).execute("c1", {
          id: `item-${source.length}`,
          priority: "P3",
          source,
          content: "something real",
        } as never),
      );
      assert.doesNotMatch(out, /rejected/, source);
    }
  });

  it("still refuses P0 and P1, and an empty source", async () => {
    const b = bus();
    assert.match(
      textOf(
        await add(b).execute("c1", {
          id: "x",
          priority: "P0",
          source: "objects/obj-spirit-knife.yaml",
          content: "c",
        } as never),
      ),
      /priority must be P2, P3 or P4/,
    );
    assert.match(
      textOf(
        await add(b).execute("c2", { id: "x", priority: "P3", source: "  ", content: "c" } as never),
      ),
      /source is required/,
    );
  });
});
