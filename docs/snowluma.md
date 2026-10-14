# SnowLuma 适配（kyestu × OneBot v11 双方言）

> 依据：`REPORT_snowluma_capabilities_2026-10-14.md`（SnowLuma 能力目录，源码快照 `.agent/tmp/snowluma-src`）与
> `REPORT_qq_integration_baseline_2026-10-14.md`（触点基线）。本文记录 kyestu 侧的**能力层**、
> **retcode 判读表**、**媒体来源决策表**、**historySync 语义**与兼容性边界。
> 目标：高度利用 SnowLuma 特性，同时**对老 NapCat 保持行为兼容**（可区分、可回退）。

## 0. 架构落点

| 关注点 | 模块 | 性质 |
|---|---|---|
| retcode/status/wording 判读（双方言） | `src/pipeline/onebot-semantics.ts` | 纯函数（无 I/O） |
| 媒体来源决策表 + 签名 URL | `src/pipeline/onebot-media.ts` | 纯函数 |
| QQ 发送失败分类 + 冷却表 | `src/pipeline/cooldown.ts`（`QqSendClass` 一节） | 策略表 |
| QQ 健康/熔断 | `src/pipeline/qq-health.ts` | 状态机 + service_state 持久化 |
| message-store 本地镜像 | `src/pipeline/qq-messages.ts` + `qq_messages` 表 | sqlite |
| 传输与动作面 | `src/components/onebot.ts` | OneBotClient |
| 发送路径整合 | `src/components/target-qq.ts` | 组件 |
| 历史补缺 | `src/components/qq-history-sync.ts`（`app/qq-history-sync`） | 可配置组件 |
| 入站事件归一化 + 鉴权/幂等键 | `src/pipeline/qq-events.ts` | 纯函数（无 I/O） |
| 反应规则引擎（积木级 action） | `src/pipeline/qq-reactions.ts` | 纯函数 + 注入依赖 |
| 入站事件账本（去重/派发日志） | `src/pipeline/qq-inbound-store.ts` + `qq_inbound_events` 表 | sqlite |
| 入站事件源 + 反应执行 | `src/components/qq-ingress.ts`（`app/qq-ingress`） | 可配置组件（**默认关闭**） |
| 运维面 | `src/components/api.ts`（`/api/qq/*`、`/media/*`） | 显式 API |

**不引 `@snowluma/sdk` / `@snowluma/mcp` 新依赖**（见 §6 决策记录）；能力探测（`get_version_info` →
dialect）+ 内部能力层承担适配。

## 1. 桥方言判读表（P0-2 语义重钉）

成功判定：`status == "ok" && retcode == 0`（SnowLuma 唯一成功形态；NapCat 同）。

| 场景 | NapCat（老桥） | SnowLuma | 判读结果 | 同载荷重试 | 稍后重投 | 冷却 |
|---|---|---|---|---|---|---|
| 发送成功 | `status:ok retcode:0` | 同 | ok | — | — | — |
| 拒发（禁言/EventChecker） | `retcode:200`、`data.result=120` | **无此形态** | `rejected` | 否 | 是 | 30min |
| 业务失败 | retcode 其他非 0 | `retcode:100` + wording | `business`（按 wording 细分） | 见下 | 见下 | 见下 |
| ├ 禁言 | wording | wording「禁言/muted」 | `muted` | 否 | 是 | 10min |
| ├ 风控/冻结 | wording | 「风控/冻结/risk」 | `risk_control` | 否 | 是 | 30min |
| ├ 频率限制 | wording | 「频率/flood/rate limit」 | `rate_limit` | 否 | 是 | 5min |
| ├ 目标不存在/被踢 | wording | 「不存在/已退群/not found」 | `missing_target` | 否 | **否** | 24h |
| ├ 无权限 | wording | 「权限/forbidden」 | `permission` | 否 | **否** | 60min |
| ├ 临时失败 | wording | 「稍后/busy/临时」 | `transient` | 是 | 是 | 0 |
| └ 其他 | — | — | `other` | 是 | 是 | 0 |
| 参数/段校验失败 | — | `retcode:1400` | `bad_request` | 否 | **否** | 0 |
| 未授权（token 失效） | HTTP 401 | `retcode:1401` + HTTP 401 | `unauthorized` | 否 | **否** | 0 |
| 未知 action | — | `retcode:1404` | `unknown_action` | 否 | **否** | 0 |
| 请求体过大 | — | `retcode:1413` / HTTP 413 | `payload_too_large` | 否 | **否** | 0 |
| 桥内部错误 | HTTP 5xx | `retcode:1200` | `internal` | 是 | 是 | 0（熔断另计） |
| 网络/超时 | 同 | 同 | `transport` | 是 | 是 | 0（熔断另计） |
| 未识别非 0 retcode | 老语义=可重试 | — | `unknown` | 是 | 是 | 0 |

