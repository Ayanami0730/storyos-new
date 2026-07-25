/**
 * Does a tool's return value actually reach the model?
 *
 * The foundation smoke test checked that a tool was *called* and that some text
 * came back. It never checked that the model could see what the tool returned —
 * so a broken result path would have passed it. This asks the one question that
 * distinguishes them: a secret only obtainable from the tool.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { installGateway } from "../src/runtime/gateway.ts";

const SECRET = "vermilion";
const gateway = installGateway();

const shapes: Record<string, (v: string) => unknown> = {
  "object {output}": (v) => ({ output: v }),
  "bare string": (v) => v,
  "object {content:[{type:text}]}": (v) => ({ content: [{ type: "text", text: v }] }),
};

for (const [label, wrap] of Object.entries(shapes)) {
  let called = false;
  const agent = new Agent({
    initialState: {
      systemPrompt:
        "Answer using the tools. Never guess; if a tool gives you a value, repeat it exactly.",
      model: gateway.model("gpt-5-mini") as never,
      thinkingLevel: "off",
      tools: [
        {
          label: "Read canon",
          name: "read_canon",
          description: "Read a character's canon record.",
          parameters: Type.Object({ character: Type.String() }),
          execute: async (_id: string, _args: unknown) => {
            called = true;
            return wrap(`eye_colour: ${SECRET}`) as never;
          },
        },
      ],
    },
  } as never);

  let error: string | null = null;
  try {
    await (agent as unknown as { prompt(s: string): Promise<unknown> }).prompt(
      "What is Mira's eye colour? Look it up with read_canon and answer with just the colour.",
    );
  } catch (e) {
    error = String(e).slice(0, 120);
  }

  const text = (agent as unknown as { state: { messages: readonly unknown[] } }).state.messages
    .filter((m) => (m as { role: string }).role === "assistant")
    .flatMap((m) => {
      const c = (m as { content: unknown }).content;
      return Array.isArray(c) ? c : [];
    })
    .filter((c) => (c as { type?: string }).type === "text")
    .map((c) => (c as { text: string }).text)
    .join(" ");

  console.log(
    JSON.stringify({
      shape: label,
      tool_called: called,
      model_saw_the_value: text.toLowerCase().includes(SECRET),
      answer: text.slice(0, 120),
      error,
    }),
  );
}
