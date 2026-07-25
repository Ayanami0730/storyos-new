> 中文版；英文原文见 [../../docs/02-architecture.md]。两版内容必须保持一致，改动请同步。

# StoryOS v3 architecture

这是正式设计记录。任何与本文冲突的内容都需要明确决策，不能悄然偏离。
设计理由和引用见
`../../research/2026-07/25-storyos-v3-harness-design-research.md`。

## 1. 系统形态

五个 agent 全部常驻在同一个 Node 进程中。orchestrator 负责整个流程，并把
其他四个 agent 作为**原生 function-calling tool** 调用；每个被调用者保留
自己的 persistent session，因此 context 会在多次调用间不断积累，而不是
每次重建。delegation depth 固定为 **1**，specialist 永远不会生成 specialist。

```
                         premise
                            │
                    ┌───────▼────────┐
                    │  orchestrator  │  resident; owns task DAG, budget,
                    └───┬───┬───┬───┬┘  transactions, retry/abort
     call_index_manager │   │   │   │ call_verifier
        call_context_builder │   │ call_writer
                        │   │   │   │
   ┌────────────────┐   │   │   │   │   ┌──────────────┐
   │ index-manager  │◄──┘   │   │   └──►│   verifier   │
   │ sole committer │       │   │       │ findings only│
   └───────┬────────┘       │   │       └──────┬───────┘
           │        ┌───────▼─┐ │              │
           │        │ context │ │◄─── writer asks follow-ups (≤3)
           │        │ builder │ │              │
           │        └────┬────┘ │              │
           │             │  ┌───▼────┐         │
           │             └─►│ writer │◄────────┘ findings (≤5 rounds)
           │                └───┬────┘
           │                    │ staged draft + proposed state delta
           ▼                    ▼
   ┌──────────────────────────────────────────────┐
   │  canonical filesystem index  (read: all)     │
   │  write: index-manager only, via atomic commit│
   └──────────────────────────────────────────────┘
```

每个 agent 对 index 都有**相同的读取范围**，不会有谁因为视野较窄而成为
二等成员。区别只在写入权限。

## 2. Tool

按是否修改 state 划分，而不是按 role 划分：

**Free-form read：每个 agent 都能使用。** 在 sandbox 内执行的单个
`run_command` 原生提供 `grep`、`ls`、`find`、`sed`、`head`、`wc`、
`cat` 及其组合能力。我们刻意没有为每个 partition 手工设计 read tool：
agent 已经会使用 shell，而 shell 能适应尚未预想到的 index layout。pi
也提供 typed 的 `read`/`grep`/`find`/`ls` tool；应继续启用这些符合使用
习惯的快捷方式，但 `run_command` 才是通用能力。

**Typed mutation：经过 schema validation，并受 role 限制。**

| Tool | 使用者 | 效果 |
|---|---|---|
| `build_context_packet` | context-builder | 写入 `staging/<txid>/context-packet.json` + coverage report |
| `write_staged_scene` | writer | 写入 `staging/<txid>/scene-draft.md` |
| `propose_state_delta` | writer | 写入 `staging/<txid>/proposed-state-delta.json` |
| `write_findings` | verifier | 追加到 `staging/<txid>/validation-findings.jsonl` |
| `apply_state_delta` / `commit_transaction` | index-manager | 进入 canonical state 的唯一途径 |
| `open_transaction` / `abort_transaction` / `request_commit` | orchestrator | control plane；不写文件 |

规则：只要操作会改变 canonical state，就必须使用带 schema validation
和 provenance 的 typed tool。如果只是读取，就交给 shell。

## 3. Canonical state 是文件系统

SQLite 是可随时从文件重建的**派生 projection**。这与 v2 相反，也是
novelty 2 的必要条件：entity pair 必须能携带有序、重叠且可修改的关系
序列，而 rigid triple 会把这些关系压平。