两轴定义（**不许混淆**）：

- **同载荷重试**（chunk 循环内 2 次尝试）：只有"同样的请求现在重试可能成功"的类才允许；
- **稍后重投**（router 重投，默认 5 次、指数退避）：修配置类（1400/1401/1404/1413/目标失效）直接丢弃 + taint，
  其余可重投（含 `rejected`/`muted`——冷却后恢复即可继续）。

判读入口：`classifyOneBotResponse(body)`（响应体）、`classifyOneBotError(err)`（HTTP/传输错误，含
`httpStatus` 优先）、`detectDialect(versionInfo)`（`app_name` 含 SnowLuma / NapCat）。错误对象携带
`verdict` 与 `redrivable`；`OneBotRetryLaterError.retryLater = true` 表示"稍后再试、不消耗重试预算"。

**NapCat 回归钉**：`retcode:200`（或 `result:120`）→ `OneBotNonRetryableError`（同载荷不重试），
与改造前一致；`tests/onebot-semantics.test.ts`、`tests/qq-target.test.ts` 钉住。

## 2. 媒体来源决策表（P0-1 解耦）

段构造单点：`target-qq.ts buildSegments` → `decideMediaSource`（`src/pipeline/onebot-media.ts`）。
`mode: auto`（默认）先看 dialect，再按优先级选源：

| # | 条件 | 源 | wire 值 | 备注 |
|---|---|---|---|---|
| 1 | dialect = napcat / generic（未知桥） | file | `file://<abs path>` | **兼容规则**：老行为逐字节不变 |
| 2 | 配了 `media.base_url` | url | `<base_url>/<rel>`（可选 HMAC 签名） | 桥自己下载，解除同文件系统 |
| 3 | 图片 且 ≤ `inline_max_bytes`（默认 1.5MB） | inline | `base64://<b64>` | 桥侧 `pickMediaSource` 直收 |
| 4 | `upload_file_stream` 可用 | stream | 先分块上传 → 桥本地路径 | 大文件解耦（4GiB 上限，sha256 校验） |
| 5 | `allow_file_fallback`（默认 true） | file | `file://<abs path>` | 兜底 = 旧耦合 |
| — | 以上全不可 | **抛错** | — | `allow_file_fallback:false` 时不静默回退 |

强制模式 `media.mode: file|url|base64|stream` 直接选源、缺失条件即抛错（不静默替换）。

- **URL 服务**（opt-in）：`app/api` 的 `media: { root, secret }` 开 `GET /media/<name>?exp&sig`
  （HMAC-SHA256 over `name:exp`，`exp` unix 秒，常数时间比较；防目录穿越，`cache-control: no-store`）。
  桥侧是普通 GET，无法带 Bearer，故用查询签名代替鉴权头。target 侧 `media.secret` 一致即可自动签名。
- **`upload_file_stream`**：NapCat Stream API wire（SnowLuma 兼容），`stream_id` 键 + `chunk_data`(base64)/
  `chunk_index`/`total_chunks`/`expected_sha256`/`is_complete`/`file_retention`（默认 600s）；客户端分块
  512KiB（`upload_chunk_bytes` 可调，受 HTTP 2MB body 上限约束），完成帧 `file_path` 直接进段。
- 生命周期：URL/inline/stream 三种源都不再要求"发送时文件还在桥的磁盘上"；`file://` 回退仍要求同文件系统
  （MediaStore 预算驱逐不受影响）。

## 3. message_id 落库与 message-store（P0-3）

