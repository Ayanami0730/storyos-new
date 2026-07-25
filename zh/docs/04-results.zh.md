> 中文版；英文原文见 [../../docs/04-results.md]。两版内容必须保持一致，改动请同步。

# 截至 2026-07-25 的实测结果

以下全部数字都是从跑完的 run 里读盘得到的，没有任何推算，也没有朝对我们有利的方向取整。每项都给了来源路径，任何数字都可以重新推导。

所有受控系统的 backbone 都是 `gpt-5-mini`；三行 `raw-*` 用的是前沿模型，因此**不是**受控对比。checker / judge 是 `gpt-5.5`，因为 `gpt-5-mini` 没通过预注册的校准门槛。

## 0. 有效性警告 —— 下表中 harness 那几行还不是公平对比

一次针对我们自己 baseline adapter 与官方实现的代码级审计（`../../research/2026-07/25-baseline-context-flow-audit.md` 的「我方 baseline adapters 的复现忠实度警报」一节）发现，三个 adapter **被不忠实地削弱了**，而且每一处都朝着对我们有利的方向：

- **AgentWrite**：我们的 writer prompt 只带 premise、continuation setup 和当前 section brief（`storyos/src/baselines/implementations.py:393-405`），而官方实现每一步都把**此前累计的全文**传进去（`LongWriter@447539b:agentwrite/write.py:56-84`）。我们这版等于让它各段独立写。
- **Agents' Room**：我们的 writer 只收到当前 brief 加一个"已完成章节标题"列表（`implementations.py:540-566`），而论文规定每个 agent 读**完整的当前共享 scratchpad**，包含 planning block 和已写正文。我们人为制造了整个对比里最严重的 context 断流。
- **RecurrentGPT**：我们的 adapter 同时删掉了上一段和官方循环里的长期 top-k 检索。
- **DOME**：我们的 writer 少传了官方 DHO writer prompt 里的 `last_chapter_story`（`storyos/src/baselines/dome.py:681-716`）。

后果：harness 那三行 5.055 / 6.155 / 6.610 是被我们自己的实现选择拉高（变差）的，所以**"harness 输给 bare long-context"这个结论并不成立**，这张表在当前形态下不能发表。任何结论要靠它之前，必须先恢复忠实度、重跑受影响的系统、重打分、重新推导这张表。`bare-long-context`、三个 `raw-*` 和 `storyos-index` 那几行不受影响。

## 1. ConStory tuning-20 —— 一致性（CED，越低越好）

CED = 检出的不同错误子类数 ÷（词数 / 10,000），每 10k 词取值范围 [0, 19]。来源：`storyos/experiments/reproduction-subsubset/checker/*.summary.json`。

| 系统 | 类别 | CED ↓ | 平均词数 | 完成数 |
|---|---|---:|---:|---:|
| raw-gpt-5.6-sol | frontier zero-shot | 1.200 | 10,321 | 20/20 |
| raw-gpt-5.5 | frontier zero-shot | 1.202 | 12,201 | 20/20 |
| raw-gemini-3.1-pro-preview | frontier zero-shot | 3.964 | 10,480 | 20/20 |
| bare-long-context | 受控 zero-shot | 4.100 | 11,060 | 20/20 |
| **storyos-index (v2)** | **我们** | **4.690** | 9,326 | **14/19** |
| storywriter-style | harness | 5.055 | 14,824 | 20/20 |
| agentwrite | harness | 6.155 | 15,065 | 20/20 |
| agents-room-style | harness | 6.610 | 14,098 | 20/20 |
| dome | harness | 未打分 | 10,504 | 4/20 |

这张表用的是哪个平均，以及为什么重要。`checker/*.summary.json` 每个系统给出两个估计量，
两者不可互换：

- **`mean_ced`** —— 宏平均，即逐题 CED 的均值。**这才是 ConStory 的官方指标**：
  $\overline{\mathrm{CED}}_m = \frac{1}{N}\sum_i \mathrm{CED}_{m,i}$，其中
  $\mathrm{CED}_{m,i} = e_{m,i} / (w_{m,i}/10^4)$
  （`storyos/survey/notes/constory-2603.05890.md:166`）。上表用的是它。
