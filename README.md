# StoryOS v3

长篇小说写作 agent harness 的完整系统实现。**仓库 `Ayanami0730/storyos-new`，分支 `main`。**

## 两个仓库的分工（2026-07-25 定）

| 仓库 | 放什么 |
|---|---|
| **`storyos-new`（本仓库）** | 完整的 harness 系统。可以并发接收 task，输出完整结果 |
| `storyos`（`storyos-legacy` remote） | 全部数据、评估脚本、所有 baseline 复现、论文写作、v2 引擎 |

流向是单向的：本仓库跑出结果 → 拿到 `storyos` 仓库里去评估。所以本仓库**不放** benchmark
数据、checker、baseline 实现和论文；`storyos` 仓库**不放** harness 实现。

本仓库的历史起点是 `storyos` 仓库上的孤立分支 `v3-engine`（独立根提交，与 v2 主干零共享
历史），2026-07-25 迁出为独立仓库。`storyos-legacy` remote 仍指向 `storyos`，方便查 v2 的
提交历史。

## 现在处于什么状态

底座已经验证跑通：pi 的 agent loop 能驱动公司新加坡网关做原生多轮 function calling
（`smoke/gateway-tool-loop.mjs` 实测通过）。Phase 1 的事务内核尚未实现。

为什么有 v3：v2 跑出了我们系统第一个可报告的数字——ConStory tuning-20 上 CED **4.690**，
而同 backbone 下最朴素的 `bare-long-context` 是 **4.100**。我们输给了最简单的 baseline。
根因是 v2 的 gate 保护的是「声明的 typed state」，而 CED 度量的是「正文」，且 audit 抽取
被硬性限制为每场 5 条 claims / 3 条 knowledge uses，所以门只检查了它本该保护内容的一个抽样。
详见 `docs/03-v2-postmortem.md`。

## 文档索引

| 内容 | 英文 | 中文 |
|---|---|---|
| **当前进度与全景 TODO（先读这个）** | [STATUS.md](STATUS.md) | [zh/STATUS.zh.md](zh/STATUS.zh.md) |
| 接手指南 | [HANDOFF.md](HANDOFF.md) | [zh/HANDOFF.zh.md](zh/HANDOFF.zh.md) |
| 平台实测事实与两个坑 | [FOUNDATION.md](FOUNDATION.md) | [zh/FOUNDATION.zh.md](zh/FOUNDATION.zh.md) |
| 三个创新点 | [docs/01-novelty.md](docs/01-novelty.md) | [zh/docs/01-novelty.zh.md](zh/docs/01-novelty.zh.md) |
| 架构设计（设计之准） | [docs/02-architecture.md](docs/02-architecture.md) | [zh/docs/02-architecture.zh.md](zh/docs/02-architecture.zh.md) |
| v2 复盘 | [docs/03-v2-postmortem.md](docs/03-v2-postmortem.md) | [zh/docs/03-v2-postmortem.zh.md](zh/docs/03-v2-postmortem.zh.md) |
| 全部实测结果 | [docs/04-results.md](docs/04-results.md) | [zh/docs/04-results.zh.md](zh/docs/04-results.zh.md) |
| 未完成线条与优先级 | [docs/05-open-threads.md](docs/05-open-threads.md) | — |
| v2 修复循环失效模式分类 | [docs/06-v2-repair-loop-failure-taxonomy.md](docs/06-v2-repair-loop-failure-taxonomy.md) | [zh/docs/06-v2-repair-loop-failure-taxonomy.zh.md](zh/docs/06-v2-repair-loop-failure-taxonomy.zh.md) |

外部资料：设计调研全文在 `../../research/2026-07/25-storyos-v3-harness-design-research.md`
（含 Claude Code 机制的文件行号引用、2026 多智能体范式对比、小说家工作制品清单、阈值与 20 条风险）。

## 快速开始

需要 Node ≥ 22.19.0（pi 的硬要求）。

