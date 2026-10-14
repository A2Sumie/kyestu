# 决策记录

## D1：不移植 Google translator（2026-08-16）

 idol-bbq 生产配置未使用 Google translator 模块。kyestu 的 LLM provider 层不移植它，处理器语义统一为无持久会话的 stateless 调用。对应评估报告"未决问题 #1"关闭。

## D2：核心 runtime 自研，不依赖 @cordisjs/core（2026-08-16）

理由：

1. cordis v4 的 loader/HMR 依赖 Node 模块缓存语义，Bun 下未验证；kyestu 宿主是 Bun。
2. 本项目需要的稳定性语义 cordis 未提供：dispose 逐逆容错（taint）、unload guard 超时强卸、代际令牌（ghost-write guard）、资源可观测事件流。自研核心让这些语义成为内建默认值而非外挂。
3. 核心语义由论文完整给出（§3–§5，Table 2 映射），自研规模小（runtime.ts ~400 行；勘误 2026-08-21：现为 519 行，规模结论不变）。
4. 零运行时依赖，供应链面最小。

API 命名对齐论文 Table 2（ctx.effect / ctx.set / ctx.get / ctx.isolate / ctx.use / fiber），未来如需互换可参考 cordis。

## D3：加固范围 = 稳定性，不做安全向加固（2026-08-16）

开源项目，信任边界内组件视为可信代码。不做鉴权/脱敏/沙箱等安全机制。"加固"仅指：逆失败容错、卸载等待超时、代际防护、生命周期状态机的正确性测试覆盖。

## D4：不移植组件清单（2026-08-16，基于当前生产配置分析）

当前生产配置无死组件（3 processor / 6 formatter / 5 target 全在用；唯一无路由 crawler 是 IG Live 抢抓，live_relay 设计上不需要路由）。死组件全部在**代码注册表**层——即用户记忆中的"早期 LLM/翻译组件"：

不按原名移植（kyestu registry 不定义厂商名组件）：

- `GoogleLLMTranslator`（配置零引用；唯一代码引用是 task-manager AggregateDaily 的兜底 provider 名，而当前配置不产生 AggregateDaily 任务）——彻底不移植
- `DeepSeekLLMTranslator`（legacy v1，被 V4Flash/V4Pro 取代）——彻底不移植
- `MechanicalProcessor`（注册但零引用）——彻底不移植
- `OpenaiLikeLLMTranslator` / `Hy3FreeTranslator` / `DeepSeekV4ProTranslator` / `DeepSeekV4FlashTranslator`——厂商名不移植，协议形态由 `processor/openai` 承接（见 D5）
- spider：`website-leap`、`messageboard` **保留**（均为自家服务）

移植：spider 为 x-list、x-timeline、instagram、tiktok、youtube、website-227、website-leap、messageboard；`x-status` 配置虽零引用但被 api-manager 的 x-link 即时动作内部依赖，作为 x 族内部能力保留。

## D5：LLM 组件按协议命名，不按厂商模型命名（2026-08-16）

kyestu 的 processor 组件统一为 `processor/openai`，以 `with.wire_api` 区分协议：

- DeepSeek V4 Flash/Pro（`wire_api: responses` + chat fallback 链）→ `processor/openai`，`wire_api: responses`
- Hy3（OpenAI chat completions 协议）→ `processor/openai`，`wire_api: chat_completions`

生产配置不动，映射只发生在导入器（`PROVIDER_PROTOCOL` + `inferWireApi`：显式 `wire_api` > base_url 含 `/responses` > 默认 chat_completions）。被丢弃 provider（Google/Deepseek v1/Mechanical）的条目与其连接边一并跳过并输出 warning。

## D6：v1.1 聚合层落账（2026-08-16）

聚合/摘要全部落地（DB 持久化窗口 + 阈值 flush + send_first_immediately + digest 合并 + 媒体可见性 + pairing + biliup 视频投稿 + live relay beta）。**摘要卡用与 idol-bbq 同款的 message_pack 模板渲染**（vendored `DefaultCard`，合成 `message_pack` 文章：groups/items/avatars/range 契约一致），仅渲染不可用时回退文本摘要。tag-storm 检测已实现（`pipeline/tag-storm.ts`：阈值+去重作者+检测窗/聚合窗/过期），**按决定不接进发送链路**。cookie 保活 cron 属运维脚本，不进运行时。

