# StoryOS v3 foundation — validated facts

Everything below was measured on 2026-07-25, not inferred from docs.

## Runtime choice

Built on the published pi packages (`0.82.0`, newer than the local `pi-mono`
checkout at `0.80.6`):

- `@earendil-works/pi-agent-core` — `Agent`, the tool loop, `setDefaultStreamFn`
- `@earendil-works/pi-ai` — provider/model abstraction, `openai-completions` transport
- `typebox` — tool parameter schemas
- `undici` — proxy dispatcher (see gotcha 2)

`@earendil-works/pi-coding-agent` adds sessions/compaction/skills/file tools and
is the intended base for the resident agents; the smoke test stays on
`pi-agent-core` to keep the failure surface small.

## Gotcha 1 — the gateway has no Responses API

`POST /v1/responses` returns **404** for both `gpt-5-mini` and `gpt-5.5`.
pi's built-in `openaiProvider()` hardcodes `api: "openai-responses"`, so it
cannot be reused by only swapping `baseUrl`. Register a custom provider pinned
to `openai-completions` instead:

```js
const model = {
  id: "gpt-5-mini",
  api: "openai-completions",          // required; not "openai-responses"
  provider: "yuanshi-sg",
  baseUrl: "https://ai-prod-sg.wenxiaobai.com/v1",
  reasoning: true,
  contextWindow: 400000,
  maxTokens: 128000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  input: ["text"],
};

const provider = createProvider({
  id: "yuanshi-sg",
  baseUrl: model.baseUrl,
  auth: { apiKey: envApiKeyAuth("YuanShi gateway key", ["YS_KEY"]) },
  models: [model],
  api: openAICompletionsApi(),
});
```

`Agent` also needs its stream function routed at the `Models` collection,
otherwise construction throws `No default stream function configured`:

```js
setDefaultStreamFn((m, context, options) => models.stream(m, context, options));
```

## Gotcha 2 — Node ignores the proxy that curl uses

The gateway rejects mainland-China IPs:

```
403 {"code":"access_denied","message":"Access denied: this service is not
available from mainland China IPs"}
```

curl succeeds because it honours `https_proxy`; Node's fetch (undici) does not
read proxy env vars, so it dials direct and gets the 403. Every entry point must
install a global dispatcher first:

```js
import { ProxyAgent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new ProxyAgent(process.env.https_proxy));
```

This is the single most confusing failure mode: identical requests work from the
shell and fail from Node with an error that blames geography rather than config.

## Validated capability

`smoke/gateway-tool-loop.mjs` drives one agent with a `read_canon` tool:

```
tool_calls_seen_by_loop: 2
tools_actually_executed:  [{read_canon, {character: "Ilya"}}, ...]
message_roles: user → assistant → toolResult → assistant → toolResult → assistant
elapsed_ms: 11893
```

So native multi-turn function calling works end to end through the gateway with
`gpt-5-mini`. The v2 engine's "no tool schema, single JSON contract per call"
design was a choice, not a platform limit.

Run it with:

```bash
YS_KEY="$(security find-generic-password -s ai.metastone.yuanshi-api -a ayanami -w)" \
  node smoke/gateway-tool-loop.mjs
```

## What pi gives us vs what we must build

Out of the box: the tool loop, native function calling against a custom
gateway, TypeBox schemas with validation, `read/write/edit/bash/grep/find/ls`,
per-agent system prompt + model + tool allowlist, JSONL sessions with
fork/resume, automatic compaction with overflow retry, and `SKILL.md`
discovery.

We must build: the five-persona registry of long-lived sessions,
agent-to-agent tools that route into that registry (pi's `subagent` example
spawns throwaway processes with `--no-session`, which is the opposite of
resident agents), the shared filesystem index with locking and versioning, the
`memory/` convention and its injection rules, the percentage-based two-tier
compaction policy (pi compacts on `contextTokens > contextWindow -
reserveTokens`, not at a configurable 80% mark), and novel-aware compaction
summaries that preserve canon, open promises, and character state.
