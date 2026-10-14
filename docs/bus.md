# infra/bus 语义

`infra/bus`(src/components/bus.ts)是文章主链路、会话健康事件与 QQ 入站事件的**进程内同步事件发射器**。本文档把它此前从未成文的语义一次写清:哪些保证有、哪些保证**没有**、丢失时谁兜底。

## 频道

频道是编译期硬编码的 `BusEventMap`,运行期无校验:

| 频道 | 载荷 | 生产方 | 消费方 |
|---|---|---|---|
| `article` | `{ platform, id, a_id, crawlerId }` | crawler(文章落库后) | router |
| `live` | 直播开始/结束(handle/file/m3u8 等) | crawler(live-relay) | live-player |
| `session` | 会话健康 `transition` / jar `expiring` 事件 | cookie-keepalive | cookie-keepalive 自身(resume 后 re-arm 已隔离任务)+ 进程日志订阅(8-17 教训:状态迁移必须带外可见) |
| `qq` | 归一化 QQ 入站事件本体(`QqInboundEvent`：kind/scope/发言人文本/@/message_id/self_id/recovered + `key` 账本键) | app/qq-ingress(webhook 入站 + history 补缺重放) | 内置反应规则引擎(app/qq-ingress 内)+ 任意订阅者(审计/OCR 等后续组件) |

**新增频道 = 改 bus.ts 的 `BusEventMap` 本体**,不是扩展点。

## 语义(逐条,含反保证)

- **同步 emitter**:`emit` 同步逐个调用 handler,发布者返回时所有订阅者已执行完。无队列、无异步化。
- **异常吞噬**:单个 handler 抛错被 catch 吞掉,不影响其余 handler 与发布者(bus.ts 注释 "consumer faults isolated from publishers")。订阅者的故障不会变成发布者的 taint——**订阅者要自己为自己的失败负责**。
- **无背压、无持久化、无重放、无至少一次**:emit 即抛;订阅者不在线(fiber 未 ACTIVE / 未订阅)事件就丢了。
- **消息载体只是 DB 主键**:`article` 事件只带 `{platform, id, a_id}`,router 收到后回 sqlite 重取正文(router.ts `articles.getWithRefs`)。**sqlite 才是事实上的消息体,bus 只是指针铃铛**——所以"订阅者不在线丢事件"的实际含义是"丢一次指针通知",不是丢文章。

## 可靠性兜底(丢事件时谁接住)

- **crawler→router 段**:router 的内存队列已写透到 `service_state`(router.ts `routerQueueStore`),fiber 重载/进程重启后按 outbound 记录对账重建;target fiber 暂未起来时有界重试(默认 ~1 分钟),超限丢弃并记 router 的 taint——丢不再是静默的。
- **router→target 段**:sqlite 幂等兜底——`outbound.claim` 幂等键 + stale reclaim + 尝试上限,`forward_by` 文章级去重(参见 src/pipeline/outbound.ts)。**失败语义（2026-10-14 D19 起）**：dispatch 异常不再静默丢——修配置类(`redrivable:false`)立即丢 + taint；`retryLater`(claim 被持有/QQ 熔断中)退避重试不消耗重试预算（`MAX_QUEUE_DEFERS` 兜底）；其余按 `send_backoff_ms` 指数退避重投、`max_send_attempts`(默认 5)后丢 + taint。原"target 抛错=drop 不重试"的不对称已被 D19 推翻并转为裁决。
- **session 段**:事件是瞬态信号(某 key 何时迁移、何时将过期);**当前状态永远在 SessionHealthBoard 里**(`ctx.get('cookie-health')` / `/api/cookie-health`),丢一条 transition 事件不丢状态。board 本身写透 `service_state`。
- **qq 段(2026-10-14 D20 起)**:与文章相反,`qq` 载荷是**事件本体**(QQ 消息没有可回取正文的外键语义,原始报文已落 `qq_inbound_events` 账本,`key` 即账本键)。丢失兜底:① 事件本身 = 账本 + `qq_messages` 镜像 + `app/qq-history-sync` 补缺口径——断线窗口漏掉的消息由 ingress 以 `recovered:true` 重放(至少一次);② 反应执行 = outbound claim 幂等(键含 rule/action/dest),重放不会双发;③ 崩溃中途派发由 stale `dispatching` 重派发兜住。bus 丢一条 `qq` 事件 = 丢一次即时通知,不丢事件事实。细节见 docs/snowluma.md §9。

## 与其他通信机制的边界

- bus 传**领域事件**(文章、直播、会话健康);runtime 的 lifecycle/taint/timeout 事件(`KyestuEvent`)是另一条流,经 `createRoot({ onEvent })` 订阅,main.ts 把它接到进程日志(lifecycle 记 info,taint 记 warn,guard timeout 记 error)。两者互不经过对方。
- 跨 fiber 的服务调用**不走 bus**:router→formatter/target 是 `api<T>()` 直调(见 src/loader/loader.ts 的 NodeHandle),bus 只承担"有新文章"这一类通知。