> 注记（2026-08-21 回填）：末句"cookie 保活不进运行时"已于同日被 **D10 推翻**——cookie 保活已收编为运行时组件 `app/cookie-keepalive`。本条其余结论（聚合层落账、tag-storm 不接链路）仍有效。

## D7：FC 媒体抑制与博客抓取对齐生产修复（2026-08-16）

与 idol-bbq `6a24a8e` 同步：members-only 文本启发式不作用于 website 平台（公共 blog/news/live-report 合法提及会員限定，只有 `suppress_media_uids` 列出的 FC 区域 + 显式 `members_only` 标记才过滤）；抑制后文字保留、媒体不传，通知带过滤计数。博客详情剥离 `.btnTweet` 分享控件，列表标题选择器收窄为 `.blog-list__title .title`；website 文章外显标题恒用原文首行（博客标题不翻译）。ds4f 的 max_output/ctx 固定 384000/1M，快速响应靠 `reasoning_effort` 调（生产教训：512 上限被 reasoning 吃光导致标题生成 100% 静默回退）。

## D8：Chrome 自动供给（2026-08-16）

浏览器解析链：`PUPPETEER_EXECUTABLE_PATH` → 系统 Chrome（channel）→ 自动下载 Chrome for Testing `142.0.7444.175`（与 idol-bbq Dockerfile 钉版一致）至 `cache/browser/chrome`。新增根级 Dockerfile（oven/bun + 钉版 Chrome deb + ffmpeg + biliup venv，`/app/tools/bin/biliup-python` 等路径与生产布局一致，导入的配置原样可用）。

## D9：live-player relay 切割为独立插件（2026-08-16）

爬虫的 `live_relay` 只保留纯录制（ffmpeg m3u8 归档 + 生命周期事件）；与 tv.n2nj.moe 的同步切割为独立组件 `app/live-player`（`src/components/live-player.ts`）：订阅 bus 的 `live` 频道，按 handle 匹配 targets 后 POST `/api/relay/sync`（Basic auth + WAF bypass header）。bus 从单 article 频道泛化为 `article`/`live` 双频道。

> 注记（2026-08-21）：此后 bus 已新增第三个频道 `session`（会话健康事件，cookie-keepalive 自消费 + 进程日志订阅）。频道实况与完整语义见 docs/bus.md。导入器把 crawler `live_relay.targets` 拆出合并为单个 `live-player` 组件，handle 冲突保留先见并 warning；crawler 侧只留 `enabled`/`archive_root`。

## D10：cookie 保活为运行时插件 app/cookie-keepalive（2026-08-16）

外部运维 cron（tools/youtube-cookie-keepalive.sh）收进架构，作为独立组件 `app/cookie-keepalive`（`src/components/cookie-keepalive.ts`）。两种 job：`ytdlp`（临时副本跑 yt-dlp --simulate，成功后原子轮换 jar 并留 .bak-keepalive，语义与生产脚本一致，失败绝不动旧 jar）和 `browser`（用 browser-pool 保温持久化 session，X/IG/TikTok 通用，降低风控触发）。组件暴露 CookieKeepaliveService（runNow/status），按 job 独立 setInterval（默认 6h），单 job 失败互不影响。导入器自动为带 cookie_file 的 YouTube 爬虫生成 ytdlp job（每个 distinct jar 一条，间隔 6h，与生产 cron 一致）；browser job 走手动配置。

## D11：parity 差异处置（2026-08-16）

详见 docs/parity-gap.md。要点：Mechanical 改名 processor/rules 保留；showroom 抽取的 schedule-webhook 回写确认在用（必做）；cookie-file-path/cookie-policy 不移植，功能并入 cookie-keepalive 升级为 cookie 管理；hy3 熔断+模型能力探测打包进 processor 层；redaction 不做（公共内容无敏），改为 DB 迁移/zstd 压缩工具；x-link-ingest 做但不接发送链路；codex 抛弃，留单次运行 harness 低优先级 todo；crawler-health-audit 暂缓。

