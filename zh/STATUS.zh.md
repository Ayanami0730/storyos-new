# StoryOS 进度追踪

活动状态记录，不是设计文档。2026-07-25 13:10 +08 在 sgp-dev 上接手项目时更新。
设计之准见 `docs/02-architecture.md`；论文主张见 `docs/01-novelty.md`；实测数字见
`docs/04-results.md`。

## 0. 论证链条每一层的状态

| 层次 | 主张 / 产物 | 状态 |
|---|---|---|
| Motivation | 输出越长，质量下降、事实漂移 | **方向上支持，未成立** —— 我们自己的 pilot 只有 r = 0.405, p = 0.076（N=20，实际词数从未超过 14.1k）。需要 60k 扫描实验（见下方第 2 节）。 |
| Motivation | 裸前沿模型达不到 novel length | **已成立且干净** —— 40k 目标只做到 11–22%，没人削弱过它们 |
| Novelty 1 | 现有 harness 相互传递的是**有损**上下文 | **2026-07-25 已重写主张**，7 个系统的证据审计完成；早先"组件看不到正文"的版本被我们自己的审计证伪，不得再用 |
| Novelty 1 | 统一无损索引能解决它 | **未证明。** v2 CED 4.672 输给 bare 4.069。这正是 v3 要验证的。 |
| Novelty 2 | 对稠密且随时序变化的关系，文件系统索引优于图 | **已论证，未演示。** schema 已设计（`relations/<pair-id>.yaml`）；还没有任何一次运行产出过。 |
| Novelty 3 | FreshNovelBench | **已建成** —— 50 道冻结任务、污染门、已入 Mongo 并上站。人工抽检和全 50 本探针仍未完成。 |
| Method | v3 五 agent 常驻 harness（基于 pi） | **设计完成，零行代码。** 基础冒烟测试通过。 |
| Results | ConStory tuning-20，8 个系统 | **已测但 3 行无效** —— 适配器不忠实，见 `docs/04-results.md` §0 |
| Results | FreshNovelBench subset-10 长度 | **已测**；CED 打分未完成 |
| Experiments | 全部消融 | **一个都没跑** |
| Writing | 8 页 AAAI 稿 + 3 张生成图 | **只存在于本地 Mac 且不在 git 里** —— 见第 1 节 |

## 1. 同步缺口 —— 2026-07-25 14:00 已关闭

先前记录的两个缺口都已解决。笔记本把 `codex-run` 推到 `fd124e7`（"paper: land the
submission, its figures and the scoring evidence from the laptop"，351 文件 /
61,030 插入），并用 tar pipe 把 gitignore 的大产物放到 sgp-dev 的同名路径。这边已核对：
`paper/main.pdf`（872,826 B）、`paper/main.tex`、`paper/figures/` 48 个受版本控制的文件、
`experiments/reproduction-subsubset/` 43 个、`experiments/novelbench-subset/` 29 个、
`experiments/degradation/` 197 个。传上来的大产物与清单逐字节一致：
`runs/tuning-local-…-after-3m-w20k/` 9,159 文件 / 49,808,604 B、
`dome-checkpoints/` 177 / 19,332,476 B、`novelbench-subset/outputs/` 71 /
17,028,466 B。细节见 `docs/07-v2-assets-and-locations.md` 与 v2 `README.md` 的接手须知。

还剩两个较小的缺口：

- **sgp-dev 上没有 TeX 工具链**（`latexmk` 和 `pdflatex` 都不存在），所以论文没法在这边重编。
  要么装一个（16G 空闲下比较勉强），要么论文编译继续留在笔记本上。
- **网站源码不在 git 里，而且 sgp-dev 上的副本是旧的。**
  `popia_dmx/storyos-bench-viewer/` 根本不是 git 仓库，它的 `scripts/` 里没有
  `build_research_pages.py`，`public/data/` 只有 `palette.json`；只有笔记本构建出来的
  `out/` 是当前版本。已部署的 `out/data/research-pages.json` 里还是修正前的 CED
  （4.69 ×6、5.06 ×9、6.15 ×9）。

## 1b. 三个已发布的 CED 值是错的，现已修正

笔记本的交接文档标出了一个过期数字。把每个系统都对照权威的
`experiments/reproduction-subsubset/summary.md` 核过之后，发现是**三个**：

| 系统 | 原值 | 实测 |
|---|---:|---:|
| storyos-index (v2) | 4.69 | **4.672** |
| storywriter-style | 5.06 | **4.857** |
| agentwrite | 6.15 | **6.240** |

