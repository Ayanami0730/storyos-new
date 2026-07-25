> 中文版；英文原文见 [../HANDOFF.md]。两版内容必须保持一致，改动请同步。

# StoryOS v3 交接说明

先读本文，再读 `FOUNDATION.md`（已验证的平台事实），然后读
`docs/01-novelty.md`（论文主张），最后读 `docs/02-architecture.md`
（待实现内容）。

这个 repo 是**引擎**。论文、benchmark、baseline 和 v2 引擎仍放在独立的
`storyos` repo（`git@github.com:Ayanami0730/storyos.git`）中。

## 为什么要做 v3

v2 已经交付，并给出了我们自己系统的第一个实测结果：在 ConStory
tuning-20 上的 **CED 为 4.672**（完成 14/19 个任务，共 130,557 词，
backbone 为 gpt-5-mini）。使用相同 backbone 时，`bare-long-context`
得到 **4.069**，也就是最简单的 baseline 胜过了我们。完整表格和根因见
`docs/03-v2-postmortem.md`。简短地说，v2 的 validation gate 保护的是
*已声明的 typed state*，而 CED 衡量的是*正文*；同时 audit extractor
对每个 scene 最多只提取 5 条 claim 和 3 次 knowledge use，因此 gate
始终只检查它本应保护内容中的一个样本。

v2 也丢掉了设计中最有力的想法。它把所有内容都存进 SQLite 表，而这种
表示无法表达原始设计真正关注的东西（见 novelty 2）。

## 分工：本地与 sgp-dev

| 事项 | 地点 | 原因 |
|---|---|---|
| 引擎开发、unit test、单任务 smoke | 本地 Mac | 编辑迭代快；已安装 Node 25 |
| sandbox 并行实验、长时运行、benchmark sweep | sgp-dev | 可直连 gateway，有 Docker、tmux，不依赖笔记本 |
| 论文、图表、benchmark 数据 | `storyos` repo | 不变 |

两端通过 git 衔接。不要手工在机器之间复制文件。

### sgp-dev 环境事实（2026-07-25 实测）

可用项：

- Gateway **无需代理**即可访问：`https://ai-prod-sg.wenxiaobai.com/v1`
  的响应时间约为 0.019s。内部地址 `ai-prod-sg-internal.wenxiaobai.com`
  也能访问。`FOUNDATION.md` 中的代理处理和中国大陆 IP 导致的 403
  在这里都不适用。
- 已安装 Docker 26.1.3，因此可用只读 bind mount 强制执行 write gate，
  不必依赖 prompt 约束。
- GitHub SSH 可用（`git@github.com:Ayanami0730/...`）。
- tmux 是运行长任务的既定方式。

运行任何任务前必须清除的 blocker：

1. **Node 版本是 v20.19.2；pi 要求 `>=22.19.0`。** 用 nvm、conda
   或官方 tarball 安装 Node 22+，并在 `npm install` 前运行 `node -v`
   验证版本。
2. **磁盘使用率为 100%：总容量 2.0T，只剩 2.4G。** home 目录只能解释
   约 85G 的占用（`popia_dmx` 23G、`raw_pools` 12G、`miniconda3` 12G、
   `vibe-engine-server` 11G），因此根文件系统的其余空间被本项目之外的
   内容占满。`docker system prune` 可回收约 6G（3.08G build cache +
   2.9G 未使用 image）。实验会产生 GB 级 run artifact，只有 2.4G
   空间时会立即失败。应把它当作 hard gate，而不是 warning。远端 v2
   历史中已经有一个 commit 记录了磁盘写满导致的中止。
3. sgp-dev 上正在运行一个 codex session（`storyos-v2`）和两个
   tuning worker。启动任何会争用 gateway 的任务前，先检查 `tmux ls`
   和 `ps aux | grep python`。

### 为什么应由 sgp-dev 上的 agent 负责执行

从外部访问 sgp-dev 需要 JumpServer MFA ControlMaster socket，而它会在
几小时后过期，因此远端 assistant 无法持续照看长时运行。直接运行在
sgp-dev **上**的 agent 没有这个限制。应让远端负责执行，并通过 repo
中的 commit 和 `runs/*/summary.json` 汇报，而不是通过聊天汇报。

## 已锁定的设计决策

以下决策已经与人类确认，不应在没有说明的情况下重新讨论。

1. **Canonical state 存在文件系统中。** SQLite 是派生的查询 projection，
   必须能从文件重建。反过来做，也就是 v2 的选择，会摧毁 novelty 2。
2. **五个 agent 全部常驻，delegation depth 固定为 1。** orchestrator
   负责整个流程，并把其他四个 agent 作为原生 tool 调用；每个被调用者
   在多次调用之间保留自己的 persistent session context（Anthropic
   Managed Agents 所说的 “shared hands, isolated brains”）。specialist
   永远不能再生成 specialist。
3. **每个 agent 使用相同的 index 访问接口。** 不会有 agent 因视野更窄
   而成为二等成员：所有 agent 都能使用 `run_command`，也能在 index
   上使用相同的读取和搜索工具。区别只在*写入*权限，不在*读取*范围。
