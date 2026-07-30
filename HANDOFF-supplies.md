# 交接：gpt-5-mini 的三条供给，怎么分

三条路线现在都可用，**主力是同事新开的 `openai/gpt-5-mini`**。下面是实测数据和
分配建议，两条 lane 各取一半即可，不需要互相协调到请求级。

## 一、主力：`openai/gpt-5-mini`（同事新开）

```
base_url  https://ai-prod-sg-internal.wenxiaobai.com/v1   # 公网 ai-prod-sg.wenxiaobai.com 同样可用
endpoint  POST /v1/chat/completions
auth      Authorization: Bearer $(cat ~/.config/ys/key)   # 就是原来的 YS_KEY，不用换
model     openai/gpt-5-mini                               # 注意这个前缀
```

**模型名就是路由。** 同一把 key、同一个域名下，`openai/gpt-5-mini` 返回 200，而
原来的 `gpt-5-mini` 仍然是 `当前分组上游负载已饱和` —— 它们是两个上游组，新的
那个没被打满。

并发实测（每级都是全新请求，零重试）：

| 并发 | 成功/总数 | p50 | p90 | 最慢 | req/s |
|---|---|---|---|---|---|
| 4 | 4/4 | 3.6s | 5.4s | 5.4s | 0.73 |
| 8 | 8/8 | 3.0s | 3.9s | 3.9s | 2.03 |
| 16 | 16/16 | 3.6s | 4.1s | 4.5s | 3.57 |
| **32** | **32/32** | **3.7s** | 4.5s | 8.3s | 3.86 |
| 48 | 47/48 | 3.4s | 5.6s | 21.8s | 2.15 |
| 64 | 48/64 | 3.1s | 5.3s | 16.6s | 2.85 |
| 96 | 60/96 | 10.8s | 15.8s | 16.1s | 3.72 |

**32 是最后一个干净的档位**：到 32 为止零失败且 p50 平在 3.0–3.7s，48 开始出
429（1/48），64 是 16/64，96 是 36/96。吞吐从 16 起就在 3.6–3.9 req/s 平台上，
所以超过 32 买到的是错误不是产能。

**建议：总量 32，两条 lane 各 16。** 如果你们的 worker 是「一个 worker 一个在途
请求」，那就是各 16 个 worker。

## 二、备用：智增增（`~/.config/zzz/key` / `key2`）

```
base_url  https://api.zhizengzeng.com/v1
model     gpt-5-mini            # 这里不带前缀
auth      Bearer $(cat ~/.config/zzz/key2)
```

标准 OpenAI 协议。两把 key 分别压过，1/2/4/8 全部零失败，p50 3.5–5.0s；12 和 16
时 p50 翻倍到 7.5s 而吞吐不再上升，**单把 key 的拐点是 8**。

⚠️ **`~/.config/zzz/key` 今天已经跑到余额不足**（`{"code":"405","message":"亲，
余额不足哦~","type":"quota_not_enough"}`），八个 run 同时挂掉。`key2` 还有额度，
每个号上限 $100。用之前先发一个最小请求探一下余额。

## 三、原路线：`gpt-5-mini`（旧上游组）

同一个网关、同一把 key、不带前缀的名字。**目前基本不可用**：并发 2 就把 run 打死
（`429 … swedencentral has exceeded rate limit`），今天上午还出过约 40 分钟的
`401 Invalid token`（不是 key 被吊销，之后自行恢复）。除非要复现历史结果，否则不要
用它。

## 一个所有路线都要注意的坑

gpt-5 系列**先把 token 预算花在 reasoning 上**，`max_tokens` / `max_completion_tokens`
给小了会返回 `finish_reason: "length"` 加**空 content** —— 看起来像路线坏了，其实
不是。给 **≥600**。另外 wenxiaobai 网关的 gpt-5 系列要用
`max_completion_tokens`，智增增用 `max_tokens`。

## 机器资源：负载数字会骗人

看到 1 分钟负载 120–260 不用慌，我核过几次：**CPU 通常 80%+ 空闲、iowait 2%、
磁盘 util 10–45%**，全机所有用户 CPU 加起来才 3–4 核（共 24 核）。那个数字是大量
瞬时 D 态任务撑起来的，多半来自别人遍历 `/mnt` 挂载点。

**真正的瓶颈是网关配额，不是这台机器。** 这类任务全是网络等待——八个 StoryOS run
同时跑也只占 0.24 核。所以并发上限按上面的表定，不要按 `nproc` 定。

判断机器是否真有问题，按这个顺序：`cat /proc/loadavg` → `iostat -x 1 2`（看第二次
采样的 `%iowait`，>30% 才是 IO 瓶颈）→ `ps -eo user,pid,stat,args | awk '$3 ~ /^D/'`
找 D 态进程。不要一上来就猜「盘满了」。

搜索这台机器上的文件时：**不要**对 `/`、`/home`、`~` 做不带 `-maxdepth` 的 `find`，
也不要对它们 `grep -r` / `rg`。`/mnt/*` 是 NAS/OSS/GooseFS，每一次 `stat` 都是一次
网络往返，一次全盘遍历就能让所有人 SSH 掉线。限定到项目子目录，并限线程：

```sh
rg -j 4 --max-filesize 2M --glob '!**/mnt/**' 'pattern' ./src
```
