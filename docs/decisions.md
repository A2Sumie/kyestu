# 决策记录

## D1：不移植 Google translator（2026-08-16）

 idol-bbq 生产配置未使用 Google translator 模块。kyestu 的 LLM provider 层不移植它，处理器语义统一为无持久会话的 stateless 调用。对应评估报告"未决问题 #1"关闭。

## D2：核心 runtime 自研，不依赖 @cordisjs/core（2026-08-16）

理由：

1. cordis v4 的 loader/HMR 依赖 Node 模块缓存语义，Bun 下未验证；kyestu 宿主是 Bun。
2. 本项目需要的稳定性语义 cordis 未提供：dispose 逐逆容错（taint）、unload guard 超时强卸、代际令牌（ghost-write guard）、资源可观测事件流。自研核心让这些语义成为内建默认值而非外挂。
3. 核心语义由论文完整给出（§3–§5，Table 2 映射），自研规模小（runtime.ts ~400 行）。
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

## D7：FC 媒体抑制与博客抓取对齐生产修复（2026-08-16）

与 idol-bbq `6a24a8e` 同步：members-only 文本启发式不作用于 website 平台（公共 blog/news/live-report 合法提及会員限定，只有 `suppress_media_uids` 列出的 FC 区域 + 显式 `members_only` 标记才过滤）；抑制后文字保留、媒体不传，通知带过滤计数。博客详情剥离 `.btnTweet` 分享控件，列表标题选择器收窄为 `.blog-list__title .title`；website 文章外显标题恒用原文首行（博客标题不翻译）。ds4f 的 max_output/ctx 固定 384000/1M，快速响应靠 `reasoning_effort` 调（生产教训：512 上限被 reasoning 吃光导致标题生成 100% 静默回退）。

## D8：Chrome 自动供给（2026-08-16）

浏览器解析链：`PUPPETEER_EXECUTABLE_PATH` → 系统 Chrome（channel）→ 自动下载 Chrome for Testing `142.0.7444.175`（与 idol-bbq Dockerfile 钉版一致）至 `cache/browser/chrome`。新增根级 Dockerfile（oven/bun + 钉版 Chrome deb + ffmpeg + biliup venv，`/app/tools/bin/biliup-python` 等路径与生产布局一致，导入的配置原样可用）。
