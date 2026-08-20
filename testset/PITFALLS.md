# idol-bbq Cordis 重构 · 潜在坑登记表

来源：2026-08-16 对 `idol-bbq-utils`（main HEAD + 维护完成后状态）的只读全量审计。
每条给出旧代码锚点（file:line）、风险、对策、覆盖测试文件。
cases/ 下的测试文件按这里的前缀引用。

## A. 键控状态连续性（最高危：失效=重复发送/重复上传）

| # | 坑 | 锚点 | 对策 | 测试 |
|---|---|---|---|---|
| A1 | target 无显式 id 时用 `md5(JSON.stringify(cfg))`，key 序依赖对象构造顺序；新系统配置规范化一旦注入默认值/改字段序，md5 全变 → outbound/target_health/forward_by 换键 → 去重失效 → 群发重复 | forwarder-manager.ts:1033 | 新系统强制显式 id；一次性写旧 md5→新 id 迁移映射 | OB-01, SH-03 |
| A2 | routeKey / articleOutboundKey / syntheticOutboundKey / payload_hash 的确切字符串格式是去重 CAS 的键 | outbound-message-service.ts:156-228 | 字节级保持一致，或一次性迁移 | OB-02/03 |
| A3 | content fingerprint claim 后异常路径必须 release，否则永久抑制该内容 | forwarder-manager.ts:2826-2939 | 指纹生命周期挂 fiber effect 逆 | OB-09, LC-07 |
| A4 | media visibility slot 同理（claimVisibleSlot/release） | db/index.ts:1121+ | 同上 | OB-10 |
| A5 | processor 实例缓存键 = config-md5，同样字段序敏感 | spider-manager.ts:1478, forwarder-manager.ts:5811 | 规范化序列化（stable stringify） | PR-07 |

## B. 事件序与隐式时序

| # | 坑 | 锚点 | 对策 | 测试 |
|---|---|---|---|---|
| B1 | `spider:task:finished` 有两个监听者（SpiderTaskScheduler、ForwarderTaskScheduler），注册顺序即语义 | spider-manager.ts:1745, forwarder-manager.ts:593 | 新事件模型显式声明消费方与顺序 | LC-08, SH-01 |
| B2 | `immediate_notify` 是有意的 no-op TODO | forwarder-manager.ts:888 | 保持 no-op 或显式实现，二选一钉住 | SH-01 |
| B3 | generation 销毁不取消 in-flight promise → 旧代 async 完成后写库（ghost write） | runtime-controller.ts:419 + 全链路 | fiber teardown 等/取消在途任务（惯性+超时）；写库带代际令牌 | LC-05, LC-08 |

## C. 调度保真（改错=抓取节奏变=风控风险）

| # | 坑 | 锚点 | 对策 | 测试 |
|---|---|---|---|---|
| C1 | `nextCrawlerRunAt` 用稳定哈希 jitter，换哈希=换节奏 | crawler-schedule-service.ts:311-320 | 哈希算法原样移植 | SC-01 |
| C2 | soft-start：停机≥15min 才 warmup 2min、每 tick 限 1 分发 | runtime-heartbeat-service.ts:39-57 | 原样移植 | SC-04 |
| C3 | hasActiveCrawlerTask 防重入 + TaskQueue 幂等键 | spider-manager.ts:1037, db/index.ts:688 | 保留 | SC-03 |
| C4 | minGap 60s 下限，jitter 不得破 minGap | crawler-schedule-service.ts:341 | 保留 | SC-02 |

## D. 冷却/风控语义（账号安全参数）