- **落库**：每 chunk 的 `message_id` 收集进 `outbound_messages.provider_message_ids`（既有 JSONB 列，免迁移）；
  部分成功（前几 chunk 已发出）记 `partial`——**终态**，重投不会重复发已可见内容。
- **回执核对**：`target/qq` ops `verifyReceipts(outboundId)` 逐条 `get_msg`（SnowLuma 返回首收时持久化副本 +
  `real_id` + 图片 URL 重签），结果写回 `segment_results.receipts`。
- **撤回**：ops `recall(messageIds)` → `delete_msg`（依赖桥本地 store meta，收发皆可撤）。
- **显式 API**：`POST /api/qq/recall {message_ids:[…]}`、`POST /api/qq/receipts {outbound_id}`、
  `GET /api/qq/health`（`app/api`，Bearer 控制面鉴权；目标组件经 `api.qq_target` 指定，默认第一个 `target/qq`）。

### historySync（历史补缺）语义

组件 `app/qq-history-sync`（`docs/config.md`）：

- **镜像**：`get_group_msg_history`/`get_friend_msg_history`（锚点 `message_id` 可为负的 int32 哈希，
  `reverse_order:true` = 锚点及更旧）→ 归一化（`normalizeHistoryMessage`）→ `qq_messages` 表，
  `(scope, message_id)` 唯一去重；scope = `group:<id>` / `friend:<id>`。
- **补缺**：cursor（`service_state` `qq-history:<entry>:cursor`，最后一次同步的最新消息时间）与
  "最新页最旧消息"之间存在时间缺口（`gap_ms`，默认 2×interval）时，从最新页最旧消息起**锚点翻页回填**
  （每轮最多 `max_pages` 页 × `count` 条），直到触到 cursor 或预算耗尽——即"断线/失败窗口后从服务端拉历史回填"。
- **去重**：回填天然幂等（唯一键）；`QqMessageStore.has/list/latestTime` 供发送侧重投前核对"是否已可见"。
- **不回填 bus**（明确不做 + 理由）：kyestu 没有入站 QQ 消费链路（`docs/bus.md`：bus 承载的是文章指针，
  正文在 sqlite）；把 QQ 历史伪造成文章会凭空发明一个数据源语义（platform 表、a_id 语义、路由都不成立）。
  历史行服务**发送侧**去重/回执/审计，不进文章管线。若将来接 QQ 入站（命令/OCR 审核等），应新增独立的
  inbound 组件与频道，而不是把 history 当文章源。
  > **2026-10-14 修订（D20）**：QQ 入站通道已落地（`app/qq-ingress` + bus `qq` 频道，见 §9），
  > 上述"不做"的前提（无入站消费方）已消失——但**形态仍不是回填文章**：补缺的历史消息由
  > ingress 以 `recovered: true` 的入站事件重放进反应链路（§9 补缺口径），不伪造 platform/a_id。

## 4. 健康/熔断与失败重投（P1）

- **`qq-health` 状态机**（`ok ⇄ down`）：熔断类（transport/internal/rejected + muted/risk_control/
  rate_limit/temporary）开启冷却（`cooldown.ts` 表为下限，指数升级 30s→10min 封顶）；**配置错误类不熔断**
  （坏 payload 不该停整个 target）。持久化 `qq-health:<target>`，重启后冷却继续、过期不复活。
- **FI-01 语义**：发送前先过健康闸（**在 claim 之前**）——桥宕机/禁言窗口内**不新增 outbound 行**，
  事件以 `retryLater` 留在 router 队列（不消耗重试预算）；恢复分两路：被动（冷却过期后下一次发送即探针）+
  主动（`get_status` 的 `online`+`good`，可提前熔断关闭/续期）。
- **失败重投闭环**（补 router.ts 缺口）：dispatch 异常不再静默丢——
  `redrivable:false`（修配置类）立即丢 + taint；`retryLater` 按 5s×2ⁿ（上限 5min）延迟重试、
  `MAX_QUEUE_DEFERS=60` 兜底；其余按 `send_backoff_ms × 2ⁿ`（上限 60s）重投、
  `max_send_attempts`（默认 5，与 outbound 5 次上限对齐）后丢 + taint。队列仍写透 `service_state`。