- **`aggregate_ced`** —— 汇总微平均：总错误数除以总词数。它本身合法，但对 ConStory
  而言是离开官方口径的，而且会隐式地给长故事更大权重。

两者大体一致（|Δ| ≤ 0.03），但在逐题长度差异最大的地方分歧：storywriter-style 宏平均
5.055 而微平均 4.857，agentwrite 6.155 对 6.240。**两种口径下排名完全相同**，所以这里
没有任何结论依赖于口径选择——但 StoryOS 与 storywriter 的差距依赖它：宏平均 0.365、
微平均 0.185。宏平均作主口径、微平均作稳健性检查，**绝不能在同一列里混用**。

两条随表同行的打分限定：`agentwrite` 有 `skipped: 2`，所以它的宏平均是 18 题而非 20 题；
`bare-long-context` 的 `completed: 0` 与 `completed_task_count: 20` 并存，是 summary
写入侧的 schema 记法问题，不是真失败。

v2 的分类分解：`timeline_plot_logic` 1.92、`factual_detail` 1.38、`narrative_style` 0.92、`characterization` 0.23、`world_building_setting` 0.23。按任务型分解：Continuation 6.17、Completion 4.58、Generation 3.88、Expansion 3.59。14 个任务、130,557 词，单题 CED 从 0.00（task 1004）到 8.79（task 0），方差很大且 n 很小。

有两条限定必须永远跟着这张表一起出现：frontier 那几行用的是不同 backbone；v2 的 5 个失败任务被排除在它的均值之外，如果这些失败恰好是更难的题，这会使 v2 的结果偏乐观。

诚实解读：在受控 backbone 下我们赢了所有分解式 harness，但输给最朴素的 baseline。根因见 `03-v2-postmortem.md`。

## 2. FreshNovelBench subset-10 —— 系统能不能写到 novel length

目标是 40,000 词。来源：`storyos/experiments/novelbench-subset/terminal-accounting.jsonl`。

| 系统 | 平均词数 | 最大 | 达成率 | 完成数 |
|---|---:|---:|---:|---:|
| storywriter-style | 69,140 | 75,043 | 172.8% | 9/10 |
| agentwrite | 67,041 | 75,609 | 167.6% | 10/10 |
| agents-room-style | 62,834 | 69,494 | 157.1% | 10/10 |
| bare-long-context | 40,485 | 40,943 | 101.2% | 10/10 |
| raw-gpt-5.6-sol | 8,690 | 10,828 | **21.7%** | 6/10 |
| raw-gpt-5.5 | 8,389 | 10,317 | **21.0%** | 9/10 |
| raw-gemini-3.1-pro-preview | 4,395 | 5,313 | **11.0%** | 10/10 |

打分进行中，`bare-long-context` 已出 CED 2.35。

和表 1 合起来看就是长度—一致性的 Pareto front：最一致的系统写不到长度，而所有能写到长度的系统一致性都明显更差。

## 3. v2 的 gate 过程证据

同样这 19 个任务（`storyos/runs/tuning-local-r1-20260724-after-3m-w20k/`）：

- 154 个 scene draft 被 commit、279 个被 reject → **首过率 35.6%**
- 按 validator 分的 findings：epistemic 363、semantic-fatal 198、audit 46、contract 17、schema 14、temporal 2
- 14/19 完成；5 个失败全部停在 9 个已 commit 的 scene（约 8.4k 词）之后，rejection 负载耗尽了 token 预算

做出 14/19 这个突破的改动是把单题预算提到 3M token、writer completion cap 提到 20k，也就是远端 codex 已经验证过的那套配置。在此之前每一轮本地 run 都是 0/19。

## 4. 长度劣化 pilot

`storyos/experiments/degradation/analysis_summary.json`，4 个 premise × 5 个目标档，N=20 个完成 cell：

- 原始错误实例数 vs 实际词数：**r = 0.405, p = 0.076** —— 正相关但在 α = 0.05 下不显著
- CED（按长度归一）vs 实际词数：**r = −0.202, p = 0.394** —— 略负，不显著
- 按 category CED 求和的主导错误类别：timeline/plot logic 53.1、factual detail 37.0、characterization 13.6、world-building 13.2、style 13.0
- 即使目标给到 24,000 词，实际产出也从未超过 14,100 词