## D12：processor/rules + cookie 管理 + LLM 提供商管理（2026-08-16）

parity-gap 1/3/4 落地。Mechanical 改名 `processor/rules`（`pipeline/digest-rules.ts` 纯逻辑 + 组件同名 process 接缝），导入器从 drop 改映射。cookie-keepalive 升级 cookie 管理：expandPath（env/~）、jarStatus()（jar 存在/大小/年龄/sources/保活状态），导入器汇总共享 jar 的来源爬虫。LLM 提供商管理并入 processor/openai：熔断（circuit 配置，4xx 不计数，open 直走 fallback）+ unfreeze + probe 探活 + status；hy3-circuit-breaker 与 model-capability 不单设服务。

## D13：schedule-webhook 回写 + bilibili 恢复对账（2026-08-16）

parity-gap 2/6 落地。schedule-webhook 放在 processor/openai 内部（extract/plan action 成功后自动回写 live-player，context 带 sourceRef/minConfidence 覆盖），crawler 新增 post_processors 运行时解析——生产 15 处爬虫引用 22_7-event-time-extract 不经 connections，导入器零改动。bilibili 对账：marker 文件触发的一次性 reconcile，按 biliup source url 匹配文章补种 outbound sent + forward_by；target/bilibili 组件注册、进程级单次调度（setTimeout(0) 等全部 target 注册完）、多账号各自拉各自 archives 不交叉补种。

## D14：去重审计与媒体内容哈希（2026-08-16）

全链路去重审计结论：L1 文章级（platform+a_id，跨爬虫/未来 x-link-ingest 用原生 a_id 即安全）、L2 forward_by、L3 outbound claim（30min 回收+5 次上限）、聚合窗 ON CONFLICT、QQ claim→send→mark 均正确。修两个洞：media 可见性去重键从 URL 哈希改内容哈希（idol-bbq 同源：content_hash || sourceUrl || path；IG/TT CDN URL 轮换会让同字节图逃逸 URL 键），MediaStore 下载时算 sha256 字节哈希并 contentHashOf 惰性查询；媒体被隐藏且非 skip 模式时补 [图已发过] 提示（生产行为）。formatter RenderedMedia 带 content_hash。

## D15：短视频跨平台去重（召回/判定分离，2026-08-16）

idol-bbq 的 TT/IG 去重根因：签名=timeBucket:durationBucket:sha1(textKey) 三重模糊量精确合取+相似度函数 keys.length 门闸死代码+check-then-mark 竞态。kyestu pipeline/short-video-dedup.ts 从一开始按正确设计：非分桶 per-token 召回键（GLOB 前缀查询 media_hashes）→ 召回后判定（同平台或 IG↔TT 对、7 天窗、LCS≥8/jaccard≥0.45/containment≥0.67）→ claim-before-upload 原子预留。接在 target-bilibili sendVideo 上传前（video_upload.dedup: false 可关）。idol-bbq 侧同思路修复并同步了测试 mock。

## D16：单进程边界裁决（2026-08-21）

kyestu **有意限定为单 Bun 进程**，这不是遗漏而是裁决：Cordis 论文本体即单进程范式（p6 的动机恰是批评容器粒度太粗、无法表达共享地址空间内的依赖），跨进程在论文里只作为 §6.2 service broker 的**应用模式**出现（每进程独立 context + 协调组件经 RPC 桥接）。因此单进程与论文不冲突。

但单进程此前是"没被做过的决定"，代码已长出单主机硬耦合。本条把边界画死，并记录**将来拆进程时必须替换的五层**（按耦合硬度）：

