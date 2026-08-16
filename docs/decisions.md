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

不移植（kyestu registry 不定义）：

- `GoogleLLMTranslator`（配置零引用；唯一代码引用是 task-manager AggregateDaily 的兜底 provider 名，而当前配置不产生 AggregateDaily 任务）
- `DeepSeekLLMTranslator`（legacy v1，被 V4Flash/V4Pro 取代）
- `OpenaiLikeLLMTranslator`
- `Hy3FreeTranslator`（8 月实验期用过，已回退 V4Flash；其熔断器语义由 kyestu 的 broker 健康态泛化承接）
- `DeepSeekV4ProTranslator`（仅作为 Hy3Free 内嵌 fallback 存在，Hy3 不移植则它无对象）
- `MechanicalProcessor`（注册但零引用）
- spider：`website-leap`（leap-projects.jp，另一企划）、`messageboard`（需专用开关，未启用）

移植：processor 仅 `deepseek-v4-flash`（含 fallback 链语义）；spider 为 x-list、x-timeline、instagram、tiktok、youtube、website-227；`x-status` 配置虽零引用但被 api-manager 的 x-link 即时动作内部依赖，作为 x 族内部能力保留。