所以"错误随长度增长"在方向上被支持，但**用我们自己的数据没有统计上站住**。已发表的 ConStory RQ2 结果是可引用的兜底。任何用到这份数据的图都必须标成趋势，不能写成规律。

## 5. Judge / checker 校准

- LitBench，300 对 × 4 个候选 judge × dual-order：`gpt-5.5` 与人类一致率 **0.740**（最高），`gpt-5.6-luna` 0.731，`gpt-5.6-sol` 0.725（position consistency 最好，0.895），`gpt-5.6-terra` 0.709。四者置信区间在 0.71–0.74 重叠。约 16/600 条触发内容过滤。
- ConStory checker 校准，30 对任务（`storyos/experiments/checker_calibration/report.json`）：binary subtype agreement 0.842，**mean positive Jaccard 只有 0.209**，story exact-match 0.10。`gpt-5-mini` 没达到预注册门槛（agreement ≥ 0.95 且每个 category delta ≤ 0.03），所以冻结的 checker 是 `gpt-5.5`。

0.209 这个 Jaccard 是实实在在的可靠性上限，必须报告而不是藏起来：checker 在"某个子类是否触发"上的一致程度，远高于在"具体哪些实例触发"上的一致程度。

## 6. 成本

本地账本 `storyos/experiments/costs.csv`：20,721 行，**input 49.5M token、output 26.8M token**。USD 没有计算——网关不提供可核实的分模型单价，所以 `estimated_usd` 是有意留空的，而不是拍脑袋填的。

一个值得记的单系统成本形状：DOME 单个 10k 词任务需要约 972 次调用、约 2.6 小时，最后也只完成 4/20，这本身就是关于"忠实复现成本"的一个发现。

## 7. 每个 baseline 的复现现状

| 系统 | 已实现 | 已跑 | 已打分 | 备注 |
|---|---|---|---|---|
| bare-long-context | 是 | 20/20 | 是 | 最强的受控 baseline |
| agentwrite | 是 | 20/20 | 是 | 段预算 bug 在跑的过程中修掉 |
| storywriter-style | 是 | 20/20 | 是 | |
| agents-room-style | 是 | 20/20 | 是 | 简化版多 agent |
| raw-gpt-5.6-sol / raw-gpt-5.5 / raw-gemini-3.1-pro | 是 | 20/20 | 是 | frontier，backbone 不同 |
| dome | 是 | 4/20 | 否 | 约 972 calls/题；失败多为"输出越出 9k–11k 词门" |
| recurrentgpt | 适配器已有 | 否 | 否 | 需要真正的 sentence-transformers VectorDB → 要 GPU |
| longwriter-zero-32b | 未部署 | 否 | 否 | 需要一整张 GPU |
| general-agent 档（pi-agent-raw） | 仅设计 | 否 | 否 | 最干净的"有无 narrative OS" ablation |

## 8. 完全还没测的东西

一个 ablation 都没跑：gate on/off、bounded working set 大小、repair 预算 k ∈ {0,1,2,4}、关掉 audit 轨、关掉 semantic 轨、typed patch vs 自由文本、关掉 versioning。注错研究（3 类错误 × 10 个实例 × 4 种模式）已预注册但未执行。没有人评。我们自己的系统没有跑过 40k 词。冻结的 200 题报告集的 paired-bootstrap 解锁门（10,000 次重采样、seed 20260724、两轮 CI 下界都 > 0）还完全没碰。

## 9. 产物位置

| 产物 | 路径 |
|---|---|
| ConStory 分数 | `storyos/experiments/reproduction-subsubset/checker/` |
| NovelBench runs | `storyos/experiments/novelbench-subset/` |
| 劣化 pilot | `storyos/experiments/degradation/` |
| v2 引擎 runs | `storyos/runs/tuning-local-r1-20260724-after-3m-w20k/` |
| 故事与 metadata | `~/storyos-data/outputs/<system>/<bench>/` |
| 成本账本 | `storyos/experiments/costs.csv` |
| 论文与图 | `storyos/paper/` |
| 公网站点 | http://8.222.254.65:30133/ |
| 公网论文 PDF | http://8.222.254.65:30133/main.pdf |