1. **api/ctx.get 活引用 → RPC**：跨 fiber 直调（`NodeHandle.api<T>()`、formatter.render/target.send 直调）传的是活对象闭包；拆进程后必须换成保持接口形状的 RPC（论文 p69）。
2. **bus → 消息中间件**：进程内同步 emitter（无背压/持久化/重放，语义见 docs/bus.md）需换成可跨进程投递的通道。
3. **sqlite + 本地盘 → 共享存储**：data.db（单写）、cache/（media-store、browser userDataDir）、cookie 文件全部绑定本地文件系统。
4. **file:// 段语义 → 可拉取 URL**：target-qq 直接拼 `file://${media.path}` 发给 OneBot，NapCat 必须与 kyestu 同文件系统；拆开后媒体需经 HTTP 可拉取。
5. **进程内 reconcile → 主从协调**：loader 的串行 reconcile（校验先于变更、await 旧 fiber 拆完）前提是单一编排者；多进程需要选主/协调。

**纪律（即时生效）**：新的跨组件接口默认按**异步契约**设计——论文 p69 原话："An interface intended to be exposed across processes must be designed against an asynchronous contract." 现有直调接口不强制改造，但新增接口不得再把同步活引用作为唯一形态。

**升级路径存档**：论文 §6.2 的 broker 模式把负载均衡/滚动更新变成应用级组合模式（provider 注册=可逆效果），是将来真要拆时的既定方向，本条即其锚点。

## D17：领域 coeffect 模型放弃记录（2026-08-21）

可行性报告 §4.2 设计过一套领域 coeffect 词汇表（`health:target:<id>`、`health:handle:*`、`articles:<crawler>`、`llm:<id>` broker）与 P3 阶段的 per-handle child fiber + 健康 coeffect 熔断层。v1 **选择了命令式 pipeline 状态机**（pipeline/cooldown.ts、pipeline/session-health.ts、llm-openai 熔断、router 内存队列），该词汇表未落地。本条补上当时缺席的放弃记录。

**放弃了什么**：

- **撤 key 即熔断的反应式语义**：若 health 是 coeffect，provider 撤掉绑定会让消费者自动去激活并跑自己的逆（notify deactivating），熔断是范式免费送的、per-handle 粒度、可组合的行为；命令式状态机里这是每轮手工 `guard()` 判断。
- **realm 隔离**：健康态不参与 isolate，无法按键空间隔离。
- **reconcile 精确通知**：健康态的值级变化永远不会反应式传播（committed view 只记 provider 身份，论文 p60）。

**换来了什么**：实现直白、与 idol-bbq 生产语义逐条对齐的代价最小（冷却分类 ×2ⁿ、Retry-After、24h 熔断、quarantine 升级链都是生产调参结果，命令式表达最直接）；且 2026-08-21 起这些状态已**写透 service_state 持久化**（CooldownMap / SessionHealthBoard / LLM 熔断 / router 队列 / digest 缓冲，见 pipeline/service-state.ts），"reload 即失忆"这个放弃方案的最大 operational 代价已关闭——fiber 重建与进程重启后风控态存续。

**何时值得重访**：若出现 **per-handle 粒度的反应式熔断**需求（例如希望"某 handle 健康恶化时，依赖它的整棵子树自动停供并恢复"，而不是每个 crawler 每轮自查），届时把对应状态 reify 为 coeffect、撤 key 驱动去激活，才是正路（不是改值——notify 只认身份）。

## D18：组件作者纪律（2026-08-21）

runtime 忠实实现了论文语义，但论文把若干正确性前提显式标为**作者义务**，runtime 不验证。本条把它们成文；详细触点与示例见 docs/components.md。