| # | 坑 | 锚点 | 对策 | 测试 |
|---|---|---|---|---|
| D1 | RISK_COOLDOWN_MS 全表 + IG 专属 override | spider-manager.ts:78-90 | 全表钉死 | HC-01 |
| D2 | 升级 ×2^n（≤×8）cap 6h；遵守 Retry-After cap 6h | spider-manager.ts:2114-2149 | 原样移植 | HC-02 |
| D3 | 不重试类别：auth/rate_limit/parser/private_unfollowed/invalid_handle；IG 连 timeout 都不重试 | spider-manager.ts:396-416 | 保留 | HC-03 |
| D4 | 冷却键隔离粒度：旧格式 platform:host:profile[:igHandle] —— handle 级隔离最初只给 IG；2026-08-20 @sally_amaki 被风控误判 invalid_handle，单号冷却冻结全部 8 个 TT 目标 ~6h/次（idol-bbq-utils 5693a86 已把 per-handle scope 扩到 TikTok）；kyestu 直接按完整 target URL 键控（crawler.ts round 循环），语义 = 单目标失败绝不波及同会话兄弟目标 | spider-manager.ts:2074-2088, crawler.ts:213-236 | 键格式可变，隔离语义必须钉死：任何分类的冷却都不得跨 target 泄漏 | HC-01, HC-07 |
| D5 | 负缓存族：X replies-404 30min / rest-id 24h / 查询id 12h / IG profile 120s / TT secuid 6h / invalid 24h | x.ts:160-163, tiktok.ts:429-441, instagram.ts:651 | 全部钉死 | HC-04/05 |

## E. 去重叠叠（最易回归区）

| # | 坑 | 锚点 | 对策 | 测试 |
|---|---|---|---|---|
| E1 | ForwardBy.checkExist 的 translation-passthrough 例外 | forwarder-manager.ts:2174 | 钉住 | OB-08 |
| E2 | outbound claim CAS + 30min stale reclaim + 60s·2^n≤3600、5 次终败 | db/index.ts:1496-1590, outbound-message-service.ts:30 | 钉死 | OB-03/04/05 |
| E3 | findLatestVisibleCompletion 跨键去重 | forwarder-manager.ts:2731 | 钉住 | OB-07 |
| E4 | 媒体三级跨平台去重（exact/指纹/短视频）+ per-target 可见槽 | media-cache-service.ts:491-880 | 钉住 | OB-10/11 |
| E5 | >2h 旧文章跳过；errorCounter≥3 放弃并标 ForwardBy | forwarder-manager.ts:2360, 3104-3127 | 钉住 | OB-12 |
| E6 | 非 live 发送模式下 dedup/媒体批次被禁用——影子对比时必须先把这类预期发散白名单化 | render-service.ts:246, base.ts:566 | 标定差异白名单 | SP-10, SH-02 |

## F. 聚合/摘要

| # | 坑 | 锚点 | 对策 | 测试 |
|---|---|---|---|---|
| F1 | summary 队列 DB 持久化 + 开机恢复；**drop 时故意保留未发队列** | forwarder-manager.ts:1057, 1464 | 新 fiber teardown 不得丢也不得重发 | AG-01/02, LC-06 |
| F2 | failureGeneration 键轮换 cap 3 | forwarder-manager.ts:5598-5616 | 钉住 | AG-05 |
| F3 | tag digest 状态是纯内存（reload 即失忆）——新系统要么接受要么改，必须显式决定 | forwarder-manager.ts:964 | 显式决策并钉测试 | AG-06 |
| F4 | digest 发送用 synthetic outbound key | outbound-message-service.ts:228 | 格式钉住 | AG-07 |

## G. 渲染

| # | 坑 | 锚点 | 对策 | 测试 |
|---|---|---|---|---|
| G1 | drop-failed 必须先于 hydrate（hydrate 的 fallbackIndex 会错配相邻图）——审计 §9.1 已报，确认修复并钉住顺序 | render-service.ts:310-318, 775-819 | 顺序钉死 | RN-05 |
| G2 | render_type 矩阵全语义（视频豁免、>1000 字降 headline、website 专用文本、卡位置前/后、img 失败回退全文） | render-service.ts:389-489 | 全矩阵钉住 | RN-01..04 |
| G3 | task-manager 每次 new RenderService vs ForwarderPools 长存实例——缓存局部性不同；统一为 provider 后命中率变化是有意行为差异 | task-manager.ts:521, forwarder-manager.ts:996 | 统一并记录差异 | RN-07 |
| G4 | RENDER_REMOTE_ASSETS=0 是 hermetic 测试开关 | core/render img/index.ts | 测试默认开 | RN-10 |

