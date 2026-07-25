/**
 * Foundation smoke test: does pi's agent loop drive OUR gateway with native
 * function calling?
 *
 * The built-in openaiProvider() targets /v1/responses, which our gateway
 * returns 404 for, so we register a custom provider pinned to
 * api: "openai-completions".
 */

import { installProxyFromEnv } from "./proxy-setup.mjs";
import { Agent, setDefaultStreamFn } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Type } from "typebox";

const proxy = installProxyFromEnv();
const BASE_URL = "https://ai-prod-sg.wenxiaobai.com/v1";

const model = {
  id: "gpt-5-mini",
  name: "GPT-5 mini (yuanshi SG gateway)",
  api: "openai-completions",
  provider: "yuanshi-sg",
  baseUrl: BASE_URL,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 400000,
  maxTokens: 128000,
};

const provider = createProvider({
  id: "yuanshi-sg",
  name: "YuanShi Singapore gateway",
  baseUrl: BASE_URL,
  auth: { apiKey: envApiKeyAuth("YuanShi gateway key", ["YS_KEY"]) },
  models: [model],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(provider);

// Agent's default stream function targets nothing; route it at our Models
// collection so provider auth + openai-completions transport are used.
setDefaultStreamFn((m, context, options) => models.stream(m, context, options));

const calls = [];

const readCanonSchema = Type.Object({
  character: Type.String({ description: "Character name to look up" }),
});

const readCanon = {
  label: "Read canon",
  name: "read_canon",
  description: "Read the committed canon facts for one character from the narrative index.",
  parameters: readCanonSchema,
  execute: async (_toolCallId, args) => {
    calls.push({ tool: "read_canon", args });
    return {
      output: JSON.stringify({
        character: args.character,
        facts: [
          "sceneRange 1-4: stranger to Mara",
          "sceneRange 5-9: mentor to Mara",
          "sceneRange 10-: estranged from Mara",
        ],
      }),
    };
  },
};

const agent = new Agent({
  initialState: {
    systemPrompt:
      "You are the context builder for a novel-writing harness. " +
      "When asked about a character, you MUST call read_canon before answering. " +
      "Then answer in one sentence.",
    model: models.getModel("yuanshi-sg", "gpt-5-mini"),
    thinkingLevel: "off",
    tools: [readCanon],
  },
});

const started = Date.now();
await agent.prompt("What is Ilya's relationship history with Mara? Look it up.");

const messages = agent.state.messages;
const toolCallBlocks = messages.flatMap((m) =>
  (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === "toolCall"),
);
const finalText = messages
  .filter((m) => m.role === "assistant")
  .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  .filter((c) => c.type === "text")
  .map((c) => c.text)
  .join(" ")
  .trim();

console.log(
  JSON.stringify(
    {
      elapsed_ms: Date.now() - started,
      tool_calls_seen_by_loop: toolCallBlocks.length,
      tools_actually_executed: calls,
      final_text: finalText.slice(0, 400),
      message_roles: messages.map((m) => m.role),
      verdict:
        calls.length > 0 && finalText.length > 0
          ? "PASS: gateway + native function calling + pi agent loop all work"
          : "FAIL: loop did not complete a tool round trip",
    },
    null,
    2,
  ),
);