- **outbound claim 语义细化**：`sent/partial/skipped/recalled` = 终态（重复投递直接幂等返回）；
  `failed` 行**立即**可回收（该次尝试已终止、无人持有 claim）但受 5 次上限；`sending` 行按 30min stale 窗回收
  （防崩溃中途的并发重发）；耗尽 → `exhausted` 判定、永不重投。

## 5. 事件/能力：支持与不支持清单

| SnowLuma 特性 | kyestu 状态 | 说明 |
|---|---|---|
| URL / base64 / data: / `upload_file_stream` 媒体 | ✅ | §2 决策表；`file://` 回退保留 |
| retcode 100/1400/1401/1404/1413/1200 判读 | ✅ | §1；NapCat 200/120 同时兼容 |
| message_id 落库 / `get_msg` / `delete_msg` | ✅ | §3 + `/api/qq/*` |
| `get_group_msg_history` 锚点翻页 + historySync 补缺 | ✅ | §3 |
| `get_status` 健康探测 + `bot_offline` 语义 | ✅ | `get_status` 主动探针 + **入站联动**（§9）：`bot_offline` notice / 账号下线通知 → `qq-health` 熔断（发送闸自动延后），账号上线提前合闸 |
| reply 引用预览（reply 段自动附原文） | ✅ | 反应 `reply`/`command` 动作带 `reply` 段引用触发消息（`SendInput.reply`），SnowLuma 自动附原文引用；发送链路复用（§9） |
| quick operation（上报响应 `{reply, at_sender}`） | ✅ | webhook 响应体即快捷操作（`quick_operation` action，§9）；仅 HTTP 上报通道（WS 通道未接） |
| 新 notice 事件（emoji_like/input_status/essence/group_card） | ✅ | 全部归一化入通道（§9 事件清单）；`bot_offline`/`essence` 已接健康/告警，其余可按规则挂动作 |
| `ocr_image` / `fetch_ptt_text` 内容理解 | ◐ | `OneBotClient` 未接（processor 契约是 text→text，媒体理解需新契约）；按 P2 择要不做，理由：改动面在 processor/媒体管线契约，收益待真实需求 |
| 多 UIN 路由 | ✅ | 多个 `infra/onebot`（首个占 `onebot` 共享键，其余经 node handle）+ `target/qq.onebot: <entry id>` 定向；入站事件带 `self_id` 归属标注，动作经 `target` 指向对应 UIN 的 target |
| notifications webhook（账号上下线） | ◐ | 桥侧模板化 body（`config/notifications.json`）；最小 JSON 形态 `{uin, event: online\|offline}` 可直接投递入站端点（Bearer 头可配在 channel `headers`），解析为 `notification` 事件并联动健康/告警；模板需自配 |
| `@snowluma/sdk` / `@snowluma/mcp` | ❌ | 见 §6 |
| markdown 段 / 富文本卡 | ❌ | 现状图片卡路径保留（可回滚），P1-6 另议 |

## 6. 决策记录（对应 docs/decisions.md D19）

1. **不引 `@snowluma/sdk`/`@snowluma/mcp`**：kyestu 的 OneBot 触点只有 5 个 action（现已扩到 ~12），
   手写 fetch 客户端 100 行内；SDK 引入 = 新依赖 + 版本耦合（SnowLuma 文档自述"早期开发、接口可能变"）+
   Bun/monorepo 兼容面。MCP 价值在运维查询，与 kyestu 现有 `/api/*` 控制面重叠。**保留内部能力层 + 能力探测**；
   若将来要引，须 pin 版本并单独论证（P2-8）。
2. **未知桥（generic）默认走 `file://`**：兼容优先。只有 SnowLuma（能力文档明确 URL/base64/stream 面）才
   自动走解耦路径；宁可保守也不给未知桥发它可能不认的段形态。强制模式可覆盖。
3. **部分成功 = `partial` 终态**：重投会重复可见内容，比丢一条更糟；需要补发时走人工（有 message_id 可核对）。
4. **historySync 不回填 bus**：见 §3 末。
5. **健康闸在 claim 之前**：outbound 行代表"已尝试发送"，停机期间的挂起事件属于 router 队列（有界、可持久化），
   不该伪装成失败发送记录（FI-01"不攒 failed 行"）。
