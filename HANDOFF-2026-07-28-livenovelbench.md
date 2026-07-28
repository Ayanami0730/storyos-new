<!-- 镜像自 ~/lane/livenovelbench/HANDOFF-2026-07-28.md；该目录不是 git 仓库，放此处以进入版本控制 -->

# HANDOFF 2026-07-28 — LiveNovelBench 线

写于 2026-07-28 17:35 +08。sgp-dev 当日不可用（loadavg 峰值 511、idle 0.2%），
本文档经纯 SSH 采集落盘。作者迁往 `yuanshi-h20-16`。

## 0. 先说一个结构性风险

**`~/lane/livenovelbench` 不是 git 仓库。**（`git rev-parse` 返回
`fatal: not a git repository`）目录下所有文件的 mtime 都是 `2026-07-27 11:59:52`
——同一秒，说明它是一次批量复制出来的**并行 lane 工作副本**，内容基线是 StoryOS 项目
（`GOAL-V2.md` 开头即「StoryOS：叙事创作操作系统」），并且留了 `NOTES-FOR-MERGE.md`。

后果：**这条线的产出目前没有任何版本控制，也没有异地副本。**
迁移前必须决定它的归宿——建成独立仓库、或按 `NOTES-FOR-MERGE.md` 合回 storyos 系。

`paper/main.tex` 在此副本与 `~/storyos/paper/main.tex` **内容完全相同**
（md5 均为 `d5947c43ed650a7e84ac7713d4aeb95b`），但 storyos 那份更新
（13:24 vs 11:59），说明论文正文的权威副本在 `~/storyos`，此处那份是旧快照。

## 1. 现成的权威文档（接手先读这几份）

| 文件 | 行数 | 内容 |
|---|---:|---|
| `GOAL-V2.md` | 115 | 2026-07-24 人类下达，**取代 GOAL.md 的执行序列**；含修正后的 motivation、OS 类比映射、统一索引设计、三条不变量 |
| `PROGRESS.md` | 572 | 逐轮工作日志（倒序），每轮含完成项 / 证据路径 / 下一步 / 问题 |
| `BLOCKERS.md` | 117 | 需人工介入项，含已解决与人类决策记录 |
| `NOTES-FOR-MERGE.md` | — | 合并回主干的注意事项 |
| `BASELINE-FIX-PROGRESS.md` | — | baseline 修复进度 |
| `VERIFY.md` | — | 验收清单 |

⚠️ `GOAL-V2.md` 明确写「原 goal 会话保持 suspended，**不要 resume 它**」。

## 2. 三个 tmux window 的实时状态（tmux session `lnb`，07-28 02:41 创建）

全部 cwd = `~/lane/livenovelbench/experiments/novelbench-run`

### `lnb:0.0`（window 名 `gen-backup`）— 仍在跑

驱动脚本 `finish_generation_backup_route.sh 6`（已运行 3 小时+），
底下串行调 `run_nbrun.py --manifest ../../benchmarks/novelbench/tier-60k.json`。
最近完成的格子：

| cell | 状态 | 词数 | tokens | calls | wall |
|---|---|---:|---:|---:|---:|
| `storywriter-style/task-horror-nothing-tastes-as-good` | COMPLETED | 97,557 | 1,697,462 | 216 | 6,412 s |
| `storywriter-style/task-literary-celestial-lights` | COMPLETED | 93,342 | 1,482,886 | 216 | 5,524 s |
| `agents-room-style/task-mystery-a-violent-masterpiece` | COMPLETED | 43,903 | 217,399 | 9 | 981 s |

注意 `storywriter-style` 单格要 216 次调用、约 1.5–1.7 M token、1.5–1.8 小时；
`agents-room-style` 只要 9 次调用。成本与时间预算按此估。

### `lnb:1.0`（window 名 `score`）— 已完成

```
########## SCORE 40k done 2026-07-28T07:51:53+08:00 ##########
91 rows -> ~/lane/livenovelbench/experiments/novelbench-run/table1-rows.jsonl
```

**已知缺口：`rows missing a half (1): quality`** —— 91 行里有 1 行缺 quality 值，
接手时要么补跑要么在表里显式标注。

脚本自己打印的两条口径提醒（写论文时必须遵守）：
- summary-based composite **不打印**：它只作为 judge selection 的脚手架存在于产物里，
  两个都展示会让读者把「仪器差异」读成「结果差异」
- **quality 列在不同 band 之间不可比**：rubric 没有 target length 维度，
  所以只写到目标四分之一的行不会因此被扣分。**读分数时必须同时读 attainment。**

### `lnb:2.0`（window 名 `score60`）— 仍在跑，尚无输出

驱动脚本 `score_60k_mixed_routes.sh`（已运行 2 小时 55 分），pane 输出为空。
这是 60k 档的评分，接手时先确认它是否还活着（`tmux capture-pane -t lnb:2.0 -p`）。

## 3. BLOCKERS 里最重要的一条（已由人类决策解除）

`ConStory` tuning task **1020** 的 prompt 被元石 GPT 通道上游 content filter 拒绝
（HTTP 400 `content_filter` / `param=prompt`，公网内网两条路都一样，
约 100–120 s 后才返回，因此生产 run 表现为零 token 的 `GatewayRequestError`）。

- 人类于 2026-07-24 10:50 **授权预注册换题**：按固定 seed
  `random.Random(20260724).randrange(690)` → 零基索引 471 → task **1764** 替换 1020，
  仍保持四类各 5 题，且与 report-200、原 tuning-20 均不相交
- 1020 本身作为独立的**网关 owner track** 保留，需找网关负责人（**guoshaozong**）
  查 2026-07-24 01:45–02:45 UTC 的 GPT 通道流量，failure call id 列表见 `BLOCKERS.md`
- 全部既往 partial 输出**永久 ineligible**，不得拼接冒充完整 round

## 4. 下一步

1. **先解决版本控制**：给这个 lane 建仓库或按 `NOTES-FOR-MERGE.md` 合回 storyos 系。
   在此之前所有产出都是单点，sgp-dev 今天已经出现 1,889 次 OOM kill
2. 确认 `lnb:2.0` 的 60k 评分是否还在推进
3. 补齐 `table1-rows.jsonl` 缺的那 1 行 quality
4. 论文 Table 1 的数据源就是 `table1-rows.jsonl`，取用时带上 attainment 列
5. StoryOS 线的 `gateway.ts` 新增了 `ys2` 供给路线（实测并发上限 32，是旧分组的 4 倍），
   这条线的长跑可以受益，见 `~/storyos-v3` 的 handoff

## 5. 迁往 h20-16

- workspace `/home/ubuntu/dumingxuan`，**7 人共享 `ubuntu` 账号**，
  禁改 `~/.bashrc`、`~/.cursor-server/data/User/settings.json`、`/etc/environment`
- 硬件 384 核 / 2.2 Ti / 8×H20（3 张空闲），loadavg 3.5、D 状态 0
- `storywriter-style` 那种 216 calls / 1.7 M token 的格子在 sgp-dev 上要 1.8 小时，
  瓶颈主要是网关往返而非本机算力，但本机 IO 与内存不再是限制
- 网络：公司新加坡网关可直连；OpenAI / 智增增须走
  `source ~/dumingxuan/activate.sh`（自动设 `http_proxy=http://127.0.0.1:23128`，
  经 sgp-dev squid 隧道）
