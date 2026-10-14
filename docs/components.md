# 组件开发指南

本文是"给 kyestu 新增/修改组件"的触点清单与纪律汇总。配置面语义（components/routes/needs/isolate/reconcile）见 docs/config.md；bus 语义见 docs/bus.md；作者义务的决策背书见 docs/decisions.md D18。所有引用均已对照当前代码核实（2026-08-21）。

## 0. 组件是什么

一个组件 = `Component<C>`（src/core/types.ts:17-29）：

```ts
interface Component<C = unknown> {
  name?: string
  inject?: Key[]        // 声明的 coeffect 依赖（激活前提）
  provide?: Key[]
  knownWithKeys?: string[]  // 本组件消费的 with 键（见 §5）
  apply: (ctx: Context, config: C) => MaybePromise<EffectResult>
}
```

- 配置条目（`components:` 里的一条）经 loader 实例化为一个 fiber；`apply(ctx, with)` 收到的 config 是 `{ ...entry.with, __id, __needs }`（loader.ts:187）——`__id` 是 entry id，`__needs` 是 needs 列表。
- `apply` 返回的逆（函数/生成器/异步生成器）按 LIFO 在卸载时回放；也可在内部多次 `ctx.effect(...)` 注册配对的效果/逆。
- loader 为每个 entry 自动提供 `node:<id>` 句柄（`NodeHandle`），消费方经它拿到 `api<T>()`（loader.ts:36-39）。

## 1. 新增 crawler（最贵，四处触点）

以新增一个平台为例，触点全部要动；若是已有平台的新 kind（如 x-list 之于 x），只需前两条。

1. **spider 插件 + 注册表**：在 `packages/spider` 实现 Spider 子类并包成 `SpiderPlugin`（`id`/`platform`/`priority`/`urlPattern`/`create`），注册进 `packages/spider/src/spiders/index.ts` 末尾的 `SpiderRegistry.getInstance().register(...)` 链。crawler 组件经 `spiderRegistry.findByUrl(url)` 按 URL 匹配插件（components/crawler.ts:47-49）。
2. **CRAWLER_KINDS**：把 kind 加进 `src/components/index.ts:29` 的 `CRAWLER_KINDS` 数组，`defineAll` 会自动注册 `crawler/<kind>`。
3. **平台表 + migration**（仅新平台）：`src/pipeline/articles.ts:24-31` 的 `TABLES` 映射（`Platform` → `<platform>_article` 表）+ `assets/migrations/` 新增建表迁移；同时更新 `src/components/crawler.ts:38-44` 的 `PLATFORM_NAME`（spider 的 `Platform` 枚举值 → 平台名）。
4. **策略分支**：平台级冷却/重试特例在 `src/pipeline/cooldown.ts`——`shouldRetry`（:68-69，如 instagram timeout 不重试）与 `hit` 里的 `IG_OVERRIDES` 覆写（:126-129）。新平台有风控特例时在这里加分支。

crawler 的 `with` 键面：调度（`schedule`/`hot_schedule`/`cron`/`timezone`）、会话与浏览器路由（`cookie_file`/`session_profile`/`browser_mode`/`device_profile`）、`post_processors`/`live_relay`/`interval_time`，以及整包透传给 `spider.crawl()` 的 spider 级键——全部列在 `CRAWLER_KNOWN_WITH_KEYS`（components/crawler.ts:100-114），新增键要同步加进去。

## 2. 新增 processor（最干净）

契约是 `ProcessorApi`（src/types/api.ts:58-61）：`process(text, context?) => Promise<string>`。两步：

1. 实现 client 并 `ctx.expose(client)`，对象满足 `ProcessorApi`。
2. 在 `src/components/index.ts` 的 `defineInfra` 里 `.define('processor/<name>', component)`。

最小示例（processor/rules 的实际形态，src/components/processor-rules.ts:38-56）：

```ts
export const myProcessorComponent: Component<MyConfig> = {
  knownWithKeys: ['action', 'name', /* ...实际消费的键 */],
  apply: (ctx, config) => {
    ctx.expose(new MyProcessorClient(config)) // client 实现 process()
  },
}
```