1. **witness 义务**：每个 effect 的逆必须**真恢复**其正向操作（论文 p56："an obligation on the component author rather than a property the runtime verifies"）。runtime 逐逆容错记 taint，但逆本身做错不会有任何告警——第一个不按纪律写逆的组件会静默污染 taint 语义。
2. **交换性义务**：共享可变状态应尽量 reify 为 coeffect（key 化）；key 的交换性设计是 **provider 的义务**（论文 p27）——注册表式接口（任一次序注册/撤销等价）才安全，顺序敏感的交互必须经 coeffect 声明排序，不得依赖隐含时序。
3. **effect 配对规范**：一切 acquisition（定时器、订阅、子进程、文件句柄、端口监听）必须经 `ctx.effect` 注册并返回配对的逆；组合的逆由 LIFO 自动导出，不为组合另写。
4. **禁止模块级裸状态/裸 setTimeout**：fiber 重载后模块态仍在、不可回收、不参与隔离。现存反例：`pipeline/bilibili-reconcile.ts` 的进程级 `pending` Map + `setTimeout(0)` 一次性调度（:205-224），登记为**已知技术债**（进程级单次的语义很难纤维化成 fiber 效果，暂豁免），新代码不得新增同类。
5. **网络/子进程 acquisition 必须挂逆，或在注释说明豁免理由**：fetch/子进程在 fiber UNLOADING 时不会被自动取消（AbortSignal 只绑超时不绑代际）——要么挂逆，要么在注释里写明为何豁免（参照论文 §6.1：emission 可不追踪，acquisition 必须可追踪）。
6. **realm 撞名风险**：`isolate` 的 realm 是裸字符串，跨 entry 撞名即共享键空间，无 delimiter/own 机制（论文 Alg7 的 managed realms 未实现）。给 realm 起名时按 entry id 加前缀，避免无意共享。

## D19：SnowLuma 适配与 QQ 发送语义重钉（2026-10-14）

背景：3020e 的 QQ→OneBot 桥由老 NapCat 换 SnowLuma（能力目录 `REPORT_snowluma_capabilities_2026-10-14.md`）。
本轮把 kyestu 的 OneBot 触点改造成**双方言自适应**（SnowLuma 高度利用、NapCat 行为兼容），语义细节与
判读/媒体/历史表见 **docs/snowluma.md**。要点：

1. **判读与策略分离**：retcode/status/wording 判读 = 纯函数（`pipeline/onebot-semantics.ts`），
   冷却/重试/重投策略 = `pipeline/cooldown.ts` 的 `QqSendClass` 表。两轴（同载荷重试 vs 稍后重投）分开，
   修配置类（1400/1401/1404/1413/目标失效）永不重投。NapCat `retcode=200/result=120` 拒发语义原样保留
   （不可重试、可重投、30min 冷却）——既有 testset 钉点不推翻，只补 SnowLuma 侧。
2. **D16 第 4 层硬耦合解除（file:// → URL/base64/upload_file_stream）**：媒体来源按决策表自适应，
   未知桥/NapCat 仍走 `file://` 逐字节兼容（兼容优先，强制模式可覆盖）。D16"将来拆进程"清单相应降级一项。
3. **message_id 落库 + message-store**：outbound 记 `provider_message_ids`（免迁移）、
   `get_msg` 回执核对、`delete_msg` 撤回、`app/qq-history-sync` 锚点翻页历史补缺（`qq_messages` 镜像表）。
   **historySync 不回填 bus**：无入站 QQ 消费链路，伪造文章会发明数据源语义（详见 docs/snowluma.md §3）。
4. **QQ 侧健康/熔断 + 失败重投闭环**：`pipeline/qq-health`（FI-01：停机窗口不攒 failed 行、恢复自动继续；
   探针 `get_status`）；router 失败重投（退避 + `max_send_attempts` 有界），**推翻** 旧"target 抛错=丢弃不重试"
   的不对称行为（原为未裁决观察项，TEST-REVIEW §3 建议成文处一并改为裁决）；outbound claim 细化
   （`failed` 即时回收受 5 次上限、`partial` 终态防重复可见内容、`sending` 30min stale 窗）。
5. **不引 `@snowluma/sdk`/`@snowluma/mcp`**（内部能力层 + `get_version_info` 方言探测）；quick operation、
   新 notice 事件、notifications webhook 需要入站事件通道，kyestu 只发不收，明确不做（P2 另议）。
6. 运维显式 API：`/api/qq/recall`、`/api/qq/receipts`、`/api/qq/health` + 签名媒体路由 `/media/<name>?exp&sig`。

## D20：QQ 入站事件通道与反应积木（2026-10-14）

背景：用户澄清"高度支持 SnowLuma"的口径 = **能反向监控 QQ 群内消息并做出反应**。D19-5 的 P2 不做项
（quick operation / 新 notice / notifications webhook）全部卡在"只发不收"，本条补齐入站通道。
语义规范：**docs/snowluma.md §9**。要点：