4. **用 free-form shell 读取，用 typed tool 修改。** `run_command`
   原生提供 grep/ls/find/sed，因此不需要为每个 partition 手工设计一种
   read tool。任何会改变 canonical state 的操作都必须经过 typed、
   schema-validated tool（`propose_state_delta`、`write_findings`、
   `commit_transaction`）。
5. **只有 index-manager 能产生 `COMMITTED`。** verifier 给出的
   `APPROVED` 只是意见；正文和 state delta 要么在一个 atomic commit
   中一同落盘，要么都不落盘。
6. **skill 存 procedure，index 存 story state。** “Character A is in
   London and does not yet know the killer” 应放在 index 中，绝不能放在
   skill 或 agent memory 中。
7. **`MEMORY.md` 是 index，不是 transcript。** 遵循 Claude Code：
   加载*前* 200 行（上限 25KB），每行是一个
   `- [Title](topic.md) — hook` 指针，让 agent 按需 grep/read topic
   文件。（之前认为应该“保留最后 N 行”的假设是错的；CC 的做法相反，
   而且更好。）
8. **两级 context compaction，阈值可配置。** Level 1 清除可重新获取的
   tool payload，同时保留 `tool_call_id`、名称和 artifact 指针；Level 2
   生成 structured summary，并逐字保留最近的 tail。由 CC 推导出的默认值：
   `E = W - min(maxOutput, 20k)`，Level 1 在 `0.70·E` 触发，Level 2
   在 `E - 13k` 触发，hard block 在 `E - 3k` 触发。

## Sandbox 的真实用途

这些 agent 不具有对抗性，因此 isolation 不是为了安全。它真正的价值在于：
**让 gated write path 由 OS 强制执行，而不是由 prompt 强制执行**。这比
“我们要求 agent 不要写入”有力得多。`SandboxBackend` 要实现三个可互换
的 backend：

- `local`（默认开发环境）：限制 working directory；canonical index
  文件设为只读，只在 index-manager 的 commit critical section 内解锁。
- `docker`（sgp-dev 和 production target）：除 index-manager 外，每个
  agent container 都以只读方式 bind mount canonical index；每个 agent
  的 staging 以读写方式挂载。
- `e2b`（仅在将来需要数百个并发任务或执行不可信代码时）：当前不需要。
  瓶颈是 gateway concurrency，不是 sandbox isolation；本地目录也让调试
  保持简单。

## Trace 与成本核算

pi 已原生覆盖其中的大部分内容：每条 `AssistantMessage` 都带有
`usage {input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost{...}}`，
以及 `timestamp`、`model`、`responseModel`、`responseId` 和 `stopReason`；
`ToolResultMessage` 也可以携带自己的 usage。`AgentHarness` 会把这些内容
持久化到支持 fork/resume 的 JSONL session。

我们需要补充 story 级汇总：把五个 agent 的 session 聚合为每次 run
的一份 ledger，其中包含按 agent 和 phase 统计的 token、cost、wall time、
tool call 次数、retry 次数和 gate outcome。这样，每部完成的小说都有完整
audit trail。要求：**如果 trace、cost 和 timing ledger 没有落盘，这次
run 就不算完成。**

## 第一阶段实现

按以下顺序执行；Phase 1 的 invariant 成立之前，不要开始 Phase 2。

1. 在单进程中实现 transaction kernel：即使五个 role 暂时共用一个模型，
   它们的权限和输出 schema 也必须已经分开。scene 是 atomic transaction：
   `OPEN → CONTEXT_BUILT → DRAFTED → STATE_DELTA_PROPOSED → VALIDATING → (REPAIR ≤ k | REJECTED | APPROVED) → COMMITTING → (STALE_BASE → CONTEXT_BUILT | COMMITTED)`。
2. 实现带 coverage report 的 context packet。如果缺少 hard-required id，
   builder 必须失败，绝不能让 writer “reasonably infer”。
3. 按顺序实现 novel-domain schema：scene card → canon fact / character
   state / timeline → belief visibility → promise-payoff → tension 和 revision
   pass。
4. 实现 persistent multi-agent：每个 agent 有自己的 thread、transcript、
   memory 和 skill；只有互相独立的 verifier pass 可以并发。

## 参考资料

- `FOUNDATION.md` — 已实测的平台事实，以及两个耗费数小时才定位的 gotcha
- `docs/01-novelty.md` — 三项 contribution 及其证据位置
- `docs/02-architecture.md` — index tree、agent contract、context management
- `docs/03-v2-postmortem.md` — v2 数字和根因，避免重蹈覆辙
- `../../research/2026-07/25-storyos-v3-harness-design-research.md` — 完整设计研究
  （带文件/行号引用的 Claude Code 机制、2026 年 multi-agent paradigm
  对比、novelist artifact 清单、阈值、20 项风险清单）
- `../../research/2026-07/25-baseline-context-flow-audit.md` — novelty 1
  中逐 baseline 的证据
- `references/repos/pi-mono` — 用于阅读源码的 pi monorepo，版本为 0.80.6；
  本 repo 依赖已发布的 0.82.0 package
- sgp-dev 上的 `~/vibe-engine-server` — 已在 production 验证的引擎，
  可用于对照运行模式（11G，Python）