消费侧不需要路由边：crawler 经 `post_processors` 在抓取期惰性解析 `node:<processor_id>` 的 api（crawler.ts:153-154、201-207），或经 needs 边在 apply 期绑定（crawler.ts:147-149）。

## 3. 新增 target（中等）

契约是 `TargetApi`（src/types/api.ts:47-50）：`send(input: SendInput) => Promise<void>`。步骤：

1. 实现 `rawSend(input, text)`（本平台的真实发送：幂等 claim、协议调用、失败 mark），交给 `TargetRuntime`（src/pipeline/target-runtime.ts）复用策略门闸/媒体可见性/摘要卡聚合/digest 合并/30s flush 扫描。
2. 组件里 `ctx.effect(() => runtime.startFlushLoop())` 挂定时器逆，然后 `ctx.expose({ send } satisfies TargetApi)`（参照 target-qq.ts:76-83）。
3. 在 `defineAll` 里 `.define('target/<platform>', component)`。

**路由自动发现**：target 不需要登记到 router。`app/router` 持有 routes 配置（main.ts:78 注入），收到 article 事件后按 `route.from === crawlerId` 匹配，取 `via` 末位为 formatter、`to[]` 为 target id，经 `ctx.get<NodeHandle>(nodeKey(targetId))?.api<TargetApi>()` 直调（router.ts:43-63）。所以新 target 只要写进 routes 就上线；target fiber 未 ACTIVE 时事件留在持久化队列里有界重试（默认 ~1 分钟，超限丢弃并记 taint，见 docs/bus.md）。

幂等与去重不要自己另写：`OutboundStore.claim/mark/markForwarded`（pipeline/outbound.ts）+ `forward_by` 是既有兜底。claim 判定四态：`sent`（终态幂等）、`exhausted`（5 次预算耗尽、永不重投）、`in_progress`（他人持有 claim，抛 `OneBotRetryLaterError` 稍后重试）、`null`（本次持有、必须发送）；`partial`（部分 chunk 已可见）也是终态，禁止整条重投。

`target/qq` 的 `with` 键面：`group_id`、`min_interval`、`onebot`（多 UIN 时指向 `infra/onebot` 条目 id）、`media`（媒体来源策略，见 docs/snowluma.md §2/§8）、`health`（熔断参数）+ `TARGET_RUNTIME_KNOWN_WITH_KEYS`；契约是 `QqTargetApi`（types/api.ts：`send` + SnowLuma 运维 ops `recall`/`verifyReceipts`/`health`/`noteBridgeEvent`）。`SendInput` 另有两个可选字段服务**入站反应**（types/api.ts）：`dest: { kind: 'group'|'private', id }`（目的地覆盖——反应发到事件所在群/好友，缺省仍是目标的 `group_id`）与 `reply: { message_id }`（引用段，SnowLuma 自动附原文引用）。

### 入站事件源与反应积木（app/qq-ingress）

入站侧的组件形态（语义规范 docs/snowluma.md §9）：

1. **事件源**：`app/qq-ingress` 自持 webhook 端点（`Bun.serve`，逆= `server.stop`）+ `ctx.effect` 定时补缺 pass；鉴权 HMAC `X-Signature`/Bearer 双兼容，secret 缺失拒启（与 app/api 同一 fail-closed 纪律）。归一化/鉴权/规则匹配是纯函数（`pipeline/qq-events.ts`、`pipeline/qq-reactions.ts`），组件只做 I/O 与生命周期。
2. **服务面选择**：归一化事件经 **bus `qq` 频道**广播（载荷=事件本体+账本键），反应规则在组件内直调执行（quick operation 需要同步回 HTTP 响应体，走 bus 异步订阅拿不到）；外部订阅者（审计/OCR）可另挂 bus。
3. **跨 fiber 解析**：动作对 target 的调用经 `node:<id>` 句柄**惰性解析**（同 api.ts hooks 模式），不加 needs 边——target 重建不级联进 ingress（J1）。危险内置命令在命令内部强制 admin 白名单（`recall` 范式）。
4. **持久化**：事件账本 `qq_inbound_events`（dedupe_key 唯一 + 派发日志 `received→dispatching→ok/error/skipped|bad`）走 sqlite；配额按 D20 显式决定为内存态。

## 4. ctx.set vs expose vs bus：服务面怎么选