6. **QQ 发送分类表落在 cooldown.ts**：冷却/分类策略单点（爬虫侧 `CrawlErrorClass` 与发送侧 `QqSendClass`
   同居一表文件），判读本身在 onebot-semantics 纯函数——策略与语义分离。

## 7. 测试与门禁

- `tests/onebot-semantics.test.ts`：双方言判读表（含 NapCat 200/result=120 回归钉）、wording 双语分类、
  两轴表、传输错误分类、dialect 探测。
- `tests/onebot-media.test.ts`：决策表全分支（含兼容规则、inline 上限、拒绝静默回退）、签名 URL 时效/篡改。
- `tests/qq-health.test.ts`：熔断升级/恢复、muted 长冷却、配置错误不熔断、主动探针、持久化再水合。
- `tests/qq-target.test.ts`（`Bun.serve` mock onebot）：message_id 落库、SnowLuma base64 媒体、
  NapCat retcode 200 回归、1400 不重投、FI-01 宕机不攒 failed 行+恢复自动继续、recall/receipts ops。
- `tests/qq-history-sync.test.ts`：镜像幂等、缺口锚点翻页补缺、cursor 持久化。
- `tests/router-queue.test.ts`：失败重投（有界）/不可重投即丢/retryLater 不耗预算。
- 全量门禁：`bun test`（基线 512 pass 不倒退）、`bun run typecheck`、`bun run smoke`。

## 8. 配置速查

```yaml
components:
  - id: onebot
    use: infra/onebot
    with:
      http_url: env:ONEBOT_HTTP_URL
      access_token: env:ONEBOT_TOKEN
      dialect: auto            # auto|napcat|snowluma|generic（auto 首次调用前探测 get_version_info）
  - id: qq-1
    use: target/qq
    with:
      group_id: 123456
      onebot: onebot           # 可选：多 UIN 时指向某个 infra/onebot 条目
      media:                   # 可选：媒体来源策略（默认 auto）
        mode: auto             # auto|file|url|base64|stream
        base_url: http://127.0.0.1:3000/media
        root: cache/media/store
        secret: env:KYESTU_API_SECRET
        signed_ttl_s: 600
        inline_max_bytes: 1500000
        allow_file_fallback: true
      health:                  # 可选：熔断参数
        probe_interval_ms: 30000
        base_cooldown_ms: 30000
        max_cooldown_ms: 600000
  - id: hist
    use: app/qq-history-sync
    with:
      group_id: 123456         # 或 friend_id
      interval_ms: 300000      # 0 = 只手动 sync()
      count: 20
      gap_ms: 600000
      max_pages: 20
  - id: api
    use: app/api
    with:
      secret: env:KYESTU_API_SECRET
      qq_target: qq-1          # /api/qq/* 的目标（默认第一个 target/qq）
      media: { root: cache/media/store, secret: env:KYESTU_API_SECRET }
```

## 9. 入站事件与反应（2026-10-14 D20）

> 口径：SnowLuma「高度支持」= **能反向监控 QQ 群内消息并做出反应**。本节即该能力的落地：
> 事件源 `app/qq-ingress`（webhook）+ 反应积木（`reply`/`forward`/`command`/`quick_operation`）。
> **默认关闭**：不配 `app/qq-ingress` 条目即无监听端口、行为与改造前逐字节一致。

### 9.1 通道与事件清单

SnowLuma `httpClients` / NapCat `httpPost`（OneBot v11 HTTP 上报）→ `POST <port><path>`
（默认 `3200` `/qq/events`）→ 鉴权 → 归一化（`pipeline/qq-events.ts`）→ 幂等账本
（`qq_inbound_events`）→ 镜像 `qq_messages` → bus `qq` 频道 → 反应规则。

