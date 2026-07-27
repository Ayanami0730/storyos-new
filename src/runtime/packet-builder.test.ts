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
