/**
 * What does a pi message actually look like?
 *
 * The compaction policy classifies messages by inspecting their content blocks,
 * and that classification was written from the type declarations rather than
 * from a real transcript. If it is wrong, level 1 evicts nothing and the whole
 * policy is decoration that passes its unit tests.
 *
 * This runs one real tool round trip and prints the structure, so the mapping
 * can be checked against the thing it maps.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { installGateway } from "../src/runtime/gateway.ts";

const gateway = installGateway();

const agent = new Agent({
  initialState: {
    systemPrompt: "Use the tool, then answer in one short sentence.",
    model: gateway.model("gpt-5-mini") as never,
    thinkingLevel: "off",
    tools: [
      {
        label: "Read canon",
        name: "read_canon",
        description: "Read a character's canon record.",
        parameters: Type.Object({ character: Type.String() }),
        execute: async () => ({
          content: [{ type: "text", text: "eye_colour: grey\nage: 29" }],
        }),
      },
    ],
  },
} as never);

await (agent as unknown as { prompt(s: string): Promise<unknown> }).prompt(
  "Look up Mira and tell me her eye colour.",
);

const messages = (agent as unknown as { state: { messages: unknown[] } }).state.messages;

console.log(
  JSON.stringify(
    messages.map((m) => {
      const msg = m as { role: string; content: unknown; usage?: unknown };
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      return {
        role: msg.role,
        content_is_array: Array.isArray(msg.content),
        block_types: blocks.map((b) => (b as { type?: string }).type),
        block_keys: blocks.map((b) => Object.keys(b as object)),
        has_usage: Boolean(msg.usage),
      };
    }),
    null,
    2,
  ),
);

// The exact shape of whichever message carries the tool's return value.
const toolish = messages.find((m) => {
  const blocks = Array.isArray((m as { content: unknown }).content)
    ? ((m as { content: unknown[] }).content as { type?: string }[])
    : [];
  return (
    (m as { role: string }).role === "toolResult" ||
    blocks.some((b) => b.type === "toolResult")
  );
});
console.log("\n--- the message carrying a tool result ---");
console.log(JSON.stringify(toolish, null, 2).slice(0, 1500));