1. **独立 `app/qq-ingress` 组件（自有 HTTP webhook 端点），不挂 `app/api` 控制面**：`app/api` 是
   daybreak 2026-10-08 fail-closed Bearer 控制面（`tests/api-guard.test.ts` 钉"每路由 Bearer"），
   把 HMAC 签名的 webhook 路由塞进去会为它开鉴权例外、侵蚀该裁决；独立端点自带 HMAC `X-Signature` +
   Bearer 双鉴权、secret 缺失拒启，且**默认关闭**（不配条目即无监听）。
2. **bus 新增 `qq` 频道**（按 bus.md 纪律改 `BusEventMap` 本体）：载荷是归一化事件**本体** + 账本键
   （QQ 消息无"正文回库重取"的外键语义），兜底语义见 docs/bus.md「qq 段」。
3. **historySync 补缺 → `recovered` 重放，修订 D19-3 的前提**：D19-3"historySync 不回填 bus"的理由是
   "无入站消费方、伪造文章会发明数据源语义"。入站通道落地后前提消失，但**形态仍不是回填文章**——
   补缺的历史消息由 ingress 以 `recovered: true` 入站事件重放进反应链路（`qq_messages` 为事实源、
   `qq_inbound_events` 为已处理账本），不伪造 platform/a_id/路由。
4. **反应走既有发送链路**：`SendInput` 增可选 `dest`（事件所在群/好友作为目的地）与 `reply`（引用段），
   `reply/forward/command` 动作经 `target/qq` 的 `send` 契约发送——健康闸、outbound claim、冷却表、
   媒体决策全部复用（注意：digest/summary 配置的 target 会把反应消息聚合，告警目标建议用独立 target 条目）。
5. **可靠性口径**：入站事件至少一次（账本唯一键幂等 + 历史回补）；反应执行至少一次到 claim 幂等为止
   （键含 rule/action/dest，重放不双发；崩溃中途由 stale `dispatching` 重派发，同 outbound `sending`
   stale 窗手法）；handler 持续失败 = 终态 `error` 可见**不自动重试**（防失败风暴）。
6. **显式决定**：配额（每群每规则 cooldown/limit）为**内存态**，fiber 重建/重启即重置——防抖非性计费，
   不值得 service_state 写放大约束（与 F3 同类问题的显式决定）；quick operation 以 webhook 响应体交付
   （OneBot 快捷操作契约），每事件首个生效；自身消息/`message_sent` 回显默认不反应（防死循环）。

## D21：B 站标题链路同步 idol-bbq 译题整改（2026-10-14）

背景：idol-bbq 侧完成 B 站标题整改（`d56c0d2`、`WORK_REPORT_bili-titlegen_2026-10-14.md`）：用户不满
生成式标题质量，口径改为**B 站主标题 = 原标题的忠实中文翻译**。本条把同语义落到 kyestu 的
`pipeline/bili-title.ts` + `pipeline/biliup.ts` + `target/bilibili`（原为极简确定性模板，parity-gap
"待部署实测"里的"biliup LLM 标题/标签生成"此前从未实现）。语义规范见 **docs/bili-title.md**。要点：

1. **任务判定**：youtube（带创作者原标题）→ `translate_original_title`，`original_title`（content 首行）
   是唯一翻译素材、产出逐字采用；X/IG/TT → `summarize_post_title` 忠实概括；website 作者手写标题
   永不进 LLM。译题模式忠实不剥上下文，概括模式剥模型回显的账号名/日期。
2. **模板统一去 `[来源]` 段**：默认 `【{account_title}】{upload_summary}`（品牌前缀+`MM.DD_YY` 日期码
   保留；账号识别不到退化 `【22/7】`）。自定义模板仍可用 `{source_tag}`。原标题照旧进简介 `原标题:` 行
   （首部固定、正文去重）。
