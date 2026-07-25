> 中文版；英文原文见 [../../docs/01-novelty.md]。两版内容必须保持一致，改动请同步。

# StoryOS 的主张

共有三项 contribution。前两项是思想核心，第三项是 artifact contribution。
v2 的表述（“我们在 commit 前增加 validation gate”）已弃用。这只是
engineering hygiene，没有审美价值，而且我们自己的测量结果也不支持它
是一种质量机制（`docs/03-v2-postmortem.md`）。

## Novelty 1：long-form harness 失败，是因为 context 无法在 component 之间流动

### 实验设置

在 FreshNovelBench subset-10 上测量，目标为 40k 词。除模型本身就是系统的
情况外，backbone 均为 gpt-5-mini：

| 系统 | 平均词数 | 目标达成率 | 说明 |
|---|---:|---:|---|
| storywriter-style | 69,140 | 172.8% | chunked harness |
| agentwrite | 67,041 | 167.6% | chunked harness |
| agents-room-style | 62,834 | 157.1% | chunked harness |
| bare-long-context | 40,485 | 101.2% | multi-call continuation |
| raw-gpt-5.6-sol | 8,690 | **21.7%** | single frontier model |
| raw-gpt-5.5 | 8,389 | **21.0%** | single frontier model |
| raw-gemini-3.1-pro | 4,395 | **11.0%** | single frontier model |

在 ConStory tuning-20（目标 8–10k 词）上的结果如下。CED 表示每 10k 词
中的 consistency error 数量，越低越好：

| 系统 | CED ↓ | 平均词数 |
|---|---:|---:|
| raw-gpt-5.6-sol | 1.200 | 10,321 |
| raw-gpt-5.5 | 1.202 | 12,201 |
| raw-gemini-3.1-pro | 3.964 | 10,480 |
| bare-long-context | 4.100 | 11,060 |
| storywriter-style | 5.055 | 14,824 |
| agentwrite | 6.155 | 15,065 |
| agents-room-style | 6.610 | 14,098 |

两张表放在一起，就是一条**长度–一致性 Pareto front**。我们测到的 raw
frontier model 一致性最好，却完全无法达到长篇小说的长度。所有能达到
长篇小说长度的系统都是 decomposition harness，而所有 decomposition
harness 的一致性都明显更差。目前没有系统能兼得两者。

### 主张的原因

问题不在 context *capacity*，1M-token window 足以轻松容纳一部 40k 词小说。
原因是现有 harness 中，**每个 component 只能收到 upstream stage 硬编码进
prompt 的内容**，没有 component 能按需查询完整 state。因此总会有 stage
缺少它所需的 context：

- chapter *N* 的 writer 看到的是 chapter 1..*N*−1 的有损 summary，而不是
  正文，因此无法核对一处只有模糊印象的细节；
- critic/verifier 即使存在，看到的也是 draft，而不是用于 judge consistency
  所需的 character state 或 open promise；
- 写作中确立的 fact 无法回流到 outline 或 character sheet，因为不存在
  从 prose 回到 plan 的 write path；
- component 各自保存彼此重叠的 private state 副本，而这些副本会在没有
  提示的情况下逐渐分叉。

各系统的证据及文件/行号引用见
`../../research/2026-07/25-baseline-context-flow-audit.md`。这份 audit
是该主张的 backbone，必须在发表前完整完成。论证强度取决于证据最弱的
系统，而读过其中某篇论文的 reviewer 会核查它。

### 主张的解决方案

建立一个所有 agent 都能按需查询的统一 index，使 context 能到达真正需要
它的 component，而不是只到达 pipeline 作者预先想到的 component。按这个
设计，long-form writing 应该能随长度增长维持质量，而不是逐渐退化。

**状态：尚未证明。** v2 没有证明这一点（CED 4.690，bare 为 4.100）。
这项主张能否成立，取决于 v3 的测量结果。

## Novelty 2：对于 story state，free-form filesystem index 优于 graph 和 table

这是人类最初的表述，但 v2 把它丢掉了：

> 一个目录就是 character-relationship index。与 graph 相比，graph 只能
> 记录两个人之间的一种关系，但故事中两个人之间发生的事具有*时间性*：
> 他们可能经历许多关系，先是陌生人，然后成为师生、恋人、敌人，再次成为
> 恋人，最后成为朋友。graph 很难表示这种过程，而 free-form index 可以。

论文中的精简表述是：**story entity 之间的关系密集且会随时间变化，因此
narrative state 需要一种能让 entity pair 携带有序、重叠、可修改且带有
provenance 的关系序列的表示。** rigid triple 和 fixed-schema table 恰好
会压平真正重要的结构。相关工作逐渐收敛到 graph 和 typed table
（FactTrack、EvolvingWorld、NWM、MAGNET，以及 DOME 的
`<subject, action, object, chapter>` quadruple）。反例恰好击中这里：
这个 quadruple 无法表示“在 chapter 3–11 是她的 mentor，在 12 变成她的
enemy，到 20 又成为她的 lover”，除非丢掉顺序，或者膨胀成大量无法再被
当成一段完整关系来阅读的 row。

文件系统 index 还带来三项 database 不具备的实际属性：agent 可以用原生
`grep`/`read` 查询，无需专用 API；人类可以 audit 和 diff；provenance
是 first-class artifact，而不是一个 column。

代价也要如实说明：atomic commit 必须跨越文件和 derived index，因此
commit path 需要 staging、fsync、rename 和 index rebuild；crash recovery
则从文件重建 index。

## Novelty 3：FreshNovelBench

它包含 50 个冻结的 novel-length task，全部来自**注册模型 cutoff 之后**
发表的小说，因此 source text 不可能存在于受评模型的训练数据中。构建流程：
由人类 audit 的 60 部 cutoff 后小说组成初始池 → 按确定性规则冻结为 50 部
（优先 standalone、日期取最新、覆盖 7 个 genre 且保持平衡）→ 使用双 probe
contamination gate（title/author recall、blind premise recognition），把
泄漏书目替换为已经 probe 的 reserve 中按确定性规则选出的书目 → 把任务
合成为 premise、expected conflict、required element 和 character，并设置
40k/60k/80k 词目标 → 最终冻结并由人类 spot-check。

命名说明：“NovelBench” 已被使用两次，分别指一个 LLM creativity arena
和 RAVEL 论文中的 text-to-image benchmark，因此采用 FreshNovelBench。
代码路径和 Mongo collection 仍使用 `novelbench`；只有论文名称发生变化。

## 明确不再主张什么

“gated write path / atomic promotion / Narrative CI”机制属于
*infrastructure*，不是 contribution。它会保留，因为 transaction semantics
确实有用，而且 process evidence（154 次 commit 对 279 次 rejection，
拦截 epistemic violation 363 次）值得用一个诚实的段落说明。但它不会进入
abstract，也不是 figure 要论证的内容。