```
story-project/
├── HARNESS.md                     # system contract，由人维护
├── config/{project,models,budgets,policies}.yaml
├── agents/<agent>/
│   ├── AGENT.md                   # system prompt + tool allowlist
│   └── memory/
│       ├── MEMORY.md              # 仅作 INDEX："- [Title](topic.md) — hook"
│       └── <topic>.md             # 完整 memory，按需读取
├── skills/<skill>/SKILL.md        # 只存 procedure，绝不存 story state
├── index/
│   ├── manifest.yaml
│   ├── _schemas/*.schema.json
│   ├── project/{brief.md,constraints.yaml,decisions.jsonl,glossary.yaml}
│   ├── plan/{task-graph.jsonl,milestones.yaml,pass-plan.yaml,budgets.json}
│   └── story/
│       ├── premise.md, logline.md, synopsis/{paragraph,long}.md
│       ├── structure/
│       │   ├── framework.yaml     # kishotenketsu | save-the-cat | 3-act | ...
│       │   ├── beats.yaml, arcs.yaml, chapters.yaml
│       │   ├── scenes/<scene-id>.yaml
│       │   └── tension-{target,actual}.csv
│       ├── bible/
│       │   ├── characters/<id>.yaml, locations/<id>.yaml
│       │   ├── factions/<id>.yaml, objects/<id>.yaml
│       │   ├── world-rules.yaml, terminology.yaml
│       │   └── relations/<pair-id>.yaml     # ← novelty 2 位于这里
│       ├── continuity/
│       │   ├── canon-facts.jsonl, timeline-events.jsonl
│       │   ├── character-state.jsonl, beliefs/<char-id>.jsonl
│       │   ├── plot-contracts.jsonl, open-loops.yaml, retcons.jsonl
│       └── revision/{findings.jsonl,pass-status.yaml,style-sheet.yaml}
├── manuscript/parts/<part>/chapters/<ch>/scenes/<scene>.md
├── staging/<txid>/{intent,context-packet,scene-draft,proposed-state-delta,validation-findings,status}
└── runtime/
    ├── events.jsonl               # append-only truth
    ├── ledger.jsonl               # 按调用汇总 token/cost/latency
    ├── projection.sqlite          # DERIVED；可从 index/ 重建
    ├── transcripts/<agent>/<run-id>.jsonl
    └── artifacts/<artifact-id>/   # 已移出的 tool payload，可重新获取
```

### Relation record：novelty 2 的具体落点

`bible/relations/<pair-id>.yaml` 保存有序 interval 列表，而不是一条 edge：

```yaml
pair_id: mira--warden
participants: [char-mira, char-warden]
phases:
  - {from_scene: s-001, to_scene: s-004, relation: strangers,
     asymmetry: null, source: {scene: s-001, span: "L12-L18"}}
  - {from_scene: s-005, to_scene: s-011, relation: mentor_student,
     asymmetry: "warden mentors mira; mira suspects nothing",
     source: {scene: s-005, span: "L44-L60"}}
  - {from_scene: s-012, to_scene: null, relation: enemies,
     supersedes_phase: 2, reason: "betrayal revealed",
     source: {scene: s-012, span: "L88-L96"}}
open_questions: ["does mira learn warden's real faction?"]
```

它提供三项 fixed-schema edge 无法提供的属性：phase 有序，并且可用
`supersedes_phase` 原地修改；phase 可以在 free text 中表达不对称关系
（A 对 B 的看法 ≠ B 对 A 的看法）；每个 phase 都带有指向 scene span
的 provenance。

## 4. 把 scene 作为 atomic transaction

```
OPEN
 → CONTEXT_BUILT            context-builder emits packet + coverage
 → DRAFTED                  writer may ask context-builder ≤3 follow-ups
 → STATE_DELTA_PROPOSED
 → VALIDATING               verifier: deterministic first, then LLM tracks
     → REPAIR_REQUIRED → DRAFTED    (≤5 rounds; ≤1 context-builder query each)
     → REJECTED
     → APPROVED
 → COMMITTING
     → STALE_BASE → CONTEXT_BUILT   (base_commit_id moved under us)
     → COMMITTED
```

`APPROVED` 是 verifier 的意见。只有 index-manager 能产生 `COMMITTED`，
正文和 state delta 要么在一个 commit 中一同落盘，要么都不落盘。
verification 按成本最低且确定性最高的项目优先执行：schema/reference
integrity → time、space、object、visibility、hard world rule →
promise-payoff 和 scene contract → 对 motivation、causality、pacing、prose
进行 LLM judgement。

从 v2 的教训中得到的 coverage discipline：extraction **不能**对每个 scene
只提取少量 claim。coverage 应随 scene length 扩展，而且 coverage→CED
关系必须实测，不能靠假设。

## 5. Context management

三个 budget 分开计算：runtime conversation、task context packet、output
reserve。设 window 为 `W`，且 `E = W - min(maxOutput, 20k)`：

- **Level 1 在 `0.70·E` 触发**：清除可重新获取的 tool payload。保留
  `tool_call_id`、tool name、input hash、artifact path 和一行 digest；
  把 payload 移到 `runtime/artifacts/`。最近 8–12 个 tool result 逐字保留。
  绝不触碰 memory、canon、transaction record 或 user message。
- **Level 2 在 `E - 13k` 触发**：为较早的 history 生成 structured summary，
  同时逐字保留最近的 tail（10k–40k，绝不拆开 tool_use/tool_result pair）。
  summary 记录 `covered_event_ids`、source transcript、model 和 time，并且
  只进入 LLM view，绝不进入 canonical state。