| 事件 | kind | 双方言差异 | 归一化字段 |
|---|---|---|---|
| 群/私聊消息 | `message` | `message` 字段段数组（SnowLuma/array）或 CQ 串（NapCat/string）都解析 | scope(`group`/`friend`)、groupId、userId、senderName/Role、messageId、text、mentions(@)、selfId、time、raw |
| 自身消息回显 | `message_sent` | 需桥侧 `reportSelfMessage:true` | 同上；默认**不反应**（防死循环） |
| notice | `notice` | NapCat 经典面（`group_increase/decrease/ban/admin/recall/notify(poke,…)/group_upload/friend_add`）+ SnowLuma 新增 `bot_offline`、`essence(add/delete)`、`group_card`、`notify/input_status`、`group_msg_emoji_like(add/remove)` | noticeType/noticeSubType、groupId/userId/messageId |
| 请求 | `request` | `friend`/`group`（quick operation 可 `approve`） | requestType、text(comment)、flag（raw） |
| 心跳/生命周期 | `meta_event` | `heartbeat`/`lifecycle` | metaEventType |
| 账号上下线通知 | `notification` | 桥侧 notifications webhook（模板化 body）；最小 JSON 形态 `{uin, event: online\|offline}` | noticeType=`account`、noticeSubType=online/offline |

多 UIN：事件 `self_id`（webhook 头 `X-Self-ID` 同值）即归属 UIN，规则可用 `match.self_ids` 过滤、
动作用 `target` 指向该 UIN 的 `target/qq`（`target/qq.onebot` 多 UIN 定向不变）。

### 9.2 鉴权（fail-closed）

- `secret` 必填（缺失拒启，与 `app/api` 同一 fail-closed 纪律）；双兼容两选一：
  1. **HMAC** `X-Signature: sha1=<hmac-sha1-hex(secret, 原始 body)>`（SnowLuma/NapCat httpClients 原生签名，
     secret = 该适配器 `accessToken`）——常数时间比较，篡改/错钥即 401；
  2. **Bearer** `Authorization: Bearer <secret>`（NapCat `accessToken` 头语义 / notifications channel 可配 headers）。
- `GET <path>` 返回统计（`received/duplicates/skipped/bad/recovered/reactions/actionErrors/ledger`），仅 Bearer。

### 9.3 幂等与坏事件

- 账本表 `qq_inbound_events`（`dedupe_key` 唯一）：消息事件键 = `msg:<scope>:<message_id>`（scope 同
  `qq_messages` 格式 `group:<id>`/`friend:<id>`），其余 = `evt:<raw 哈希>`。**webhook 重发/补发重放
  命中唯一键即返回、零反应**——这是"防 webhook 重发重复反应"的唯一事实源。
- 坏事件（非 JSON / 无法识别的负载）记 `bad` 行 + 返回 400，**跳过不崩**；handler 异常逐动作隔离
  （记入账本 `detail` + fiber taint），端点永不受影响。

### 9.4 规则 schema（配置驱动，规则可挂多动作）

```yaml
rules:
  - id: on-ping
    match:                       # 全部字段 AND，列表内 OR；不填=通配
      kinds: [message]           # message|message_sent|notice|request|meta_event|notification|unknown
      groups: [555]              # 群号
      users: [10001]             # 发言人
      self_ids: [234567890]      # 归属 bot UIN
      text_prefix: '#ping'
      text_regex: '^#(status|recall)'
      notice_types: [bot_offline, essence]
      notice_sub_types: [add]
      admins_only: false         # true=仅 admins 白名单可触发
    skip_recovered: false        # true=历史补缺重放的事件不反应
    cooldown_ms: 30000           # 每（群, 规则）最小间隔
    limit: { window_ms: 600000, max: 10 }   # 每（群, 规则）窗口配额
    actions:
      - type: reply              # 引用回复到事件所在群/好友（走 target 发送链路）
        text: 'pong {sender}'    # 模板：{text} {user_id} {group_id} {message_id} {sender} {self_id} {kind}
        quote: true              # 附 reply 段引用原消息（SnowLuma 自动附原文）
        at_sender: false
        target: qq-1             # target/qq 条目（默认 default_target）
      - type: forward            # 命中事件转告警目标
        to_group: 9999           # 或 to_users: [10001] / to_admins: true
        prefix: '[alert] '
        include_text: true
        target: qq-1
      - type: command            # 内置命令（status 健康快照 / recall 撤回）
        name: status             # recall 在命令内部强制 admin 白名单
        target: qq-1
      - type: quick_operation    # 直接作为 webhook 响应体（OneBot 快捷操作）
        reply: 'ack {user_id}'   # {reply, at_sender, auto_escape, delete, ban, ban_duration, kick}
        at_sender: false         # request 事件支持 {approve, remark, reason}
```

