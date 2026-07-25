> 中文版；英文原文见 [../FOUNDATION.md]。两版内容必须保持一致，改动请同步。

# StoryOS v3 foundation：已验证事实

以下所有内容均为 2026-07-25 的实测结果，不是根据文档推断所得。

## Runtime 选择

基于已发布的 pi package 构建（`0.82.0`，比本地 `pi-mono` checkout
的 `0.80.6` 更新）：

- `@earendil-works/pi-agent-core` — `Agent`、tool loop、`setDefaultStreamFn`
- `@earendil-works/pi-ai` — provider/model abstraction、`openai-completions` transport
- `typebox` — tool parameter schema
- `undici` — proxy dispatcher（见 gotcha 2）

`@earendil-works/pi-coding-agent` 还提供 session/compaction/skill/file tool，
它是 resident agent 的预定底座；smoke test 仍使用 `pi-agent-core`，以缩小
可能出错的范围。

## Gotcha 1：gateway 没有 Responses API

无论使用 `gpt-5-mini` 还是 `gpt-5.5`，`POST /v1/responses` 都返回
**404**。pi 内置的 `openaiProvider()` 把 `api: "openai-responses"`
写死了，因此不能只替换 `baseUrl` 后复用。应注册一个固定使用
`openai-completions` 的自定义 provider：

```js
const model = {
  id: "gpt-5-mini",
  api: "openai-completions",          // 必须如此；不能是 "openai-responses"
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

`Agent` 还需要把 stream function 路由到 `Models` collection，否则构造时
会抛出 `No default stream function configured`：

```js
setDefaultStreamFn((m, context, options) => models.stream(m, context, options));
```

## Gotcha 2：Node 会忽略 curl 使用的代理

Gateway 拒绝来自中国大陆的 IP：

```
403 {"code":"access_denied","message":"Access denied: this service is not
available from mainland China IPs"}
```

curl 能成功，是因为它遵循 `https_proxy`；Node 的 fetch（undici）不会读取
proxy 环境变量，因此会直接连接并收到 403。每个 entry point 都必须先安装
global dispatcher：

```js
import { ProxyAgent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new ProxyAgent(process.env.https_proxy));
```

这是最容易让人困惑的 failure mode：完全相同的请求在 shell 中成功，在
Node 中失败，而错误信息指向地理位置，不是配置。

## 已验证能力

`smoke/gateway-tool-loop.mjs` 用一个带 `read_canon` tool 的 agent
执行 tool loop：

```
tool_calls_seen_by_loop: 2
tools_actually_executed:  [{read_canon, {character: "Ilya"}}, ...]
message_roles: user → assistant → toolResult → assistant → toolResult → assistant
elapsed_ms: 11893
```

因此，通过 gateway 使用 `gpt-5-mini` 时，原生 multi-turn function calling
可以端到端运行。v2 引擎采用“没有 tool schema，每次调用只有一个 JSON
contract”的设计，是主动选择，不是平台限制。

运行命令：

```bash
YS_KEY="$(security find-generic-password -s ai.metastone.yuanshi-api -a ayanami -w)" \
  node smoke/gateway-tool-loop.mjs
```

## pi 已提供什么，还需要我们实现什么

开箱即用的能力包括：tool loop、针对自定义 gateway 的原生 function calling、
带 validation 的 TypeBox schema、`read/write/edit/bash/grep/find/ls`、
每个 agent 独立的 system prompt + model + tool allowlist、支持 fork/resume
的 JSONL session、遇到 overflow 后自动 retry 的 compaction，以及
`SKILL.md` discovery。

我们需要实现：管理 long-lived session 的五 persona registry；路由到该
registry 的 agent-to-agent tool（pi 的 `subagent` 示例使用 `--no-session`
生成一次性进程，这与 resident agent 恰好相反）；带 locking 和 versioning
的共享文件系统 index；`memory/` convention 及其注入规则；基于百分比的
两级 compaction policy（pi 在 `contextTokens > contextWindow -
reserveTokens` 时 compact，而不是在可配置的 80% 阈值 compact）；以及
能够保留 canon、open promise 和 character state 的 novel-aware compaction
summary。