其余的属于四舍五入（1.20→1.211、1.20→1.229、3.96→3.960、4.10→4.069、6.61→6.632）。
旧值看起来是打分还没跑完时的中途读数。排名顺序不变，但 StoryOS 与 storywriter 的差距是
0.185 而不是 0.37——最接近的 harness 比旧表暗示的近得多，这会影响 v2 结果的表述方式。
本仓库全部 `.md` 已修正；**网站还需要改。**

## 2. 按依赖顺序该做什么

每项细节见 `docs/05-open-threads.md`；这里是排序视图。

**闸门 A —— 恢复 baseline 忠实度。** 三个适配器相对官方实现被削弱，且**每次都朝对我们有利的
方向**，所以现在任何跨系统对比都不成立。四个适配器、四条互不相交的代码路径、四个并发 worker，
之后串行一步用冻结的 `gpt-5.5` checker 重打分到**新的**输出根目录。两张表都要发——不忠实与忠实
复现之间的差值本身就是方法学结果。这件事落地前，下游一切都不可信。

**闸门 B —— motivation 扫描实验。** 两个系统（最强裸前沿模型 + 一个公认 harness）、同一 premise
的多个详细程度档位、目标 5k → 60k、两张图：质量下降 + 事实错误上升，并在目标词数旁如实报告实际
词数。pilot 的不显著结果是个警告：扫描必须走得更远，并且要逐档做质量评分。然后用**渲染好的结果图**
作为参考图重新生成 teaser，让它上半部分是真实数据。只在"选哪个 harness"上依赖闸门 A。

**然后可以并行：**

- **消融实验。** 对 v3 最重要的那个是新的：**抽取覆盖率 → CED**。v2 把 audit 抽取硬性限制在每场
  5 条 claims / 3 条 knowledge uses，所以它的门只检查了它本该保护的内容的一个样本。扫描覆盖率，
  搞清楚门能不能为自己付账。然后是已注册的那批：gate on/off、working set 大小、repair 预算 k、
  audit/semantic 轨分别关掉、typed patch vs 自由文本、versioning 关掉，以及注错研究。
- **v3 Phase 1。** 事务内核 → 带覆盖率报告的 context packet → 小说领域 schema → 常驻多 agent。
  沙箱已由实测定案：公司 E2B 服务，sgp-dev 上验证创建耗时 60ms。
- **论文债。** 四处 `[[需核实]]` 全部仍然成立，主图仍然把门控顺序画错、把确定性模块画成 agent、
  并展示了并不存在的 `memory` 簇。要么改代码，要么改主张。

**在这里跑任何 v3 代码前的环境阻塞：** Node 是 v20.19.2，pi 要求 ≥22.19.0。磁盘 100%、剩 16G——
比 `HANDOFF.md` 里记的 2.4G 好（codex 清理过缓存），但仍是硬门槛；远端历史里已经有一轮因运行中
磁盘写满而作废。

## 3. 2026-07-25 已停止：sgp-dev 上的 codex session

`storyos-v2`、它的 watchdog `storyos-v2-wd`、以及闲置的 `codex-goal` smoke session 已全部停止，
连同 `exact-normalization` shard 上的两个 `run_constory_tuning.py` worker。watchdog 先停——它的
设计是一旦 session 消失就自动重启 codex，所以用了它自己的 `.wd2-stop` 标志。`cot-distill` 是另一个
无关的 codex session，没有动它。

原因：约 26 小时产出约 30 个 commit，每一个都只用"gate 是否通过 / 任务能否跑完"验证，**一次都没有
用 CED 验证过**。从未完成一个完整的 tuning-20 轮，所以 report-200 从未解锁；而且每个微修复都只是
暴露出下一个边界，并不收敛。它在修的那个架构，正是 v3 要替换掉的。

**抢救出来的东西**：`docs/06-v2-repair-loop-failure-taxonomy.md` —— 八类可复现的失效族，带 journal
哈希。其中最重要的一条是 **v2 的引擎会部分改写 writer 的 patch**，这导致某一场景连续九稿的正文
摘要完全相同。v3 明令禁止这种做法。同样值得继承的还有：预注册纪律（每轮全新 run identity、禁止
拼接 partial、逐字节可重建的 source lock、每次运行都带 config digest）、3M token / 20k writer cap
配置、以及 1020→1764 的确定性换题。

**没有抢救的**：引擎 diff 本身。它们是对 `orchestrator.py`、`verifier.py`、`audit.py` 的补丁，
所处架构把 canonical state 放在 SQLite 里、并且让引擎去改写 writer 的提案——这两点正是 v3 明确
反转的决策。

## 4. sgp-dev 上当前在跑的东西

`storyos-viewer` 在 30133 端口 serve 公开站点和 `main.pdf`。本项目相关的其他进程都没有在跑。
