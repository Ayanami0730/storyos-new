> 中文版；英文原文见 [../../docs/03-v2-postmortem.md]。两版内容必须保持一致，改动请同步。

# v2 postmortem：不能重蹈的覆辙

v2 位于 `storyos` repo（`src/engine/`、`src/storyos/`）中。它能够运行，
也确实能生成小说，而测量数字说明这套 architecture 已经触及上限。本文写于
2026-07-25，依据来自实际 run，而不是主观印象。

## 数字

ConStory tuning-20，backbone 为 gpt-5-mini，checker 为 gpt-5.5，CED
越低越好：

| 系统 | CED ↓ | 词数 | 完成数 |
|---|---:|---:|---:|
| raw-gpt-5.6-sol | 1.211 | 10,321 | 20/20 |
| raw-gpt-5.5 | 1.229 | 12,201 | 20/20 |
| raw-gemini-3.1-pro | 3.960 | 10,480 | 20/20 |
| **bare-long-context** | **4.069** | 11,060 | 20/20 |
| **storyos-index (v2)** | **4.672** | 9,326 | **14/19** |
| storywriter-style | 4.857 | 14,824 | 20/20 |
| agentwrite | 6.240 | 15,065 | 20/20 |
| agents-room-style | 6.632 | 14,098 | 20/20 |
| dome | 未评分 | 10,504 | 4/20 |

v2 自身的类别分解结果：`timeline_plot_logic` 1.92、`factual_detail` 1.38、
`narrative_style` 0.92、`characterization` 0.23、`world_building` 0.23。
按任务类型分解：Continuation 最差，为 6.17；Expansion 最好，为 3.59。
各任务 CED 范围为 0.00 到 8.79，因此方差很大，而且 n=14 很小。

这些数字必须始终附带两项 caveat：raw frontier model 使用不同的 backbone，
因此 1.211 不是 controlled comparison；v2 的 5 个失败任务未计入 mean，
如果这些失败项更难，这会使结果产生对 v2 有利的偏差。

同一批 19 个任务中的 gate process evidence：**154 份 scene draft 被
commit，279 份被 reject**（first-pass acceptance 35.6%）；finding 分布为
epistemic 363、semantic-fatal 198、audit 46、contract 17、schema 14、
temporal 2。

## 根因 1：gate 检查样本，metric 读取全部内容

audit extractor 被硬性限制为**每个 scene 最多 5 条 claim、5 个 entity
state 和 3 次 knowledge use**，prompt
（`src/storyos/prompts/audit_extract.md:19`）与 validator
（`src/storyos/audit.py:567-586`）都强制执行这一限制。每个 scene 约
1,500 词。因此，正文中的大部分 factual content 从未进入 extraction，
从未到达 semantic track，也从未经过 gate。

后果很明确：gate 能够证明自己保护的是*已声明的 typed state*，而 CED
衡量的是*整篇 9.3k 词 manuscript 的 prose*。279 次 rejection 和高昂的
repair 成本换来了 metric 根本不读取的 state-layer correctness。与此同时，
完全没有 gate 的单次长 generation（bare，11k 词）得分更好，可能是因为
它没有跨 scene seam 产生 inconsistency 的问题。

要么提高 coverage（去掉上限，随 scene length 扩展，并承担相应成本），
要么增加 prose-level pre-commit check；而且要测量 coverage→CED curve，
不能靠假设。

## 根因 2：architecture 从未匹配设计

以下结论经代码阅读验证：

- **没有 resident agent。** 每个 scene 都是一条 one-shot call chain
  （writer 一次、audit 一次、semantic 一次）；每次都从 repository
  snapshot 重建 context。orchestrator 没有 persistent context，writer
  也无法向 context builder 追问。
- **context builder 和 index manager 不是 agent。** 它们是 deterministic
  Python：builder 按固定 priority 对 index entry 排序，再截断到 word
  budget（`src/engine/context.py:20-176`）；index manager 负责 materialise
  文件（`src/engine/index.py`）。原设计要求 builder 针对当前任务搜索并
  grep index。
- **没有 memory，也没有 skill。** 初始化时会创建空的
  `agents/<role>/memory.md`，此后再也不会写入。系统中不存在 skill 机制。
- **真实 write gate 不在 figure 标示的位置。** `CommitCoordinator` 和
  `StoryRepository.commit_scene()` 负责写入；index-manager 只负责
  materialised projection。
- **Gate 顺序是 audit → deterministic validator → semantic → quality**，
  不是 figure 所示的 fast-first 顺序。
- **完全没有 tool schema。** 请求只包含 `model`、`messages`、
  `max_completion_tokens`；所谓“tool”只是由本地 JSON parser 解析的普通
  chat completion。这是主动选择，不是平台限制，因为我们的 gateway
  支持原生 function calling（`FOUNDATION.md`）。
- **semantic threshold 0.8 只改变 severity label**，不改变 control flow；
  `error` 和 `fatal` 都会以相同方式阻止 commit。
- **Canonical state 被存进 SQLite table**，正是这个选择摧毁了 novelty 2。

## 根因 3：面向 metric 的 component 从未针对 metric 调优

远端 codex 又产出了 12 个 engine commit 和 97 次 run，所有 validation
标准都是“gate 是否通过 / task 是否完成”，而且**一次 CED 都没有计算**。
本地 v2 开发也有同一个 blind spot，直到本次 postmortem 才发现。优化
completion rate 并不等于优化质量，而这里两者已经分离。

## v2 做对且 v3 应保留的内容

- 把 scene 作为 atomic transaction，包含 staged proposal、independent
  validation 和 atomic promotion。虽然 gate coverage 不足，但 semantics
  本身成立。
- Fail-closed accounting：设置 per-task token budget 和 call reservation；
  面对含义不明的 in-flight call 时拒绝 resume，以免产生 double charge。
- 保存被 reject 的 draft 及其 finding 和 trace，使整个流程可以 audit。
- 把 deterministic validator family（schema、temporal、epistemic、
  contract）作为所有 LLM judgement 之前的低成本 first pass。
- 遵守 preregistration：冻结且零交集的 tuning/report split；任务触发
  upstream content filter 时按确定性规则 substitution；在接触 report set
  前使用 paired-bootstrap unlock gate。

## 唯一值得牢记的 bug

两次 SIGTERM 在 call 途中终止了 DOME runner；随后其 fail-closed 设计把
19 个 checkpoint 标记为 terminal（`AmbiguousInFlightCall`，
“replay is forbidden”）并拒绝 resume。这种处理是正确的，但没有留下
escape hatch。恢复方法是保留证据，将被污染的 checkpoint 归档后从干净
状态重启；同时把每个多小时任务都移入 tmux，使 terminal 生命周期再也
无法终止任务。v3 从第一天起就需要一套有文档记录的
ambiguous-in-flight resolution protocol。