3. **确定性后处理对 LLM 输出与确定性标题同时生效**：平台词清洗、emoji 收敛、≤80 字（码点）语义安全
   截断（`…`、不切半个词）；合格性校验=无汉字拒收/假名绝对多数拒收/标题党禁词拒收（旧"见假名即拒"会
   误杀保留日文专名的合法译文——译名表政策让「命の続き」等保留日文）。兜底链：LLM 译题 → 译文首行 →
   原标题原文 → 日期壳 → 硬壳。
4. **译名一致**：65 条 22/7 日→中译名表以事实形态落 `assets/knowledge/22_7/translation_terms_22_7_ja_zh.json`
   （自 idol-bbq 只取译名，不搬知识刷新流程），随译题 prompt 下发。
5. **组件形态**：纯逻辑进 `pipeline/bili-title.ts`（D18 纪律：无模块级可变状态、无裸 setTimeout）；
   LLM 接缝由 `target/bilibili` 按 `video_upload.title_generation` 注入，复用 `processor/openai` 的
   `OpenAiProcessorClient`（重试/熔断/fallback），熔断态走 service_state `llm-circuit:<entry>:title`。
   **缺省=关**（显式配置启用）——与 idol-bbq"未配置默认开、复用 tag_generation 凭据"的有意差异：
   kyestu 无 LLM 标签链路、无凭据可复用，缺配置即确定性模板。
6. **LLM 标签生成不移植**（遗留项）：kyestu 标签仍是静态 `video_upload.tags`；导入器对 idol-bbq 的
   `tag_generation` 告警跳过。厂商 provider 名只在导入器映射（D5）：`title_generation.provider` →
   OpenAI 兼容端点默认值；`metadata_templates.*` → `title_template`/`desc_template`（`{{key}}`→`{key}`）。

## D22：B 站标题来源标记条件化（2026-10-14）

背景：D21/D18 把 `[来源]` 从标题整体去掉后，用户反馈"来源有些情况还得有"——概括出来的标题
（X/IG/TT、Shorts、无原标题条目、日期壳兜底）没有出处辨识度，需要来源标记；只有"标题=原标题译文"
的 YouTube 长视频能自证出处。idol-bbq 侧同步落地（`73c722a`），本条把同语义落 kyestu 并钉对照用例。
语义规范见 **docs/bili-title.md §来源标记条件化**。要点：

1. **条件口径（两仓库逐字一致）**：保留 `[X]/[ins]/[TT]`（概括标题）、`[YT]`（Shorts / 无原标题 YouTube /
   日期壳兜底，含 YouTube 长视频退化到日期壳时）、`[blog]`/`[社媒]`（website 及其它不在省略清单）；
   **仅** YouTube 长视频（type≠shorts）且 content 首行有原标题且 headline 非空时省略——此时标题=
   原标题译文，标题本身自证出处。
2. **实现=模板条件槽位**：默认模板加回 `[{source_tag}]`（`DEFAULT_TITLE_TEMPLATE`）；`resolveTitleSourceTag`
   （导出，测试直接钉）把槽位渲染为裸标签或空串；`stripEmptyRenderedBrackets` 让空槽连同一个后随半角
   空格一起消失——省略态与无槽位模板逐字一致、保留态=旧格式 `【acc】[TT] 08.16_26 …`。`buildTitleFallback`
   （兜底壳）走同一条件；LLM 输入 `source_context.source_tag` 仍是**真实来源标签**（来源元数据，
   不受槽位条件化影响，与 idol-bbq 一致）。
3. **与 idol-bbq 的差异**：无行为差异。仅两处无关行为的实现差异：占位符语法（kyestu `{key}` /
   idol-bbq `{{key}}`，D21 既有）；`type` 判 shorts 用 `toLowerCase()` 防御大小写（idol-bbq 枚举精确比较）。
   blog/其它来源保留来源标记是两仓库共同取舍（用户口径的省略清单只列了 YouTube 长视频译题）。
4. **测试钉**：`tests/bili-title.test.ts` 模板快照对照用例（译题省略 vs 概括/Shorts/无原标题/日期壳保留）
   + `resolveTitleSourceTag` 单元钉；`tests/v11.test.ts` 上传端到端标题快照同步（TT 带 `[TT]`）。