```bash
npm install
export https_proxy="${https_proxy:-http://127.0.0.1:7897}"
YS_KEY="$(security find-generic-password -s ai.metastone.yuanshi-api -a ayanami -w)" \
  node smoke/gateway-tool-loop.mjs
```

两个必须知道的坑，否则会浪费几小时：网关**没有** `/v1/responses`（对 gpt-5-mini 和
gpt-5.5 都是 404），所以必须注册 `api: "openai-completions"` 的自定义 provider，不能只改
内置 provider 的 baseUrl；网关**拒绝中国大陆 IP**，而 Node 的 undici 默认不读代理环境变量，
于是同样的请求 curl 成功、Node 报 403 说不支持大陆 IP，必须先装全局 `ProxyAgent`。
`smoke/proxy-setup.mjs` 会读取 `https_proxy` 并安装全局 `ProxyAgent`。如果本地代理不在
`127.0.0.1:7897`，请替换上面的地址。细节见 `FOUNDATION.md`。

**在 sgp-dev 上**不要设代理（网关直连约 0.019s），改用：

```bash
YS_KEY="$(cat ~/.config/ys/key)" node smoke/gateway-tool-loop.mjs
```

sgp-dev 上 Node 22.20.0 已装在 `~/bin/node22`（用 `export PATH="$HOME/bin/node22/bin:$PATH"` 激活，系统的 v20 未改动），冒烟已实测通过，不需要代理。

---

# StoryOS v3 (English)

The complete long-form novel-writing agent harness. **Repository
`Ayanami0730/storyos-new`, branch `main`.**

Repository split, decided 2026-07-25: this repo is the *system* — it accepts
tasks concurrently and emits complete results. Everything used to *judge* those
results lives in `storyos` (reachable here as the `storyos-legacy` remote): all
data, evaluation scripts, every reproduced baseline, the paper, and the v2
engine. The flow is one-way — run here, evaluate there. So this repo carries no
benchmark data, no checker, no baseline implementations and no paper, and
`storyos` carries no harness implementation.

History begins at the orphan branch `v3-engine` in `storyos` (independent root
commit, zero shared history with the v2 trunk), split out on 2026-07-25.

## Current status

The platform is validated: pi's agent loop drives our Singapore gateway with
native multi-turn function calling (`smoke/gateway-tool-loop.mjs` passes). The
Phase 1 transaction kernel is not implemented yet.

Why v3 exists: v2 produced the first reportable number for our own system —
**CED 4.690** on ConStory tuning-20 — against **4.100** for the simplest possible
baseline, `bare-long-context`, under the same backbone. We lose to the simplest
baseline. The root cause is that v2's gate protects *declared typed state* while
CED measures *prose*, and audit extraction is hard-capped at 5 claims / 3
knowledge uses per scene, so the gate only ever inspects a sample of what it is
supposed to protect. See `docs/03-v2-postmortem.md`.

## Documentation index

See the bilingual table above; English documents are the source of truth and the
`zh/` versions must be kept in sync with them.

## Quick start

Requires Node ≥ 22.19.0 (pi's declared engine constraint).

```bash
npm install
export https_proxy="${https_proxy:-http://127.0.0.1:7897}"
YS_KEY="$(security find-generic-password -s ai.metastone.yuanshi-api -a ayanami -w)" \
  node smoke/gateway-tool-loop.mjs
```

Two gotchas that will otherwise cost you hours: the gateway has **no**
`/v1/responses` endpoint (404 for both gpt-5-mini and gpt-5.5), so you must
register a custom provider pinned to `api: "openai-completions"` rather than
re-pointing the built-in one; and the gateway **rejects mainland-China IPs**
while Node's undici ignores proxy environment variables, so an identical request
succeeds from curl and fails from Node with an error blaming geography. Install a
global `ProxyAgent` first. `smoke/proxy-setup.mjs` reads `https_proxy` and installs
that dispatcher. Replace `127.0.0.1:7897` if your local proxy uses another address.
sgp-dev reaches the gateway directly, so do not set a local proxy there. Details
in `FOUNDATION.md`.