- **quick operation**：HTTP 上报的响应体即快捷操作（SnowLuma `network/quick-operation.ts` 确认
  `reply/at_sender/delete/ban/kick` 与 request 的 `approve`）；每事件**首个** `quick_operation` 生效，
  只对 `message`/`request` 事件规划（notice 无快捷操作面）。
- **command**：`status`（目标 `health()` 快照）、`recall <message_id>`（撤回；**命令内部强制 admin 白名单**，
  不依赖规则的 `admins_only`）。

### 9.5 防呆与可靠性（丢谁兜、谁不兜）

| 风险 | 机制 |
|---|---|
| 自触发/死循环 | `message_sent` 与 `user_id == self_id`（含已知 `self_ids`）默认跳过（`include_self_messages: true` 可开）；转发再进站依赖桥 `reportSelfMessage`，默认关 |
| 刷屏 | 每（群,规则）`cooldown_ms` + `limit` 配额（内存态，reload 重置——防抖非性计费，D20 显式决定） |
| 坏事件 | 记 `bad` 账本行 + 400，跳过 |
| handler 失败 | 逐动作 try/catch，后续动作照跑；账本记 `error` + detail，fiber 记 taint；**持续失败不自动重试**（防失败风暴），可见性靠账本/统计 |
| 漏监控（断线窗口） | **historySync 补缺联动**（下节） |
| 崩溃中途 | 账本 `received`/stale `dispatching`（默认 5min）行下次补缺 pass 重派发；已发动作由 outbound claim（键含 rule/action/dest）幂等去重，不会双发 |

**补缺语义（与 `app/qq-history-sync` 打通）**：`recover: { enabled, history_sync: <entry id>, interval_ms,
max_age_ms, max_events, stale_dispatch_ms }`——每次 pass 先 `sync()`（最新页+锚点翻页回填 `qq_messages`），
再取该 scope 内**无账本行**的历史消息（限 `max_age_ms`/`max_events`、跳过 bot 自身消息）以
`recovered: true` 重放进反应链路；规则可 `skip_recovered: true` 排除（例如不想给补出来的旧消息发引用回复）。
入站事件本身因此是**至少一次**（ledger + 历史回补）；反应执行至少一次到 **claim 幂等**为止。

### 9.6 加一个新 handler 的步骤

1. `src/pipeline/qq-reactions.ts`：`QqAction*` 类型 + `ACTION_TYPES` 增名 + `dispatchActions` 里加执行分支
   （保持"逐动作 try/catch 隔离"与 `reactionInput` 的幂等键格式）；若是新内置命令，加进 `COMMANDS` 表
   （危险命令在命令内部强制 admin 白名单，参照 `recall`）。
2. `compileRules` 增加该动作的配置校验（坏配置在 apply 期 fail fast，不静默）。
3. 测试：`tests/qq-events.test.ts`（纯层）+ `tests/qq-ingress.test.ts`（链路）；`testset/cases/96-snowluma.yaml` 登记。
4. 文档：本节 9.4 schema 与 9.5 防呆表同步。

### 9.7 配置速查（默认关闭）

```yaml
components:
  - id: qq-ingress
    use: app/qq-ingress
    with:
      port: 3200                      # webhook 监听端口
      path: /qq/events
      secret: env:KYESTU_QQ_WEBHOOK_SECRET   # 必填：HMAC 密钥 = 桥适配器 accessToken（同时是 Bearer）
      default_target: qq-1            # 动作缺省 target（target/qq 条目）
      health_target: qq-1             # bot_offline/账号通知联动的健康板（默认同 default_target）
      admins: [10001]                 # 管理员白名单（admins_only 规则 + recall 命令）
      self_ids: [234567890]           # 已知 bot UIN（自身消息抑制；运行中自动学习 self_id）
      include_self_messages: false
      rules: [ ...见 §9.4... ]
      recover:                        # historySync 补缺联动（可选）
        enabled: true
        history_sync: hist            # app/qq-history-sync 条目 id
        interval_ms: 300000           # 0=只手动/开机 pass
        max_age_ms: 3600000
        max_events: 200
        stale_dispatch_ms: 300000
```

完整可抄样例：`examples/qq-ingress.example.yaml`。
