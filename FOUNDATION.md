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

## Gotcha 4 — `{ output }` is accepted and the model never sees it

A tool's `execute` must return

```js
return { content: [{ type: "text", text: payload }] };
```

Returning `{ output: payload }` — or a bare string — **fails silently**. The
tool runs, the loop advances, the model replies, and nothing errors; the model
simply never receives the payload and answers as though the lookup came back
empty. Measured (`smoke/tool-result-roundtrip.ts`), asking for a value only
obtainable from the tool:

| returned shape | tool ran | model saw the value |
|---|---|---|
| `{ output: "eye_colour: vermilion" }` | yes | **no** — "I couldn't find any canon record" |
| `"eye_colour: vermilion"` | yes | **no** — "read_canon returned no data" |
| `{ content: [{ type: "text", text: … }] }` | yes | **yes** — "vermilion" |

This is worth dwelling on, because the version of this file that recommended
`{ output }` cited the smoke test below as evidence, and the smoke test could
not have caught it: it asserted that a tool was called and that some text came
back, both of which stay true when the payload is dropped. **A capability test
must ask for something only the capability can supply.** Ours now does — the
secret-value check above is the regression, and the resident-layer smoke test
confirms it end to end (the writer reads canon, drafts from it, and cites the
file path on a later turn from its own session).

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

## Gotcha 3 — the company sandbox endpoint takes an `api.` prefix and a private CA

The company runs an **E2B-protocol-compatible sandbox service on Alibaba Cloud**
(Function Compute base), code at `gitlab.metastoneai.com/alg/e2b_sandbox` (clone
over SSH; HTTPS asks for credentials). It is not e2b.dev, so none of e2b.dev's
tiers, credits or session caps apply.

Two things must be right or it looks unreachable:

1. **The endpoint is `api.agent-vpc.infra`, not `agent-vpc.infra`.** The E2B SDK
   prepends `api.` to the configured `domain`. The bare domain has no A record, so
   curling it returns nothing and looks like "private domain, not resolvable" —
   which is how an earlier probe reached the wrong conclusion. With the prefix,
   Alibaba's internal DNS resolves it to the ALB (`47.237.29.100` /
   `47.236.122.64`).
2. **The private CA is mandatory.** Without `--cacert e2b_sandbox/ca-fullchain.pem`
   curl fails with "self signed certificate in certificate chain"; with it,
   `https://api.agent-vpc.infra/health` returns 200 with TLS in ~14ms.

Verified end to end from sgp-dev by the repo's own live test suite:

```
endpoint domain=agent-vpc.infra template=sandbox-with-oss
[1/3] raw lifecycle   create 0.06s · files+commands OK · pause/resume preserved · kill OK
[2/3] manager path    ensure_structure + /user_space read/write OK · redis mapping OK · acquire(reuse) OK
[3/3] service layer   sandbox_list / sandbox_lookup OK
LIVE E2B: ALL PASS
```

A sandbox is a 2-core / 2.8GB lifsea container running as user `user`, created in
**0.06s**. Mount points are injected at creation time from `sandbox_type` via
`csi-volume-config` metadata — `user→/user_space`, `story→/story`,
`creator→/creator`, `agent→/agent_space` — so a bare `Sandbox.create()` with no
metadata legitimately has no `/user_space`; go through the manager path instead.
Redis at `10.3.5.220:6379` is reachable too.

Note for us: there is already a `story` sandbox type with its own mount. And
because creation is 60ms with OSS-backed persistence and pause/resume, this
service is a better fit than e2b.dev for per-task sandboxes.

Security note to pass upstream: that repo commits `E2B_API_KEY`, a production
Redis URL with password, and MySQL credentials in plaintext in
`e2b_sandbox/defaults.py`. They should move to env/secret storage and rotate.

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