| 机制 | 适用 | 实证 |
|---|---|---|
| `ctx.set(key, value)` | 跨 fiber 共享的**活对象/长寿命服务**（db、bus、browser-pool、cookie-health board），消费方 `ctx.get` 读取，reactive notify 驱动重建 | db.ts:64、bus.ts、cookie-keepalive |
| `ctx.expose(api)` | 本 entry 的**服务契约**，消费方经 `node:<id>` 句柄 `api<T>()` 直调；**单槽**（runtime.ts:121-129，后写覆盖），一个 entry 只能 expose 一个对象——要暴露多个方法就装进一个对象 | target-qq.ts:78、llm-openai.ts:396、formatter.ts:137 |
| bus 频道 | **领域事件通知**（"有新文章/直播状态变了/session 健康迁移"），载荷只是指针，正文回库重取；可丢，兜底语义见 docs/bus.md | crawler→router、cookie-keepalive |

经验法则：要"被调用"用 expose；要"被发现并随生命周期反应式重建"用 ctx.set；要"广播一个已发生的事实"用 bus。**不要**用静态 import 包函数绕过 fiber 世界传组件状态。

expose 的消费方类型契约集中在 `src/types/api.ts`（纯类型模块）：定义端 `satisfies`、消费端 `api<TargetApi>()` 从同一处 import，签名漂移在定义端即 tsc 报错，不再是运行期 `as T` 惊喜。

## 5. apply(ctx, with) 纪律与 knownWithKeys

- **`knownWithKeys` 必填**：列出本组件实际消费的 `with` 键（把整包配置透传给插件层的组件要把插件键也列上，如 crawler 的 spider pass-through 面）。loader 校验期对未列出的键 `console.warn` 告警（不拒绝，保持兼容；loader.ts:114-122）——拼错的键不再静默吃默认值。examples/config.minimal.yaml 曾带死键无人发现，此机制即为此而设。
- **每开一个东西就还一个逆**：定时器/订阅/端口/子进程都必须经 `ctx.effect` 配对返回逆（crawler.ts:276-288、target-qq.ts:77 是范例）。禁止模块级裸状态与裸 `setTimeout`（现存唯一反例 bilibili-reconcile 已登记为技术债，见 D18-4）。
- **错误归属**：apply 内后台循环的异常用 `ctx.root.reportTaint(ctx.fiber, 'apply', error)` 记到自己 fiber 的 taints（crawler.ts:281 范例），不要裸 `catch {}` 吞掉。
- **跨 fiber 调用的错误记的是调用方**：router 调 target.send 失败记 router 的 taints（router.ts:94-96），对端无感知——写 target 时自己的可观测性要自己负责（打日志/记状态）。

## 6. 持久化：ServiceStateStore 模式

组件内存态需要活过 fiber 重建/进程重启时，走 `ServiceStateStore`（src/pipeline/service-state.ts，落在 `service_state` 表）：

- **键命名空间**：`<ns>:<scope>[:...]`，scope 一般用 entry id（`config.__id`）保证 per-entry 隔离。现存前缀：`session-health:<key>`、`cooldown:<entry>:<url>`、`llm-circuit:<entry>`、`router:<entry>:queue`、`digest:<target>:buffer` / `:first-sent-windows`。
- **write-through**：内存结构仍是运行时主副本；只在**状态迁移**时写库，绝不进每轮热路径。
- **构造期水合**：在 apply（或构造器）里同步 `load()` 一次恢复（参照 TargetRuntime 构造器 target-runtime.ts:72-74、router.ts:71-79）；坏行必须静默丢弃走内存默认（`parseJson` 模式），不能让一行脏数据挡住 boot。
- 恢复路径有外部事实可对账时**先对账再重放**（router 队列水合前先查 outbound，已派发的直接丢）。

## 7. 提交前自检

- `bun run typecheck` 干净（含 src/types 的 shim 面；改了 vendored 包接口时同步 shim，tests/shim-drift.test.ts 会盯漂移）。
- `bun test` 全绿；新组件至少带：apply/dispose 幂等、逆真恢复（witness）、knownWithKeys 与文档一致。
- 新增 `with` 键 → 更新本文 §1-3 相应清单与组件的 `knownWithKeys`；新增通信机制 → 先读 D16（异步契约纪律）再动手。