- **Hard block 在 `E - 3k` 触发**：不再开始新 turn；必须 compact、checkpoint
  或失败退出。

百分比可以配置；这些默认值来自 Claude Code buffer 的实测结果。无论 window
多大，context packet 的目标范围都是 40–70k（默认 60k）：scene card 2–4k、
predecessor prose 逐字内容 4–10k、chapter/arc summary 2–6k、相关
canon/state/belief 10–20k、open promise 和 reveal limit 4–8k、style
exemplar 4–8k、provenance overhead 2–4k。

packet assembly 按 priority 排序，而不是按 top-k similarity：P0 hard
constraint（scene card、world rule、reveal limit、base revision）→
P1 当前 entity 的 state/belief → P2 direct dependency（previous scene、
triggered contract）→ P3 remote recall → P4 optional background。
**P0/P1 绝不能被 similarity ranking 挤掉；如果缺少 hard-required id，
build 必须失败**，不能让 writer 自行推断。

## 6. Memory 与 skill

`MEMORY.md` 是 index：加载前 200 行，上限 25KB，每行一个指针。完整 memory
存放在 topic file 中，由 agent 按需 grep 和读取。agent memory 只保存“如何
让该 role 工作得更好”，例如 verifier 针对已知 false positive 的 calibration，
或已经批准的 writer style feedback。**story state 绝不进入 memory 或
skill**，而是进入 index。每个 memory topic 都带有 `source`、
`last_verified_at`、`scope` 和可选的 `expires_at`，从而让过时经验失效。

skill 遵循 SKILL.md spec：启动时加载 frontmatter 中的 `name` +
`description`（约 100 token），只有调用时才加载完整正文，并按需加载
`references/` 和 `scripts/`。第一批包括：`project-intake`、
`story-architecture`、`scene-card-planning`、`scene-drafting`、
`canon-extraction`、`continuity-audit`、`belief-boundary-audit`、
`promise-payoff-audit`、`structural-revision`、`character-revision`、
`prose-revision`、`copyedit`。skill 永远不能提升 tool 权限。

## 7. Sandbox backend

这里的 isolation 不是为了防御恶意 agent，而是让 gated write path
**由 OS 强制执行，而不是由 prompt 强制执行**。这比要求模型不要写入
提供了实质上更强的保证。

| Backend | 用途 | Write gate 机制 |
|---|---|---|
| `local` | 开发、unit test | 限制 cwd；除 index-manager 的 commit section 外，canonical 文件只读 |
| `docker` | sgp-dev、production | 除 index-manager 外，每个 agent 都以只读方式 bind mount canonical index；staging 可读写 |
| `e2b` | burst parallelism，或本地磁盘耗尽时 | 每个 sandbox 有全新的 10 GiB 空间；使用相同的 mount discipline |

e2b 路径的关键约束：**agent loop 留在 sandbox 外部。** 每次
`run_command` 进入 sandbox，运行几秒后返回。因此 Hobby tier 的 1 小时
continuous-runtime 限制永远不会生效，我们也不需要为等待 gateway latency
而闲置的 VM 按秒付费。sandbox state 通过同步或挂载的 project directory
持久化，所以 sandbox 本身可随时丢弃。

## 8. Trace、cost 与可复现性

pi 已为每条 assistant message 附带：
`usage {input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost{...}}`、
`timestamp`、`model`、`responseModel`、`responseId`、`stopReason`，并在
支持 fork/resume 的 JSONL session 中持久化。在此基础上，我们增加
`runtime/ledger.jsonl`，用于按 agent 和 phase 做 story 级汇总：token、
cost、wall time、tool call 次数、retry 和 gate outcome。

**如果 trace、cost 和 timing ledger 没有落盘，这次 run 就不算完成。**
每个 commit 都记录 `base_commit_id`、config digest 和 engine source
digest，因此每项结果都能关联到生成它的确切代码和配置。

## 9. 延续下来的已知风险

不同 agent 基于不同 base revision 写入时发生 contention（用 single-writer、
`base_commit_id` 和 staging 缓解）；summary 被误当成 fact（summary 只能
用于导航，canon 必须有 source span 和 commit id）；prose 与 state 被分开
commit（必须在同一个 transaction 中，否则都不提交）；verifier 修改 prose
（它只能写 findings）；LLM verifier 与 generator 共享 blind spot（先做
deterministic check，soft quality 使用 cross-family judge）；repair livelock
（限制轮数，记录未变化的 finding，然后 abort 或 escalate）；过度结构化扼杀
写作（hard canon、soft plan 和 aesthetic target 分属不同层级，writer 可以
提出 deviation 或 retcon）；tension metric 被 reward hack（只使用 band 和
trend，绝不作为 commit gate）。