## H. LLM processor

| # | 坑 | 锚点 | 对策 | 测试 |
|---|---|---|---|---|
| H1 | Google translator 持有持久 ChatSession（多轮上下文是隐性语义）；重写变 stateless 会漂移翻译风格 | processor/google.ts:56-67 | 显式决策（建议 stateless + release note） | PR-01 |
| H2 | PROCESSOR_ERROR_FALLBACK 哨兵 + isValidResult；crawl 期翻译失败=null 不落库 | processor/base.ts:11/121, spider-manager.ts:2648 | 钉住 | PR-02/03 |
| H3 | Hy3 breaker 文件态（阈值10/freeze30min/读后半开/key=processor 名）迁到 provider 健康态 | hy3-circuit-breaker-service.ts:27-57 | 参数钉死 | PR-05, FI-04 |
| H4 | prompt asset glossary 截断规则、output schema、env: 密钥解析 | processor-prompt-asset-service.ts:58-150, processor/base.ts:13-28 | 钉住 | PR-04/06 |

## I. 浏览器/cookie

| # | 坑 | 锚点 | 对策 | 测试 |
|---|---|---|---|---|
| I1 | `__websiteResourceGuard` 拦截器留在 page 上跨抓取存活——page 复用携带状态；fiber 化后 page 生命周期变化改变此前提 | website.ts:635-670 | page 生命周期显式化，拦截器随 page effect 注册/回收 | BR-07 |
| I2 | X 的 operation capture buffer 必须 drain，否则监听器常驻 | x.ts:107-150 | 同上 | BR-07 |
| I3 | cookie seed 每 Browser 一次；重建必须重 seed（审计 9.3-1 修复版语义钉住） | spider-manager.ts:1608-1623 | 钉住 | BR-02 |
| I4 | 移动端强制 host 清单 | spider-manager.ts:64-77 | 保留 | BR-05 |
| I5 | cookie 字符串按域过滤（审计 9.3-2 修复钉住） | browser-session-pool / spider-manager | 钉住 | BR-06 |

## J. Cordis 新系统自身的坑

| # | 坑 | 对策 | 测试 |
|---|---|---|---|
| J1 | 常驻 provider（db/browser-pool/napcat）一旦重载=全局级联 | infra provider 无配置化（永不需重载），或 broker 吸收 | LC-10, FI-01 |
| J2 | target 卸载等 in-flight send（QQ 15s 超时）→ guard 等待必须有上限 | 超时强卸+污点标记+告警（对应论文缺口③） | LC-05 |
| J3 | 逆函数抛错未建模（论文缺口②） | dispose 逐逆 try/catch 继续+污点记录 | LC-04 |
| J4 | 健康 coeffect 必须单向（观察→停用），send 路径不得反向依赖健康写入者，否则成环 | 架构审查规则 | LC-09 |
| J5 | fiber-per-handle 数百 fiber：notify O(fibers) 无碍，但每 fiber 的 cache 定时器必须统一回收 | 资源探针 | LC-01 |
| J6 | 影子运行双系统共用 DB 会互相 claim 同一 outbound key | 影子用 capture 模式+独立 DB | SH-02 |
| J7 | pipelines→connections 编译只取每 pipeline 第一个 processor | 新系统若支持多处理器链，差异需显式决策 | RG-02 |
| J8 | Bun 下 cordis loader/HMR 兼容未验证 | 验证不过则先弃 HMR | — |
| J9 | TargetHealth.deleteUnknown 在 runtime create 时删未知目标健康行——改名即丢历史 | 新系统改名走迁移而非删除 | RG-10 关联 |
