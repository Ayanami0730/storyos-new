# 交接：gpt-5-mini 的备用供给（智增增）

统一网关今天上午两次打不动：先是约 40 分钟的 `401 Invalid token`（两把
key、curl 直连都 401，之后自行恢复，是网关侧故障不是 key 被吊销），随后是
持续的 `429 … swedencentral has exceeded rate limit`——**并发 2 就打死了四个
run**。那个配额是两条 lane 共用的，所以谁都不能按一个固定数去规划它。

下面这条路线是实测通的，**`~/.config/zzz/key2` 整把归 LiveNovelBench 那边**，
我只用 `~/.config/zzz/key`。按 key 分而不是共用一把再约定上限，这样任一账号
出问题只影响一条 lane，不需要互相协调。

## 怎么调

```
base_url  https://api.zhizengzeng.com/v1
endpoint  POST /v1/chat/completions      # 标准 OpenAI 协议
auth      Authorization: Bearer $(cat ~/.config/zzz/key2)
model     gpt-5-mini                     # 实测可用
```

**一个必踩的坑**：gpt-5 系列会先把 token 预算花在 reasoning 上，`max_tokens`
给小了会返回 `finish_reason: "length"` 加**空 content**，看起来像路线坏了，其实
不是。我第一次探用 16 就踩了。给 **≥700**。

## 并发：一把 key 8 个并行请求是拐点

两把 key 分别压过，逐级加并发，每级零失败：

| 并发 | key | key2 |
|---|---|---|
| 1 | 3.7s p50 | 3.7s |
| 2 | 3.7s | 5.0s |
| 4 | 4.5s | 3.2s |
| 8 | **3.5s，1.90 req/s** | **4.5s，1.22 req/s** |
| 12 | 7.6s，1.09 req/s | — |
| 16 | 7.4s，1.25 req/s | — |

到 8 为止延迟不涨（p50 3.5–5.0s，正好是统一网关自己的 p50）；**12 和 16 时
中位延迟翻倍到 7.5s 而吞吐不再上升**——那是排队，不是产能。

所以：**峰值并行请求 ≤ 8，稳态建议 6**，留两格给重试。如果你们的 worker 是
「一个 worker 一个在途请求」，那就是 6 个 worker。我这边四个 StoryOS run 在
一把 key 上连跑 35 分钟，一次 429 都没有。

额度上限每个账号 **$100**。参考量级：我这边一篇 2000–3500 词的稿子约
$0.14–1.00，四篇跑完 $0.57。判分调用比这便宜得多。

## 机器资源：负载数字会骗人，别照着它做决定

看到 1 分钟负载 200+ 不用慌，我核过了：**CPU 86% 空闲、iowait 2%、磁盘 util
10–45%**，全机所有用户的 CPU 加起来才 3.7 核（共 24 核）。那个数字是别人在
遍历 `/mnt` 挂载点造成的大量瞬时 D 态任务撑起来的。

**真正的瓶颈是网关配额，不是这台机器。** 这类任务全是网络等待——我四个 run
合计只占 0.24 核。所以并发上限该按上面那张表定，不要按 `nproc` 定。

判断机器是否真的有问题，按这个顺序：`cat /proc/loadavg` →
`iostat -x 1 2`（看第二次采样的 `%iowait`，>30% 才是 IO 瓶颈）→
`ps -eo user,pid,stat,args | awk '$3 ~ /^D/'` 找 D 态进程。不要一上来就猜
「盘满了」「内存满了」。

另外这台机是多人共用、单块系统盘，根下挂着 NAS/OSS/GooseFS：**不要**对
`/`、`/home`、`~` 做不带 `-maxdepth` 的 `find`，也不要对它们 `grep -r`——
一次全盘遍历就能让所有人 SSH 掉线。搜索限定在项目目录内，用
`rg -j 4 --glob '!**/mnt/**' 'pattern' ./src` 这种写法。

## 我这边在跑什么（避免撞车）

只用 `~/.config/zzz/key`，并发 4，跑 StoryOS 的章长 A/B（LongBench-Write 四
道题各两臂）。统一网关我暂时不碰了，等它恢复。
